import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { sql, initDb } from "./db.js";

const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const MODEL = process.env.GOOGLE_CHAT_MODEL || "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
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
You are Morning Mirror, a warm voice-first check-in agent.
Your job is to ask users about how their morning is going and respond to what they share.
Rules:
- Keep replies under 120 words.
- Sound conversational and grounded.
- Ask exactly one follow-up question each turn unless the user says they are done.
- If the user shares stress, tiredness, or difficulty, respond with empathy before asking the follow-up.
- Focus on their morning routine, mood, energy, plans, or anything that happened after waking up.
`.trim();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET") {
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
    sendJson(res, 500, { error: "Internal server error" });
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

// ─── Chat ─────────────────────────────────────────────────────
async function handleChat(req, res) {
  if (!GOOGLE_API_KEY) {
    sendJson(res, 500, { error: "Missing GOOGLE_API_KEY environment variable." });
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
    const reply = await generateReply(messages, transcript, isFinalTurn);
    const replySentAt = new Date();

    await sql`
      UPDATE sessions SET
        turn_count             = ${turnNumber},
        last_question_asked_at = ${replySentAt},
        last_question_text     = ${reply}
      WHERE id = ${sessionId}
    `;

    await sql`
      INSERT INTO turns (
        session_id, user_id, username, turn_number,
        question_text, question_asked_at,
        response_received_at, response_latency_ms,
        recording_started_at, recording_duration_ms,
        transcript, reply,
        audio_file, audio_bytes, audio_data, mime_type
      ) VALUES (
        ${sessionId}, ${session.user_id}, ${session.username}, ${turnNumber},
        ${promptText}, ${askedAt?.toISOString() ?? null},
        ${now.toISOString()}, ${responseLatencyMs},
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
      askedAt: replySentAt.toISOString(),
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
        session_id, user_id, username, turn_number,
        question_text, question_asked_at,
        response_received_at, response_latency_ms,
        recording_started_at,
        audio_file, audio_bytes, audio_data, mime_type,
        failed, error_message
      ) VALUES (
        ${sessionId}, ${session.user_id}, ${session.username}, ${turnNumber},
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

  // Check if they already submitted an evening check-in for today's session
  let eveningDoneToday = false;
  if (morningDoneToday) {
    const [ev] = await sql`
      SELECT id FROM evening_checkins WHERE session_id = ${todaySession.id} LIMIT 1
    `;
    eveningDoneToday = !!ev;
  }

  sendJson(res, 200, {
    user: { id: user.id, username: user.username },
    dayNumber: count + 1,
    morningDoneToday,
    eveningDoneToday,
    todaySessionId:  morningDoneToday ? todaySession.id         : null,
    todayDayNumber:  morningDoneToday ? todaySession.day_number  : null,
    todayOpenedAt:   morningDoneToday ? todaySession.opened_at   : null
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
  const openedAt = new Date().toISOString();

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = ${userId}
  `;
  const dayNumber = count + 1;

  await sql`
    INSERT INTO sessions (id, user_id, username, user_agent, opened_at, day_number)
    VALUES (
      ${sessionId}, ${userId}, ${username},
      ${body?.userAgent ?? null}, ${openedAt}, ${dayNumber}
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
  const { sessionId, emoji, intensity, reflection } = body ?? {};

  if (!sessionId || !emoji || intensity == null) {
    sendJson(res, 400, { error: "sessionId, emoji, and intensity are required." });
    return;
  }

  const [session] = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
  if (!session) {
    sendJson(res, 404, { error: "Unknown sessionId." });
    return;
  }

  await sql`
    INSERT INTO evening_checkins
      (session_id, user_id, username, day_number, emoji, intensity, reflection)
    VALUES
      (${sessionId}, ${session.user_id}, ${session.username},
       ${session.day_number}, ${emoji}, ${intensity}, ${reflection ?? null})
  `;

  await logEvent("evening_checkin_submitted", sessionId, session.user_id, session.username, {
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

  const askedAt = new Date().toISOString();

  await sql`
    UPDATE sessions SET
      last_question_asked_at = ${askedAt},
      last_question_text     = ${openingQuestion}
    WHERE id = ${sessionId}
  `;

  await logEvent("assistant_question_sent", sessionId, session.user_id, session.username, {
    turnNumber: 0,
    questionText: openingQuestion,
    askedAt
  });

  sendJson(res, 200, { openingQuestion, questionAskedAt: askedAt });
}

// ─── Gemini helpers ───────────────────────────────────────────
async function transcribeAudio(base64Audio, mimeType) {
  const response = await fetch(
    `${GEMINI_BASE}/${MODEL}:generateContent?key=${GOOGLE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Audio } },
            { text: "Transcribe the audio exactly as spoken. Return only the transcription, no commentary." }
          ]
        }]
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Transcription failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function generateReply(messages, transcript, isFinalTurn = false) {
  const contents = [
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    })),
    { role: "user", parts: [{ text: transcript }] }
  ];

  const effectivePrompt = isFinalTurn
    ? systemPrompt + "\n\nThis is the final turn of the session. Do NOT ask a follow-up question. Instead, warmly wrap up the conversation in 1-2 sentences, thanking them for sharing and wishing them a good morning."
    : systemPrompt;

  const response = await fetch(
    `${GEMINI_BASE}/${MODEL}:generateContent?key=${GOOGLE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: effectivePrompt }] },
        contents,
        generationConfig: { temperature: 0.8 }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Chat completion failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
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
