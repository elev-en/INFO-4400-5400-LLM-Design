import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { sql, initDb } from "./db.js";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";
const TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
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

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

await initDb();
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
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Missing OPENAI_API_KEY environment variable." });
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
  const savedAudio = await saveAudioFile(sessionId, audio, mimeType, turnNumber);

  try {
    const transcript = await transcribeAudio(audio, mimeType);
    const reply = await generateReply(messages, transcript);
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
        audio_file, audio_bytes, mime_type
      ) VALUES (
        ${sessionId}, ${session.user_id}, ${session.username}, ${turnNumber},
        ${promptText}, ${askedAt?.toISOString() ?? null},
        ${now.toISOString()}, ${responseLatencyMs},
        ${recordingStartedAt ?? null},
        ${recordingStartedAt
          ? now.getTime() - new Date(recordingStartedAt).getTime()
          : null},
        ${transcript}, ${reply},
        ${savedAudio.fileName}, ${savedAudio.byteLength}, ${mimeType}
      )
    `;

    await logEvent("assistant_question_sent", sessionId, session.user_id, session.username, {
      turnNumber,
      questionText: reply,
      askedAt: replySentAt.toISOString()
    });

    sendJson(res, 200, {
      transcript,
      reply,
      questionAskedAt: replySentAt.toISOString(),
      audioFile: savedAudio.fileName,
      responseLatencyMs
    });
  } catch (error) {
    await sql`
      INSERT INTO turns (
        session_id, user_id, username, turn_number,
        question_text, question_asked_at,
        response_received_at, response_latency_ms,
        recording_started_at,
        audio_file, audio_bytes, mime_type,
        failed, error_message
      ) VALUES (
        ${sessionId}, ${session.user_id}, ${session.username}, ${turnNumber},
        ${promptText}, ${askedAt?.toISOString() ?? null},
        ${now.toISOString()}, ${responseLatencyMs},
        ${recordingStartedAt ?? null},
        ${savedAudio.fileName}, ${savedAudio.byteLength}, ${mimeType},
        TRUE, ${error.message}
      )
    `;
    throw error;
  }
}

// ─── Register ─────────────────────────────────────────────────
async function handleRegister(req, res) {
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

  const user = buildUser(username, password);

  await sql`
    INSERT INTO users (id, username, password_hash, password_salt, created_at)
    VALUES (${user.id}, ${user.username}, ${user.passwordHash}, ${user.passwordSalt}, ${user.createdAt})
  `;

  await logEvent("user_registered", null, user.id, user.username, {});

  sendJson(res, 200, { user: { id: user.id, username: user.username } });
}

// ─── Login ────────────────────────────────────────────────────
async function handleLogin(req, res) {
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

  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    sendJson(res, 401, { error: "Invalid username or password." });
    return;
  }

  await logEvent("user_logged_in", null, user.id, user.username, {});

  sendJson(res, 200, { user: { id: user.id, username: user.username } });
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

  await sql`
    INSERT INTO sessions (id, user_id, username, user_agent, opened_at)
    VALUES (
      ${sessionId}, ${userId}, ${username},
      ${body?.userAgent ?? null}, ${openedAt}
    )
  `;

  await logEvent("app_opened", sessionId, userId, username, {
    openedAt,
    userAgent: body?.userAgent ?? null
  });

  sendJson(res, 200, { sessionId });
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

// ─── OpenAI helpers ───────────────────────────────────────────
async function transcribeAudio(base64Audio, mimeType) {
  const bytes = Buffer.from(base64Audio, "base64");
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: mimeType }),
    `recording.${extension}`
  );
  form.append("model", TRANSCRIPTION_MODEL);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });

  if (!response.ok) {
    throw new Error(`Transcription failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.text?.trim() || "";
}

async function generateReply(messages, transcript) {
  const conversation = [
    { role: "system", content: systemPrompt },
    ...messages,
    { role: "user", content: transcript }
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: MODEL, temperature: 0.8, messages: conversation })
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

async function saveAudioFile(sessionId, base64Audio, mimeType, turnNumber) {
  const bytes = Buffer.from(base64Audio, "base64");
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  const fileName = `${sessionId}-turn-${String(turnNumber).padStart(2, "0")}.${extension}`;
  const filePath = join(AUDIO_DIR, fileName);
  await writeFile(filePath, bytes);
  return { fileName, filePath, byteLength: bytes.byteLength };
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
