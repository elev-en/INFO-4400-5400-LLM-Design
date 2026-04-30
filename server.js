import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { sql, initDb } from "./db.js";

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE = "https://api.groq.com/openai/v1";
const CHAT_MODEL = "llama-3.3-70b-versatile";
const TRANSCRIPTION_MODEL = "whisper-large-v3";
const AUDIO_DIR = join(process.cwd(), "data", "audio");
const openingQuestion = "How is your morning going so far?";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webm": "audio/webm",
  ".wav": "audio/wav"
};

const systemPrompt = `
You are Morning Mirror, a warm voice-first check-in agent conducting a daily morning reflection.
Your primary job is to surface the emotions underneath what the user is describing and connect those emotions to the specific events or circumstances causing them.

Rules:
- ALWAYS begin your reply by briefly acknowledging or reflecting back something specific the user just said — never give a generic response.
- If the user shares stress, tiredness, or difficulty, lead with empathy before anything else.
- Ask exactly ONE follow-up question per turn, prioritized in this order:
  1. If the user names an emotion (stressed, excited, anxious, relieved, etc.), ask about the specific event or situation driving that feeling — dig into the "what happened" or "what's coming up" behind it.
  2. If the user describes an event or situation without naming a feeling, ask how that made them feel or is making them feel.
  3. Only if emotions and their causes are already well-explored, ask about morning routine specifics (sleep, movement, plans).
- Never move on from an emotion until you understand what event or circumstance it is tied to.
- Keep the entire reply under 120 words.
- Sound warm, conversational, and grounded — like a thoughtful friend, not a therapist.
- Never ask more than one question per turn.
`.trim();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET") {
      const audioMatch = url.pathname.match(/^\/api\/audio\/(\d+)$/);
      if (audioMatch) {
        await handleAudioDownload(audioMatch[1], res);
        return;
      }
      await serveStatic(url.pathname, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      await handleRegister(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      await handleSession(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/start") {
      await handleSessionStart(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/evening") {
      await handleEvening(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

await initDb();
console.log("[db] tables ready");
await mkdir(AUDIO_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`Morning check-in app running at http://localhost:${PORT}`);
});

// ─── Static files ─────────────────────────────────────────────
async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = normalize(safePath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const filePath = join(process.cwd(), "public", normalizedPath);
  const extension = extname(filePath).toLowerCase();

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

// ─── Audio download ───────────────────────────────────────────
async function handleAudioDownload(turnId, res) {
  const [turn] = await sql`
    SELECT audio_data, mime_type, audio_file FROM turns WHERE id = ${turnId}
  `;

  if (!turn) {
    sendJson(res, 404, { error: "Turn not found." });
    return;
  }

  if (!turn.audio_data) {
    sendJson(res, 404, { error: "No audio stored for this turn." });
    return;
  }

  const ext = turn.mime_type?.includes("wav") ? "wav" : "webm";
  const filename = turn.audio_file || `turn-${turnId}.${ext}`;
  res.writeHead(200, {
    "Content-Type": turn.mime_type || "audio/webm",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": turn.audio_data.length
  });
  res.end(turn.audio_data);
}

// ─── Chat ─────────────────────────────────────────────────────
async function handleChat(req, res) {
  if (!GROQ_API_KEY) {
    sendJson(res, 500, { error: "Missing GROQ_API_KEY environment variable." });
    return;
  }

  const body = await readJsonBody(req);
  const { audio, mimeType, messages, sessionId, questionText, recordingStartedAt } =
    body ?? {};

  if (!audio || !mimeType || !Array.isArray(messages) || !sessionId) {
    sendJson(res, 400, {
      error: "Expected audio, mimeType, messages, and sessionId in the request body."
    });
    return;
  }

  const [session] = await sql`
    SELECT * FROM sessions WHERE id = ${sessionId}
  `;

  if (!session) {
    sendJson(res, 404, { error: "Unknown sessionId." });
    return;
  }

  const now = new Date();
  const tz = session.client_timezone ?? null;
  const askedAt = session.last_question_asked_at
    ? new Date(session.last_question_asked_at)
    : null;
  const responseLatencyMs = askedAt ? now.getTime() - askedAt.getTime() : null;
  const turnNumber = session.turn_count + 1;
  const promptText = questionText || session.last_question_text || null;

  const audioBuffer = Buffer.from(audio, "base64");
  const savedAudio = await saveAudioFile(sessionId, audioBuffer, mimeType, turnNumber);

  const elapsedMs = now.getTime() - new Date(session.opened_at).getTime();
  const isFinalTurn = turnNumber >= 10 || elapsedMs >= 10 * 60 * 1000;

  try {
    const transcript = await transcribeAudio(audio, mimeType);
    const pastContext = await getPastMorningSummary(session.user_id, sessionId);
    const reply = await generateReply(messages, transcript, isFinalTurn, pastContext);
    const replySentAt = new Date();

    await sql`
      UPDATE sessions SET
        turn_count             = ${turnNumber},
        last_question_asked_at = ${localIso(replySentAt, tz)},
        last_question_text     = ${reply}
      WHERE id = ${sessionId}
    `;

    await sql`
      INSERT INTO turns (
        session_id, user_id, username, day_number, turn_number,
        question_text, question_asked_at,
        response_received_at, response_latency_ms,
        recording_started_at, recording_duration_ms,
        transcript, reply,
        audio_file, audio_bytes, audio_data, mime_type
      ) VALUES (
        ${sessionId}, ${session.user_id}, ${session.username}, ${session.day_number}, ${turnNumber},
        ${promptText}, ${askedAt ? localIso(askedAt, tz) : null},
        ${localIso(now, tz)}, ${responseLatencyMs},
        ${recordingStartedAt ?? null},
        ${recordingStartedAt
          ? now.getTime() - new Date(recordingStartedAt).getTime()
          : null},
        ${transcript}, ${reply},
        ${savedAudio.fileName}, ${savedAudio.byteLength}, ${audioBuffer}, ${mimeType}
      )
    `;

    await logEvent("assistant_question_sent", sessionId, session.user_id, session.username, {
      turnNumber,
      questionText: reply,
      askedAt: localIso(replySentAt, tz),
      sessionComplete: isFinalTurn
    });

    sendJson(res, 200, {
      transcript,
      reply,
      questionAskedAt: replySentAt.toISOString(),
      audioFile: savedAudio.fileName,
      responseLatencyMs,
      sessionComplete: isFinalTurn
    });
  } catch (error) {
    await sql`
      INSERT INTO turns (
        session_id, user_id, username, day_number, turn_number,
        question_text, question_asked_at,
        response_received_at, response_latency_ms,
        recording_started_at,
        audio_file, audio_bytes, audio_data, mime_type,
        failed, error_message
      ) VALUES (
        ${sessionId}, ${session.user_id}, ${session.username}, ${session.day_number}, ${turnNumber},
        ${promptText}, ${askedAt?.toISOString() ?? null},
        ${now.toISOString()}, ${responseLatencyMs},
        ${recordingStartedAt ?? null},
        ${savedAudio.fileName}, ${savedAudio.byteLength}, ${audioBuffer}, ${mimeType},
        TRUE, ${error.message}
      )
    `;
    throw error;
  }
}

// ─── Register ─────────────────────────────────────────────────
async function handleRegister(req, res) {
  console.log("[register] called");
  const body = await readJsonBody(req);
  const username = normalizeUsername(body?.username);
  const password = body?.password;

  if (!username || !password) {
    sendJson(res, 400, { error: "Username and password are required." });
    return;
  }

  const [existing] = await sql`
    SELECT id FROM users WHERE username = ${username}
  `;

  if (existing) {
    sendJson(res, 409, { error: "That username is already taken." });
    return;
  }

  const user = buildUser(username, password.toLowerCase());

  await sql`
    INSERT INTO users (id, username, password_hash, password_salt, created_at)
    VALUES (${user.id}, ${user.username}, ${user.passwordHash}, ${user.passwordSalt}, ${user.createdAt})
  `;

  await logEvent("user_registered", null, user.id, user.username, {});

  sendJson(res, 200, { user: { id: user.id, username: user.username }, dayNumber: 1 });
}

// ─── Login ────────────────────────────────────────────────────
async function handleLogin(req, res) {
  console.log("[login] called");
  const body = await readJsonBody(req);
  const username = normalizeUsername(body?.username);
  const password = body?.password;

  if (!username || !password) {
    sendJson(res, 400, { error: "Username and password are required." });
    return;
  }

  const [user] = await sql`
    SELECT * FROM users WHERE username = ${username}
  `;

  const passwordOk =
    verifyPassword(password.toLowerCase(), user.password_hash, user.password_salt) ||
    verifyPassword(password,               user.password_hash, user.password_salt) ||
    verifyPassword(password.toUpperCase(), user.password_hash, user.password_salt);

  if (!user || !passwordOk) {
    sendJson(res, 401, { error: "Invalid username or password." });
    return;
  }

  await logEvent("user_logged_in", null, user.id, user.username, {});

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = ${user.id}
  `;

  // Check if user already has a session from today with at least one completed turn
  const [todaySession] = await sql`
    SELECT id, day_number, opened_at, turn_count
    FROM sessions
    WHERE user_id = ${user.id}
      AND opened_at::date = CURRENT_DATE
    ORDER BY opened_at DESC
    LIMIT 1
  `;

  const morningDoneToday = !!(todaySession && todaySession.turn_count > 0);

  // Single check: any evening check-in submitted in the last 10 hours covers the full 9pm–7am window
  const [recentEv] = await sql`
    SELECT id FROM evening_checkins
    WHERE user_id = ${user.id}
      AND submitted_at >= NOW() - INTERVAL '10 hours'
    ORDER BY submitted_at DESC
    LIMIT 1
  `;
  const recentEveningDone = !!recentEv;

  // Check for yesterday's session with a pending evening check-in (overnight 9pm–7am window)
  let pendingEveningSessionId = null;
  let pendingEveningOpenedAt  = null;
  const [yesterdaySession] = await sql`
    SELECT id, opened_at FROM sessions
    WHERE user_id = ${user.id}
      AND opened_at::date = CURRENT_DATE - INTERVAL '1 day'
    ORDER BY opened_at DESC
    LIMIT 1
  `;
  if (yesterdaySession && !recentEveningDone) {
    pendingEveningSessionId = yesterdaySession.id;
    pendingEveningOpenedAt  = yesterdaySession.opened_at;
  }

  sendJson(res, 200, {
    user: { id: user.id, username: user.username },
    dayNumber: count + 1,
    morningDoneToday,
    recentEveningDone,
    todaySessionId:          morningDoneToday ? todaySession.id        : null,
    todayDayNumber:          morningDoneToday ? todaySession.day_number : null,
    todayOpenedAt:           morningDoneToday ? todaySession.opened_at  : null,
    pendingEveningSessionId,
    pendingEveningOpenedAt,
    hadSessionYesterday:     !!yesterdaySession
  });
}

// ─── Create session ───────────────────────────────────────────
async function handleSession(req, res) {
  const body = await readJsonBody(req);
  const userId = body?.userId;
  const username = normalizeUsername(body?.username);

  if (!userId || !username) {
    sendJson(res, 400, { error: "Authenticated user information is required." });
    return;
  }

  const sessionId = randomUUID();
  const clientTz = body?.timezone ?? null;
  const openedAt = localIso(new Date(), clientTz);

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = ${userId}
  `;
  const dayNumber = count + 1;

  await sql`
    INSERT INTO sessions (id, user_id, username, user_agent, opened_at, day_number, client_timezone)
    VALUES (
      ${sessionId}, ${userId}, ${username},
      ${body?.userAgent ?? null}, ${openedAt}, ${dayNumber}, ${clientTz}
    )
  `;

  await logEvent("app_opened", sessionId, userId, username, {
    openedAt,
    dayNumber,
    userAgent: body?.userAgent ?? null
  });

  sendJson(res, 200, { sessionId, dayNumber });
}

// ─── Evening check-in ─────────────────────────────────────────
async function handleEvening(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, userId, username: rawUsername, emoji, intensity, reflection } = body ?? {};

  if (!emoji || intensity == null) {
    sendJson(res, 400, { error: "emoji and intensity are required." });
    return;
  }

  let resolvedSessionId = sessionId ?? null;
  let resolvedUserId    = userId ?? null;
  let resolvedUsername  = normalizeUsername(rawUsername) || null;
  let resolvedDayNumber = null;

  if (sessionId) {
    const [session] = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
    if (!session) {
      sendJson(res, 404, { error: "Unknown sessionId." });
      return;
    }
    resolvedUserId   = session.user_id;
    resolvedUsername = session.username;
    resolvedDayNumber = session.day_number;
  } else if (userId) {
    // No morning session — look up today's day number from session count
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = ${userId}
    `;
    resolvedDayNumber = count > 0 ? count : 1;
  } else {
    sendJson(res, 400, { error: "Either sessionId or userId is required." });
    return;
  }

  await sql`
    INSERT INTO evening_checkins
      (session_id, user_id, username, day_number, emoji, intensity, reflection)
    VALUES
      (${resolvedSessionId}, ${resolvedUserId}, ${resolvedUsername},
       ${resolvedDayNumber}, ${emoji}, ${intensity}, ${reflection ?? null})
  `;

  await logEvent("evening_checkin_submitted", resolvedSessionId, resolvedUserId, resolvedUsername, {
    emoji, intensity, reflection: reflection ?? null
  });

  sendJson(res, 200, { ok: true });
}

// ─── Start session (opening question) ────────────────────────
async function handleSessionStart(req, res) {
  const body = await readJsonBody(req);
  const { sessionId } = body ?? {};

  const [session] = await sql`
    SELECT * FROM sessions WHERE id = ${sessionId}
  `;

  if (!session) {
    sendJson(res, 404, { error: "Unknown sessionId." });
    return;
  }

  if (session.last_question_asked_at) {
    sendJson(res, 200, {
      openingQuestion: session.last_question_text,
      questionAskedAt: session.last_question_asked_at
    });
    return;
  }

  const askedAt = localIso(new Date(), session.client_timezone ?? null);

  const pastContext = await getPastMorningSummary(session.user_id, sessionId);
  let chosenQuestion = openingQuestion;
  if (pastContext) {
    console.log("[session/start] past context found:\n", pastContext);
    const personalized = await generateOpeningQuestion(pastContext);
    console.log("[session/start] personalized question:", personalized);
    if (personalized) chosenQuestion = personalized;
  } else {
    console.log("[session/start] no past data — using default opening question");
  }

  await sql`
    UPDATE sessions SET
      last_question_asked_at = ${askedAt},
      last_question_text     = ${chosenQuestion}
    WHERE id = ${sessionId}
  `;

  await logEvent("assistant_question_sent", sessionId, session.user_id, session.username, {
    turnNumber: 0,
    questionText: chosenQuestion,
    askedAt
  });

  sendJson(res, 200, { openingQuestion: chosenQuestion, questionAskedAt: askedAt });
}

// ─── Groq helpers ────────────────────────────────────────────
async function transcribeAudio(base64Audio, mimeType) {
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  const audioBuffer = Buffer.from(base64Audio, "base64");

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), `audio.${extension}`);
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", "text");

  const response = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form
  });

  if (!response.ok) {
    throw new Error(`Transcription failed: ${await response.text()}`);
  }

  return (await response.text()).trim();
}

// ─── Past morning context ─────────────────────────────────────
async function getPastMorningSummary(userId, currentSessionId) {
  const pastTurns = await sql`
    SELECT s.day_number, t.turn_number, t.transcript
    FROM turns t
    JOIN sessions s ON t.session_id = s.id
    WHERE t.user_id = ${userId}
      AND t.session_id != ${currentSessionId}
      AND t.transcript IS NOT NULL
      AND t.transcript != ''
      AND t.failed = false
    ORDER BY s.day_number DESC, t.turn_number ASC
    LIMIT 30
  `;

  if (pastTurns.length === 0) return null;

  const byDay = {};
  for (const turn of pastTurns) {
    const day = turn.day_number ?? "?";
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(turn.transcript);
  }

  const lines = Object.entries(byDay)
    .sort(([a], [b]) => Number(b) - Number(a))
    .slice(0, 5)
    .map(([day, transcripts]) => `Day ${day}: ${transcripts.join(" | ")}`);

  return lines.join("\n");
}

async function generateOpeningQuestion(pastContext) {
  const prompt = `You are Morning Mirror, a warm voice-first check-in agent. Based on what this participant shared in their previous morning check-ins, write a single warm, personalized opening question for today's session.

Past morning responses:
${pastContext}

Rules:
- Focus on an emotion the participant expressed before (stress, anxiety, relief, excitement, tiredness, etc.) and the event or situation tied to it — ask how they're feeling about it now
- If there was an unresolved stressor or upcoming event mentioned, follow up on that specifically
- Keep it under 25 words
- Sound warm and conversational, like a thoughtful friend who remembers
- End with a question mark
- Only output the question itself, nothing else`;

  const response = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      max_tokens: 64
    })
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function generateReply(messages, transcript, isFinalTurn = false, pastContext = null) {
  let effectivePrompt = isFinalTurn
    ? systemPrompt + "\n\nThis is the final turn of the session. Do NOT ask a follow-up question. Instead, warmly wrap up the conversation in 1-2 sentences, thanking them for sharing and wishing them a good morning."
    : systemPrompt;

  if (pastContext) {
    effectivePrompt += `\n\nCONTEXT FROM THIS PARTICIPANT'S PAST MORNING CHECK-INS:\n${pastContext}\n\nUse this context to track emotional continuity across days. Pay attention to recurring emotions (e.g., ongoing stress, anxiety, excitement) and the events tied to them. If a past stressor or situation is unresolved, gently follow up on how it's evolved. If the participant mentioned something emotionally significant before, check in on it — don't treat each morning as a blank slate.`;
  }

  const chatMessages = [
    { role: "system", content: effectivePrompt },
    ...messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    { role: "user", content: transcript }
  ];

  const response = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: chatMessages,
      temperature: 0.8,
      max_tokens: 256
    })
  });

  if (!response.ok) {
    throw new Error(`Chat completion failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ─── Utilities ────────────────────────────────────────────────
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : null);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function saveAudioFile(sessionId, audioBuffer, mimeType, turnNumber) {
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  const fileName = `${sessionId}-turn-${String(turnNumber).padStart(2, "0")}.${extension}`;
  const filePath = join(AUDIO_DIR, fileName);
  await writeFile(filePath, audioBuffer);
  return { fileName, filePath, byteLength: audioBuffer.byteLength };
}

async function logEvent(type, sessionId, userId, username, payload) {
  await sql`
    INSERT INTO events (type, session_id, user_id, username, payload)
    VALUES (
      ${type},
      ${sessionId ?? null},
      ${userId ?? null},
      ${username ?? null},
      ${sql.json(payload)}
    )
  `;
}

function localIso(date, timezone) {
  if (!timezone) return date.toISOString();
  try {
    // Format as "YYYY-MM-DDTHH:mm:ss" in the given timezone, then append offset
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    }).formatToParts(date);
    const get = (type) => parts.find(p => p.type === type)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return date.toISOString();
  }
}

function normalizeUsername(username) {
  if (typeof username !== "string") return "";
  return username.trim().toLowerCase();
}

function buildUser(username, password) {
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  return {
    id: randomUUID(),
    username,
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: new Date().toISOString()
  };
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password, passwordHash, passwordSalt) {
  const incoming = Buffer.from(hashPassword(password, passwordSalt), "hex");
  const stored   = Buffer.from(passwordHash, "hex");
  return timingSafeEqual(incoming, stored);
}
