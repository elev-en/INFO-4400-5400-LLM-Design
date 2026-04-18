import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required.");
}

export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10
});

export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT        PRIMARY KEY,
      username      TEXT        UNIQUE NOT NULL,
      password_hash TEXT        NOT NULL,
      password_salt TEXT        NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id                     TEXT        PRIMARY KEY,
      user_id                TEXT        NOT NULL REFERENCES users(id),
      username               TEXT        NOT NULL,
      user_agent             TEXT,
      opened_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      turn_count             INTEGER     NOT NULL DEFAULT 0,
      last_question_asked_at TIMESTAMPTZ,
      last_question_text     TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS turns (
      id                    SERIAL      PRIMARY KEY,
      session_id            TEXT        NOT NULL REFERENCES sessions(id),
      user_id               TEXT        NOT NULL,
      username              TEXT        NOT NULL,
      turn_number           INTEGER     NOT NULL,
      question_text         TEXT,
      question_asked_at     TIMESTAMPTZ,
      response_received_at  TIMESTAMPTZ,
      response_latency_ms   INTEGER,
      recording_started_at  TIMESTAMPTZ,
      recording_duration_ms INTEGER,
      transcript            TEXT,
      reply                 TEXT,
      audio_file            TEXT,
      audio_bytes           INTEGER,
      mime_type             TEXT,
      failed                BOOLEAN     NOT NULL DEFAULT FALSE,
      error_message         TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id         SERIAL      PRIMARY KEY,
      type       TEXT        NOT NULL,
      session_id TEXT,
      user_id    TEXT,
      username   TEXT,
      payload    JSONB       NOT NULL DEFAULT '{}',
      logged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}
