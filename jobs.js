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
const { compressVideo, fastStart, isFastStart } = require('./video');
const drive = require('./drive');
const { processImage } = require('./images');

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
    let out = await fs.promises.readFile(outPath);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (out.length > before * (1 - MIN_SAVING)) {
      // Not worth shrinking. Still make sure it can start playing straight away.
      const head = Buffer.alloc(64 * 1024);
      const fh = await fs.promises.open(inPath, 'r');
      await fh.read(head, 0, head.length, 0);
      await fh.close();
      if (m.mime === 'video/webm' || isFastStart(head)) {
        await pool.query("UPDATE media SET video_state = 'done' WHERE id = $1", [m.id]);
        console.log(`[video] ${m.id}: already small (${mb(before)} → ${mb(out.length)}), kept the original (${secs}s)`);
        return;
      }
      await fastStart(inPath, outPath);
      out = await fs.promises.readFile(outPath);
      console.log(`[video] ${m.id}: kept its quality, moved its index to the front so it starts at once`);
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
    hooks.changed();
    console.log(`[video] ${m.id} → ${newId}: ${mb(before)} → ${mb(out.length)} (${Math.round((1 - out.length / before) * 100)}% smaller, ${secs}s)`);
  } catch (err) {
    console.error(`[video] ${m.id}: could not compress, keeping the original:`, err.message);
    await pool.query("UPDATE media SET video_state = 'failed' WHERE id = $1", [m.id]).catch(() => {});
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

// ---------- Google Drive imports ----------
// Copies every photo in an event's Drive folder (and folders inside it, two
// levels deep) into the event, one photo at a time. Photos already copied, or
// deleted by the admin, are skipped, so running it again only adds new ones.

let hooks = { assertRoom: async () => {}, changed: () => {} };
function configure(h) { hooks = { ...hooks, ...h }; }

let driveRunning = false;
let driveAgain = false;

async function processDriveImports() {
  if (driveRunning) { driveAgain = true; return; }
  driveRunning = true;
  try {
    do {
      driveAgain = false;
      for (;;) {
        const { rows } = await pool.query(
          "UPDATE drive_imports SET status = 'running' WHERE id = (SELECT id FROM drive_imports WHERE status = 'pending' ORDER BY id LIMIT 1) RETURNING *");
        if (!rows.length) break;
        await runImport(rows[0]);
      }
    } while (driveAgain);
  } finally {
    driveRunning = false;
  }
}

async function collectImages(folderId, resourceKey) {
  const top = await drive.listFolder(folderId, resourceKey);
  const images = top.images.slice();
  const queue = top.folders.map((f) => ({ ...f, depth: 1 }));
  let visited = 0;
  while (queue.length && visited < 40) {
    const f = queue.shift();
    visited += 1;
    try {
      const sub = await drive.listFolder(f.id, '');
      images.push(...sub.images);
      if (f.depth < 2) queue.push(...sub.folders.map((x) => ({ ...x, depth: f.depth + 1 })));
    } catch (err) {
      console.warn(`[drive] skipped folder ${f.name || f.id}: ${err.message}`);
    }
  }
  return { name: top.name, images };
}

async function runImport(job) {
  const set = (fields) => {
    const keys = Object.keys(fields);
    return pool.query(`UPDATE drive_imports SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [job.id, ...keys.map((k) => fields[k])]);
  };
  try {
    const { images } = await collectImages(job.folder_id, job.resource_key);
    const known = await pool.query(
      `SELECT source FROM media WHERE event_id = $1 AND source IS NOT NULL
       UNION SELECT source FROM drive_removed WHERE event_id = $1`, [job.event_id]);
    const have = new Set(known.rows.map((r) => r.source));
    const todo = images.filter((i) => !have.has(`drive:${i.id}`));
    let { added, failed } = { added: 0, failed: 0 };
    const skipped = images.length - todo.length;
    await set({ total: images.length, skipped, added: 0, failed: 0 });
    for (const file of todo) {
      const still = await pool.query('SELECT 1 FROM events WHERE id = $1', [job.event_id]);
      if (!still.rowCount) return; // event deleted meanwhile
      try {
        const buf = await drive.downloadImage(file.id);
        const img = await processImage(buf);
        await hooks.assertRoom(img.data.length + img.thumb.length);
        const id = await insertMedia({ category: 'event', caption: '', eventId: job.event_id, img, source: `drive:${file.id}` })
          .catch((err) => { if (err.code === '23505') return null; throw err; }); // already there
        if (id) {
          added += 1;
          await pool.query('UPDATE events SET cover_media_id = $1 WHERE id = $2 AND cover_media_id IS NULL', [id, job.event_id]);
        }
      } catch (err) {
        if (/storage is full/i.test(err.message)) throw err;
        failed += 1;
        console.warn(`[drive] ${file.name || file.id}: ${err.message}`);
      }
      await set({ added, failed });
      if (added && added % 10 === 0) hooks.changed(); // new photos show within a few minutes
    }
    await set({ status: 'done', finished_at: new Date() });
    hooks.changed();
    await pool.query('UPDATE events SET drive_synced_at = now() WHERE id = $1', [job.event_id]);
    if (added || failed) console.log(`[drive] event ${job.event_id}: ${added} photos added, ${failed} could not be copied, ${skipped} already there`);
  } catch (err) {
    await set({ status: 'failed', error: String(err.message).slice(0, 300), finished_at: new Date() });
    console.warn(`[drive] import ${job.id} stopped: ${err.message}`);
  }
}

// Queues a copy of an event's linked folder, unless one is already waiting.
async function queueDriveImport(eventId, automatic = false) {
  const ev = await pool.query('SELECT drive_folder, drive_resource_key FROM events WHERE id = $1', [eventId]);
  const e = ev.rows[0];
  if (!e || !e.drive_folder) return null;
  const busy = await pool.query("SELECT id FROM drive_imports WHERE event_id = $1 AND status IN ('pending', 'running')", [eventId]);
  if (busy.rowCount) return busy.rows[0].id;
  const r = await pool.query(
    'INSERT INTO drive_imports (event_id, folder_id, resource_key, automatic) VALUES ($1, $2, $3, $4) RETURNING id',
    [eventId, e.drive_folder, e.drive_resource_key, automatic]);
  processDriveImports().catch((err) => console.error('[drive] queue stopped:', err.message));
  return r.rows[0].id;
}

// Every few hours, look for new photos in the folders of recent events.
async function syncDriveFolders() {
  const { rows } = await pool.query(
    `SELECT id FROM events WHERE drive_folder IS NOT NULL
       AND starts_at > now() - interval '120 days'
       AND (drive_synced_at IS NULL OR drive_synced_at < now() - interval '5 hours')`);
  for (const r of rows) await queueDriveImport(r.id, true);
}

async function resumeDriveImports() {
  await pool.query("UPDATE drive_imports SET status = 'pending' WHERE status = 'running'");
  await processDriveImports();
}

module.exports = { compressPendingVideos, processDriveImports, queueDriveImport, syncDriveFolders, resumeDriveImports, configure };
