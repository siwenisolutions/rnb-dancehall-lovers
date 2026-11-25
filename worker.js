// Cloudflare Worker entry point for the RnB Dancehall Lovers website.
//
// - /media/<id>: photos and videos, streamed from Neon Object Storage and
//   kept in Cloudflare's cache (they never change: edits get new ids).
// - Everything else that isn't a static file goes to the Express app
//   (server.js): pages, the public API and the admin panel.
// - CSS, JS, images and the welcome video in public/ are served by
//   Cloudflare directly without running this code (static assets).
// - scheduled(): runs every 5 minutes (wrangler.jsonc) for Drive imports,
//   the twice-daily Megaticket check and the 6-hourly tidy-up.
import { env, waitUntil } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';

// Bindings for the CommonJS modules (Cloudflare Images, KV flags, background work).
globalThis.__env = env;
globalThis.__waitUntil = waitUntil;

const { app } = require('./server');
const { pool, migrate, sweepOrphanFiles } = require('./db');
const storage = require('./storage');
const jobs = require('./jobs');
const megaticket = require('./megaticket');
const visits = require('./visits');
const shop = require('./shop');

const PORT = 3000;
app.listen(PORT);

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json', ...SECURITY } });
}

// Turns a stored photo into a JPEG (for visitors who download or share it).
async function asJpeg(body) {
  const images = env.IMAGES;
  if (!images) return null;
  try {
    const out = await images.input(body).output({ format: 'image/jpeg', quality: 88 });
    return out.response();
  } catch (err) {
    console.warn('[media] jpeg failed:', err.message);
    return null;
  }
}

async function serveMedia(request, url, ctx) {
  const m = /^\/media\/(\d+)(?:\.(webp|jpg|png|mp4|webm))?$/.exec(url.pathname);
  if (!m) return jsonError(404, 'Photo not found.');
  if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError(405, 'Not allowed.');
  const id = Number(m[1]);
  const wantJpg = m[2] === 'jpg';
  const thumb = url.searchParams.get('size') === 'thumb';
  const dl = url.searchParams.has('dl');
  const range = request.headers.get('Range');

  // One cache entry per file version: full or thumbnail, as stored or as JPEG.
  const keyUrl = `${url.origin}/media/${id}${wantJpg ? '.jpg' : ''}${thumb && !wantJpg ? '?size=thumb' : ''}`;
  const cache = caches.default;
  const hit = await cache.match(new Request(keyUrl, { headers: range ? { Range: range } : {} }));
  if (hit) return withDownload(hit, id, dl, wantJpg);

  const { rows } = await pool.query('SELECT mime FROM media WHERE id = $1 AND in_bucket', [id]);
  if (!rows.length) return jsonError(404, 'Photo not found.');
  const mime = rows[0].mime;
  const video = mime.startsWith('video/');

  let src;
  try {
    // A piece of a video (phones ask for pieces, iPhones insist on it).
    src = await storage.getMedia(id, { thumb: thumb && !video, range: video && range ? range : undefined });
  } catch (err) {
    if (err.notFound) return jsonError(404, 'Photo not found.');
    throw err;
  }

  if (wantJpg && mime.startsWith('image/')) {
    const jpg = await asJpeg(src.body);
    if (jpg) {
      const res = new Response(jpg.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': IMMUTABLE, ...SECURITY } });
      ctx.waitUntil(cache.put(keyUrl, res.clone()));
      return withDownload(res, id, dl, true);
    }
    src = await storage.getMedia(id); // couldn't convert: send the photo as stored
  }

  const headers = {
    'Content-Type': mime,
    'Cache-Control': IMMUTABLE,
    'Accept-Ranges': 'bytes',
    ...SECURITY,
  };
  for (const h of ['Content-Length', 'Content-Range']) if (src.headers.get(h)) headers[h] = src.headers.get(h);
  const res = new Response(request.method === 'HEAD' ? null : src.body, { status: src.status === 206 ? 206 : 200, headers });

  if (src.status === 206) {
    // Fill the cache with the whole video in the background, so later
    // visitors (and later pieces) come from Cloudflare.
    ctx.waitUntil(storage.getMedia(id).then((full) => cache.put(keyUrl, new Response(full.body, {
      headers: { 'Content-Type': mime, 'Cache-Control': IMMUTABLE, 'Accept-Ranges': 'bytes', 'Content-Length': full.headers.get('Content-Length') || '' },
    }))).catch(() => {}));
  } else if (request.method === 'GET') {
    ctx.waitUntil(cache.put(keyUrl, res.clone()).catch(() => {}));
  }
  return withDownload(res, id, dl, wantJpg);
}

function withDownload(res, id, dl, jpg) {
  if (!dl) return res;
  const out = new Response(res.body, res);
  out.headers.set('Content-Disposition', `attachment; filename="RnB-Dancehall-Lovers-${id}.${jpg ? 'jpg' : 'webp'}"`);
  return out;
}

// Hourly-ish jobs, each on its own so one failure doesn't stop the rest.
async function tidyUp() {
  const steps = [
    ['schema', () => migrate()],
    ['drive sync', () => jobs.syncDriveFolders()],
    ['storage sweep', () => sweepOrphanFiles({ max: 25 })],
    ['visitors', () => visits.tidy()],
    ['orders', () => shop.cancelStaleOrders(pool)],
  ];
  for (const [name, fn] of steps) {
    try { await fn(); } catch (err) { console.warn(`[tidy] ${name} failed:`, err.message); }
  }
}

export default {
  async fetch(request, workerEnv, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/media/')) return await serveMedia(request, url, ctx);
      return await handleAsNodeRequest(PORT, request);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${request.method} ${url.pathname}`, err);
      return jsonError(500, 'Something went wrong on our side. Please try again.');
    }
  },

  async scheduled(controller, workerEnv, ctx) {
    const now = new Date(controller.scheduledTime);
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    // Megaticket at 12:00 and 21:00 Harare time (10:00 and 19:00 UTC).
    if ((hour === 10 || hour === 19) && minute < 5) {
      await megaticket.check('schedule').catch((err) => console.warn('[megaticket]', err.message));
      return;
    }
    // Every 6 hours: schema, Drive folder checks, storage tidy-up.
    if (hour % 6 === 0 && minute >= 30 && minute < 35) {
      await tidyUp();
      return;
    }
    // Otherwise: move a waiting Drive import one step on, if there is one.
    if (await jobs.mayHaveWork()) {
      await jobs.processDriveImports().catch((err) => console.warn('[drive]', err.message));
    }
  },
};
