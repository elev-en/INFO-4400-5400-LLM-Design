import postgres from "postgres";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL environment variable is not set.");
  console.error("Run with: DATABASE_URL=<your-db-url> node export-audio.mjs");
  console.error("You can find DATABASE_URL in the .env file.");
  process.exit(1);
}

let hasFfmpeg = false;
try {
  execSync("ffmpeg -version", { stdio: "pipe" });
  hasFfmpeg = true;
} catch {
  console.warn("Warning: ffmpeg not found — exporting original audio files instead of MP3.");
  console.warn("Install ffmpeg to get MP3 output: https://ffmpeg.org/download.html");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const OUT_DIR = join(process.cwd(), "data", "audio-export");

await mkdir(OUT_DIR, { recursive: true });

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-i", inputPath,
      "-codec:a", "libmp3lame", "-q:a", "2",
      outputPath
    ], { stdio: "pipe" });
    ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
  });
}

const turns = await sql`
  SELECT t.id, t.username, COALESCE(t.day_number, s.day_number) AS day_number,
         t.turn_number, t.audio_data, t.mime_type,
         COALESCE(t.response_received_at, t.question_asked_at, t.created_at) AS recorded_at
  FROM turns t
  JOIN sessions s ON t.session_id = s.id
  WHERE t.audio_data IS NOT NULL
  ORDER BY t.id
`;

console.log(`Exporting ${turns.length} audio files to ${OUT_DIR} as MP3 ...`);

for (const turn of turns) {
  const srcExt = turn.mime_type?.includes("wav") ? "wav" : "webm";
  const date = new Date(turn.recorded_at).toISOString().slice(0, 10);
  const base = `${turn.username}_${date}_day${turn.day_number ?? "?"}_turn${String(turn.turn_number).padStart(2, "0")}`;

  if (hasFfmpeg) {
    const mp3Path = join(OUT_DIR, `${base}.mp3`);
    const tmpPath = join(tmpdir(), `${randomUUID()}.${srcExt}`);
    await writeFile(tmpPath, turn.audio_data);
    try {
      await convertToMp3(tmpPath, mp3Path);
      console.log(`  ${base}.mp3`);
    } catch (err) {
      console.error(`  FAILED ${base}.mp3: ${err.message}`);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } else {
    const outPath = join(OUT_DIR, `${base}.${srcExt}`);
    await writeFile(outPath, turn.audio_data);
    console.log(`  ${base}.${srcExt}`);
  }
}

console.log("Done.");
await sql.end();
