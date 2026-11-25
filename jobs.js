'use strict';
// ---------- Google Drive imports ----------
// Copies every photo in an event's Drive folder (and folders inside it, two
// levels deep) into the event. Photos already copied, or deleted by the
// admin, are skipped, so running it again only adds new ones.
//
// On Cloudflare's free plan one run may make about 50 outside requests and
// runs for at most ~30 seconds after a page answers, so an import is done in
// small steps: first the folder is listed (the list of photos still to copy
// is saved in drive_imports.todo), then a few photos per step. Steps run
// right after an import is started, each time the admin panel checks the
// progress (every 4 seconds while it's open), and from the scheduled job
// every 5 minutes.
// A step holds a short lease (heartbeat_at) so two never work on one import.

const { pool, insertMedia, later } = require('./db');
const drive = require('./drive');
const { processImage } = require('./images');

const PHOTOS_PER_STEP = 5;   // ~8 outside requests each (2 from Drive, 2 to storage, 4 to the database)
const STEP_MS = 20000;
const LEASE_SECONDS = 60;
const MAX_SUBFOLDERS = 30;

let hooks = { assertRoom: async () => {}, changed: () => {} };
function configure(h) { hooks = { ...hooks, ...h }; }

async function collectImages(folderId, resourceKey) {
  const top = await drive.listFolder(folderId, resourceKey);
  const images = top.images.slice();
  const queue = top.folders.map((f) => ({ ...f, depth: 1 }));
  let visited = 0;
  while (queue.length && visited < MAX_SUBFOLDERS) {
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

// Runs one step of the oldest import that needs work. Returns true if it did something.
async function step(db) {
  const { rows } = await db.query(
    `UPDATE drive_imports SET status = 'running', heartbeat_at = now()
      WHERE id = (SELECT id FROM drive_imports
                   WHERE status IN ('pending', 'running')
                     AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1))
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [LEASE_SECONDS]);
  const job = rows[0];
  if (!job) return false;
  const set = (fields) => {
    const keys = Object.keys(fields);
    return db.query(`UPDATE drive_imports SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [job.id, ...keys.map((k) => (k === 'todo' ? JSON.stringify(fields[k]) : fields[k]))]);
  };
  try {
    const still = await db.query('SELECT 1 FROM events WHERE id = $1', [job.event_id]);
    if (!still.rowCount) return true; // event deleted (its imports go with it)

    // First step: list the folder.
    if (!job.todo) {
      const { images } = await collectImages(job.folder_id, job.resource_key);
      const known = await db.query(
        `SELECT source FROM media WHERE event_id = $1 AND source IS NOT NULL
         UNION SELECT source FROM drive_removed WHERE event_id = $1`, [job.event_id]);
      const have = new Set(known.rows.map((r) => r.source));
      const todo = images.filter((i) => !have.has(`drive:${i.id}`)).map((i) => ({ id: i.id, name: i.name || '' }));
      await set({ todo, total: images.length, skipped: images.length - todo.length, added: 0, failed: 0, heartbeat_at: null });
      return true;
    }

    // Next steps: copy a few photos.
    const todo = Array.isArray(job.todo) ? job.todo.slice() : [];
    let { added, failed } = job;
    const t0 = Date.now();
    let n = 0;
    while (todo.length && n < PHOTOS_PER_STEP && Date.now() - t0 < STEP_MS) {
      const file = todo.shift();
      n += 1;
      try {
        const got = await drive.downloadPhoto(file.id);
        const img = await processImage(got.full, got.thumb);
        await hooks.assertRoom(img.data.length + img.thumb.length, db);
        const id = await insertMedia({ category: 'event', caption: '', eventId: job.event_id, img, source: `drive:${file.id}` }, db)
          .catch((err) => { if (err.code === '23505') return null; throw err; }); // already there
        if (id) {
          added += 1;
          await db.query('UPDATE events SET cover_media_id = $1 WHERE id = $2 AND cover_media_id IS NULL', [id, job.event_id]);
        }
      } catch (err) {
        if (/storage is full/i.test(err.message)) throw err;
        failed += 1;
        console.warn(`[drive] ${file.name || file.id}: ${err.message}`);
      }
      await set({ todo, added, failed, heartbeat_at: new Date() });
    }
    if (n) hooks.changed();
    if (!todo.length) {
      await set({ status: 'done', finished_at: new Date(), todo: [], heartbeat_at: null });
      await db.query('UPDATE events SET drive_synced_at = now() WHERE id = $1', [job.event_id]);
      if (added || failed) console.log(`[drive] event ${job.event_id}: ${added} photos added, ${failed} could not be copied`);
    } else {
      await set({ heartbeat_at: null });
    }
    return true;
  } catch (err) {
    await set({ status: 'failed', error: String(err.message).slice(0, 300), finished_at: new Date(), heartbeat_at: null }).catch(() => {});
    console.warn(`[drive] import ${job.id} stopped: ${err.message}`);
    return true;
  }
}

// A flag in Workers KV says whether any import has work left, so the
// scheduled job (every 5 minutes) only wakes the database when it must.
function flags() {
  const env = globalThis.__env;
  return env && env.FLAGS ? env.FLAGS : null;
}
async function setWorkFlag(on) {
  const kv = flags();
  if (!kv) return;
  try {
    if (on) await kv.put('drive-work', '1');
    else await kv.delete('drive-work');
  } catch (err) { console.warn('[drive] flag:', err.message); }
}
// True when the flag says there may be work (or there is no flag store).
async function mayHaveWork() {
  const kv = flags();
  if (!kv) return true;
  return (await kv.get('drive-work')) === '1';
}

// Does one step (the outside-request budget of a single run allows one).
async function processDriveImports() {
  const db = await pool.connect();
  try {
    const did = await step(db);
    if (!did) {
      const open = await db.query("SELECT 1 FROM drive_imports WHERE status IN ('pending', 'running') LIMIT 1");
      if (!open.rowCount) await setWorkFlag(false);
    }
    return did;
  } finally {
    db.release();
  }
}

// Starts a step in the background (after the answer has gone out).
function kick() {
  later(processDriveImports().catch((err) => console.error('[drive] step failed:', err.message)));
}

// True when some import still has work and nobody holds it.
async function needsWork() {
  const { rows } = await pool.query(
    `SELECT 1 FROM drive_imports WHERE status IN ('pending', 'running')
       AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1)) LIMIT 1`, [LEASE_SECONDS]);
  return rows.length > 0;
}

// Queues a copy of an event's linked folder, unless one is already waiting.
async function queueDriveImport(eventId, automatic = false, { start = true } = {}) {
  const ev = await pool.query('SELECT drive_folder, drive_resource_key FROM events WHERE id = $1', [eventId]);
  const e = ev.rows[0];
  if (!e || !e.drive_folder) return null;
  const busy = await pool.query("SELECT id FROM drive_imports WHERE event_id = $1 AND status IN ('pending', 'running')", [eventId]);
  if (busy.rowCount) return busy.rows[0].id;
  const r = await pool.query(
    'INSERT INTO drive_imports (event_id, folder_id, resource_key, automatic) VALUES ($1, $2, $3, $4) RETURNING id',
    [eventId, e.drive_folder, e.drive_resource_key, automatic]);
  await setWorkFlag(true);
  if (start) kick();
  return r.rows[0].id;
}

// Every few hours, look for new photos in the folders of recent events.
async function syncDriveFolders() {
  const { rows } = await pool.query(
    `SELECT id FROM events WHERE drive_folder IS NOT NULL
       AND starts_at > now() - interval '120 days'
       AND (drive_synced_at IS NULL OR drive_synced_at < now() - interval '5 hours')`);
  for (const r of rows) await queueDriveImport(r.id, true, { start: false });
}

module.exports = { processDriveImports, queueDriveImport, syncDriveFolders, needsWork, mayHaveWork, kick, configure };
