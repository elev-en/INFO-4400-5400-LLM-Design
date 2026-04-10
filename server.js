import { createServer } from "node:http";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";
const TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const DATA_DIR = join(process.cwd(), "data");
const LOGS_DIR = join(DATA_DIR, "logs");
const AUDIO_DIR = join(DATA_DIR, "audio");
const SESSION_LOG_FILE = join(LOGS_DIR, "session-events.jsonl");
const sessionState = new Map();
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

await ensureStorage();
server.listen(PORT, () => {
  console.log(`Morning check-in app running at http://localhost:${PORT}`);
});

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

async function handleChat(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: "Missing OPENAI_API_KEY environment variable."
    });
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

  const session = sessionState.get(sessionId);

  if (!session) {
    sendJson(res, 404, { error: "Unknown sessionId." });
    return;
  }

  const now = new Date();
  const askedAt = session.lastQuestionAskedAt
    ? new Date(session.lastQuestionAskedAt)
    : null;
  const responseLatencyMs = askedAt ? now.getTime() - askedAt.getTime() : null;
  const turnNumber = session.turnCount + 1;
  const promptText = questionText || session.lastQuestionText || null;
  const savedAudio = await saveAudioFile(sessionId, audio, mimeType, turnNumber);

  try {
    const transcript = await transcribeAudio(audio, mimeType);
    const reply = await generateReply(messages, transcript);
    const replySentAt = new Date().toISOString();

    session.turnCount = turnNumber;
    session.lastQuestionAskedAt = replySentAt;
    session.lastQuestionText = reply;

    await logEvent({
      type: "user_response_received",
      sessionId,
      turnNumber,
      questionText: promptText,
      questionAskedAt: askedAt?.toISOString() || null,
      responseReceivedAt: now.toISOString(),
      responseLatencyMs,
      recordingStartedAt: recordingStartedAt || null,
      recordingDurationMs: recordingStartedAt
        ? now.getTime() - new Date(recordingStartedAt).getTime()
        : null,
      transcript,
      audioFile: savedAudio.fileName,
      audioBytes: savedAudio.byteLength,
      mimeType
    });

    await logEvent({
      type: "assistant_question_sent",
      sessionId,
      turnNumber,
      questionText: reply,
      askedAt: replySentAt
    });

    sendJson(res, 200, {
      transcript,
      reply,
      questionAskedAt: replySentAt,
      audioFile: savedAudio.fileName,
      responseLatencyMs
    });
  } catch (error) {
    await logEvent({
      type: "chat_turn_failed",
      sessionId,
      turnNumber,
      questionText: promptText,
      questionAskedAt: askedAt?.toISOString() || null,
      responseReceivedAt: now.toISOString(),
      responseLatencyMs,
      recordingStartedAt: recordingStartedAt || null,
      audioFile: savedAudio.fileName,
      audioBytes: savedAudio.byteLength,
      mimeType,
      error: error.message
    });
    throw error;
  }
}

async function handleSession(req, res) {
  const body = await readJsonBody(req);
  const sessionId = randomUUID();
  const openedAt = new Date().toISOString();
  const session = {
    createdAt: openedAt,
    turnCount: 0,
    lastQuestionAskedAt: null,
    lastQuestionText: null,
    userAgent: body?.userAgent || null
  };

  sessionState.set(sessionId, session);

  await logEvent({
    type: "app_opened",
    sessionId,
    openedAt,
    userAgent: body?.userAgent || null
  });

  sendJson(res, 200, { sessionId });
}

async function handleSessionStart(req, res) {
  const body = await readJsonBody(req);
  const { sessionId } = body ?? {};
  const session = sessionState.get(sessionId);

  if (!session) {
    sendJson(res, 404, { error: "Unknown sessionId." });
    return;
  }

  if (session.lastQuestionAskedAt) {
    sendJson(res, 200, {
      openingQuestion: session.lastQuestionText,
      questionAskedAt: session.lastQuestionAskedAt
    });
    return;
  }

  const askedAt = new Date().toISOString();
  session.lastQuestionAskedAt = askedAt;
  session.lastQuestionText = openingQuestion;

  await logEvent({
    type: "assistant_question_sent",
    sessionId,
    turnNumber: 0,
    questionText: openingQuestion,
    askedAt
  });

  sendJson(res, 200, { openingQuestion, questionAskedAt: askedAt });
}

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
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transcription failed: ${errorText}`);
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
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.8,
      messages: conversation
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Chat completion failed: ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

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
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

async function ensureStorage() {
  await mkdir(LOGS_DIR, { recursive: true });
  await mkdir(AUDIO_DIR, { recursive: true });
}

async function saveAudioFile(sessionId, base64Audio, mimeType, turnNumber) {
  const bytes = Buffer.from(base64Audio, "base64");
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  const fileName = `${sessionId}-turn-${String(turnNumber).padStart(2, "0")}.${extension}`;
  const filePath = join(AUDIO_DIR, fileName);

  await writeFile(filePath, bytes);

  return {
    fileName,
    filePath,
    byteLength: bytes.byteLength,
    savedAt: new Date().toISOString()
  };
}

async function logEvent(event) {
  const payload = {
    loggedAt: new Date().toISOString(),
    ...event
  };

  await appendFile(SESSION_LOG_FILE, `${JSON.stringify(payload)}\n`, "utf8");
}
