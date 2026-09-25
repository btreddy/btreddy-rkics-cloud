/**
 * Transcribes pending voice DPRs. Unlike the old local-PC version, this
 * connects to your Supabase database over the internet — so it can run
 * from ANY machine (your laptop, whenever convenient), not just the one
 * hosting the live app. The audio itself lives in the database (not a
 * local folder), so nothing needs to be "in sync" with any particular PC.
 *
 * Uses OpenAI's Whisper Python package — runs fully on YOUR machine, only
 * the (already-recorded) audio bytes come from Supabase; nothing is sent
 * to any third-party AI service.
 *
 * One-time setup on whichever machine runs this:
 *   pip install openai-whisper
 *   (also needs ffmpeg on PATH — same as before)
 *
 * Run: node transcribe.js
 * (needs the same .env with DATABASE_URL as the main app)
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const core = require('./lib/core');
const pool = require('./lib/db');

const WHISPER_CLI = process.env.WHISPER_CLI_PATH || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base.en';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr || ''}`));
      resolve(stdout);
    });
  });
}

async function transcribeOne(dprId) {
  const audio = await core.getVoiceAudio(dprId);
  if (!audio) throw new Error('no audio found in database for this DPR');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkics-voice-'));
  const audioPath = path.join(tmpDir, `${dprId}.ogg`);
  fs.writeFileSync(audioPath, audio.data);

  try {
    const stdout = await run(WHISPER_CLI, [audioPath, '--model', WHISPER_MODEL, '--output_format', 'txt', '--output_dir', tmpDir, '--fp16', 'False']);

    // Don't assume Whisper names its output "<dprId>.txt" exactly — that
    // assumption is what broke last time. Instead, look for whatever .txt
    // file actually landed in the temp folder.
    const txtFile = fs.readdirSync(tmpDir).find(f => f.endsWith('.txt'));
    if (!txtFile) {
      throw new Error(`Whisper ran but produced no .txt file. Its output was:\n${stdout.slice(0, 500)}`);
    }
    const text = fs.readFileSync(path.join(tmpDir, txtFile), 'utf-8').trim();
    return text || '[transcription produced no text — voice note may be silent/unclear]';
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const pending = await core.getPendingVoiceDprs();
  if (pending.length === 0) {
    console.log('No pending voice DPRs to transcribe.');
    await pool.end();
    return;
  }

  console.log(`Found ${pending.length} pending voice DPR(s). Transcribing (model: ${WHISPER_MODEL})...`);
  let ok = 0, failed = 0;

  for (const { id } of pending) {
    try {
      const text = await transcribeOne(id);
      await core.markDprTranscribed(id, text);
      console.log(`  [ok] DPR ${id}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
      ok++;
    } catch (err) {
      console.error(`  [fail] DPR ${id}:\n${err.message.split('\n').slice(0, 6).join('\n')}\n`);
      failed++;
    }
  }

  console.log(`\nDone — ${ok} transcribed, ${failed} failed.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('Transcription run failed:', err.message);
  await pool.end();
  process.exit(1);
});
