'use strict';
// Local stand-ins for testing the Worker with `wrangler dev` without Neon:
//  - :4444  speaks Neon's HTTP query protocol (what @neondatabase/serverless
//           sends) and runs the queries on a local Postgres (LOCAL_PG_URL).
//  - :4445  a tiny in-memory S3 (PUT/GET with Range/DELETE/ListObjectsV2).
// Use with NEON_FETCH_ENDPOINT=http://127.0.0.1:4444/sql and
// AWS_ENDPOINT_URL_S3=http://127.0.0.1:4445 in .dev.vars. Not deployed.
const http = require('http');
const { Pool } = require('pg');

const pg = new Pool({ connectionString: process.env.LOCAL_PG_URL || 'postgresql://postgres:pg@127.0.0.1:5432/rnb' });
const RAW = { getTypeParser: () => (v) => v };

function body(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

http.createServer(async (req, res) => {
  try {
    const q = JSON.parse((await body(req)).toString('utf8'));
    const run = async (one) => {
      const r = await pg.query({ text: one.query, values: one.params || [], rowMode: 'array', types: RAW });
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      return { command: last.command, rowCount: last.rowCount, fields: last.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: last.rows };
    };
    const out = q.queries ? { results: await Promise.all(q.queries.map(run)) } : await run(q);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: err.message, code: err.code }));
  }
}).listen(4444, '127.0.0.1');

const objects = new Map(); // key -> { body, type, modified }
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const [, bucket, ...rest] = u.pathname.split('/');
  const key = rest.map(decodeURIComponent).join('/');
  if (req.method === 'PUT') {
    objects.set(key, { body: await body(req), type: req.headers['content-type'] || 'application/octet-stream', modified: new Date() });
    return res.writeHead(200).end();
  }
  if (req.method === 'DELETE') { objects.delete(key); return res.writeHead(204).end(); }
  if (req.method === 'GET' && !key && u.searchParams.get('list-type') === '2') {
    const prefix = u.searchParams.get('prefix') || '';
    const items = [...objects].filter(([k]) => k.startsWith(prefix));
    const xml = `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>${items.map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><LastModified>${o.modified.toISOString()}</LastModified></Contents>`).join('')}</ListBucketResult>`;
    return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(xml);
  }
  if (req.method === 'GET') {
    const o = objects.get(key);
    if (!o) return res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const size = o.body.length;
      const start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
      const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
      return res.writeHead(206, { 'Content-Type': o.type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` })
        .end(o.body.subarray(start, end + 1));
    }
    return res.writeHead(200, { 'Content-Type': o.type, 'Content-Length': o.body.length }).end(o.body);
  }
  res.writeHead(405).end();
}).listen(4445, '127.0.0.1');

console.log('local Neon HTTP on :4444, S3 on :4445');

// :4446  a pretend Google Drive (use DRIVE_WEB_BASE=http://127.0.0.1:4446):
// folder TOPFOLDER0001 has 9 photos and one folder (SUBFOLDER0001, 4 photos).
const fs = require('fs');
const FOLDERS = {
  TOPFOLDER0001: { name: '12 Dec 2026 Night', photos: 9, sub: ['SUBFOLDER0001'] },
  SUBFOLDER0001: { name: 'More', photos: 4, sub: [] },
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const id = u.searchParams.get('id') || '';
  if (u.pathname === '/embeddedfolderview' && FOLDERS[id]) {
    const f = FOLDERS[id];
    const entries = [];
    for (let i = 1; i <= f.photos; i += 1) entries.push(`<div class="flip-entry" id="entry-${id}IMG${i}"><a href="/file/d/${id}IMG${i}/view"></a><div class="flip-entry-title">photo${i}.jpg</div></div>`);
    for (const s of f.sub) entries.push(`<div class="flip-entry"><a href="/drive/folders/${s}"></a><div class="flip-entry-title">${FOLDERS[s].name}</div></div>`);
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<html><title>${f.name} - Google Drive</title><body>${entries.join('')}</body></html>`);
  }
  if (u.pathname === '/thumbnail') {
    const big = /s1600/.test(u.searchParams.get('sz') || '');
    return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(fs.readFileSync(big ? '/tmp/dfull.jpg' : '/tmp/dthumb.jpg'));
  }
  res.writeHead(404).end();
}).listen(4446, '127.0.0.1');
