import postgres from "postgres";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const USERNAME = "p-119";
const PASSWORD = "test";

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

const userId = randomUUID();
const salt = randomBytes(16).toString("hex");
const hash = hashPassword(PASSWORD.toLowerCase(), salt);

// Create user if not exists
const [existing] = await sql`SELECT id FROM users WHERE username = ${USERNAME}`;
let uid = existing?.id;

if (!existing) {
  await sql`
    INSERT INTO users (id, username, password_hash, password_salt, created_at)
    VALUES (${userId}, ${USERNAME}, ${hash}, ${salt}, NOW())
  `;
  uid = userId;
  console.log(`Created user ${USERNAME} (id: ${uid})`);
} else {
  console.log(`User ${USERNAME} already exists (id: ${uid})`);
}

// Insert two fake past sessions
const session1Id = randomUUID();
const session2Id = randomUUID();

await sql`
  INSERT INTO sessions (id, user_id, username, day_number, turn_count, opened_at)
  VALUES (${session1Id}, ${uid}, ${USERNAME}, 1, 3, NOW() - interval '2 days')
  ON CONFLICT DO NOTHING
`;

await sql`
  INSERT INTO sessions (id, user_id, username, day_number, turn_count, opened_at)
  VALUES (${session2Id}, ${uid}, ${USERNAME}, 2, 3, NOW() - interval '1 day')
  ON CONFLICT DO NOTHING
`;

// Seed turns for day 1
await sql`
  INSERT INTO turns (session_id, user_id, username, day_number, turn_number, transcript, failed)
  VALUES
    (${session1Id}, ${uid}, ${USERNAME}, 1, 1, 'I woke up around 7, pretty tired. I didn''t sleep well — kept waking up in the middle of the night.', false),
    (${session1Id}, ${uid}, ${USERNAME}, 1, 2, 'I had coffee but skipped breakfast, I usually don''t eat in the mornings. I have a big presentation today and I''m pretty stressed about it.', false),
    (${session1Id}, ${uid}, ${USERNAME}, 1, 3, 'I normally try to go for a run in the mornings but I haven''t had time lately with everything going on.', false)
`;

// Seed turns for day 2
await sql`
  INSERT INTO turns (session_id, user_id, username, day_number, turn_number, transcript, failed)
  VALUES
    (${session2Id}, ${uid}, ${USERNAME}, 2, 1, 'Slept a bit better last night, maybe 7 hours. Still tired but not as bad as yesterday.', false),
    (${session2Id}, ${uid}, ${USERNAME}, 2, 2, 'The presentation went okay. My manager had some feedback but overall it was fine. I''m relieved it''s over.', false),
    (${session2Id}, ${uid}, ${USERNAME}, 2, 3, 'I finally went for a short run this morning, only like 20 minutes, but it felt good to get outside.', false)
`;

console.log("Seeded 2 past sessions (days 1 & 2) with transcripts.");
console.log(`\nNow start the server and test with:\n  POST /api/session (userId: ${uid}, username: ${USERNAME})\n  POST /api/session/start`);

await sql.end();
