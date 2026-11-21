'use strict';
// Background video compression. A newly uploaded video is shown straight away
// as uploaded; this then makes a smaller copy and swaps it in (same section,
// same place in the slideshow). One video at a time, so the small server
// is never overloaded. Survives restarts: unfinished videos stay 'pending'.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { pool, insertMedia, forgetMediaFiles } = require('./db');
const storage = require('./storage');
const { compressVideo } = require('./video');

// Keep the new copy only if it saves at least 10%.
const MIN_SAVING = 0.10;
let running = false;
let again = false;

async function compressPendingVideos() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      for (;;) {
        const { rows } = await pool.query(
          `SELECT id, mime, category, slot, event_id, caption, created_at, in_bucket, bytes
           FROM media WHERE video_state = 'pending' ORDER BY id LIMIT 1`);
        if (!rows.length) break;
        await compressOne(rows[0]);
      }
    } while (again);
  } finally {
    running = false;
  }
}

// A video that was being compressed when the server restarted (for example
// because it ran out of memory) gets one more try, then is left as uploaded.
const MAX_ATTEMPTS = 2;

async function compressOne(m) {
  const t = await pool.query(
    "UPDATE media SET video_attempts = video_attempts + 1 WHERE id = $1 AND video_state = 'pending' RETURNING video_attempts", [m.id]);
  if (!t.rowCount) return;
  if (t.rows[0].video_attempts > MAX_ATTEMPTS) {
    await pool.query("UPDATE media SET video_state = 'failed' WHERE id = $1", [m.id]);
    console.warn(`[video] ${m.id}: gave up after ${MAX_ATTEMPTS} tries, keeping the original`);
    return;
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rnb-video-'));
  const inPath = path.join(dir, 'in');
  const outPath = path.join(dir, 'out.mp4');
  const t0 = Date.now();
  try {
    if (m.in_bucket) {
      const { body } = await storage.getMedia(m.id);
      await pipeline(body, fs.createWriteStream(inPath));
    } else {
      const r = await pool.query('SELECT data FROM media WHERE id = $1', [m.id]);
      if (!r.rowCount) return;
      await fs.promises.writeFile(inPath, r.rows[0].data);
    }
    const before = (await fs.promises.stat(inPath)).size;
    await compressVideo(inPath, outPath);
    const out = await fs.promises.readFile(outPath);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (out.length > before * (1 - MIN_SAVING)) {
      await pool.query("UPDATE media SET video_state = 'done' WHERE id = $1", [m.id]);
      console.log(`[video] ${m.id}: already small (${mb(before)} → ${mb(out.length)}), kept the original (${secs}s)`);
      return;
    }
    const client = await pool.connect();
    let newId = null;
    try {
      await client.query('BEGIN');
      const still = await client.query("SELECT 1 FROM media WHERE id = $1 AND video_state = 'pending' FOR UPDATE", [m.id]);
      if (!still.rowCount) { await client.query('ROLLBACK'); return; } // deleted or replaced meanwhile
      newId = await insertMedia({
        category: m.category, caption: m.caption, eventId: m.event_id, slot: m.slot, createdAt: m.created_at,
        img: { mime: 'video/mp4', width: 0, height: 0, data: out, thumb: Buffer.alloc(0), videoState: 'done' },
      }, client);
      await client.query('UPDATE events SET cover_media_id = $1 WHERE cover_media_id = $2', [newId, m.id]);
      await client.query('DELETE FROM media WHERE id = $1', [m.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (newId) forgetMediaFiles(newId);
      throw err;
    } finally {
      client.release();
    }
    forgetMediaFiles(m.id);
    console.log(`[video] ${m.id} → ${newId}: ${mb(before)} → ${mb(out.length)} (${Math.round((1 - out.length / before) * 100)}% smaller, ${secs}s)`);
  } catch (err) {
    console.error(`[video] ${m.id}: could not compress, keeping the original:`, err.message);
    await pool.query("UPDATE media SET video_state = 'failed' WHERE id = $1", [m.id]).catch(() => {});
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

module.exports = { compressPendingVideos };
