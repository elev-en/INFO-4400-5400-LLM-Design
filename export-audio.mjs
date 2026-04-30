import postgres from "postgres";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const OUT_DIR = join(process.cwd(), "data", "audio-export");

await mkdir(OUT_DIR, { recursive: true });

const turns = await sql`
  SELECT id, username, audio_file, audio_data, mime_type
  FROM turns
  WHERE audio_data IS NOT NULL
  ORDER BY id
`;

console.log(`Exporting ${turns.length} audio files to ${OUT_DIR} ...`);

for (const turn of turns) {
  const ext = turn.mime_type?.includes("wav") ? "wav" : "webm";
  const fileName = turn.audio_file || `turn-${turn.id}.${ext}`;
  const filePath = join(OUT_DIR, fileName);
  await writeFile(filePath, turn.audio_data);
  console.log(`  ${fileName} (${turn.audio_data.length} bytes) [${turn.username}]`);
}

console.log("Done.");
await sql.end();
