'use strict';
// Photos and videos live in Neon Object Storage (5 GB on the free plan),
// not in the database. Talks to it over plain S3 requests (aws4fetch), which
// is small and works on Cloudflare Workers.
const { AwsClient } = require('aws4fetch');

const BUCKET = process.env.MEDIA_BUCKET || '';
const ENDPOINT = (process.env.AWS_ENDPOINT_URL_S3 || '').replace(/\/+$/, '');
const enabled = !!(BUCKET && ENDPOINT && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

let aws = null;
function client() {
  if (!aws) {
    aws = new AwsClient({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'eu-central-1',
      service: 's3',
    });
  }
  return aws;
}

const fullKey = (id) => `media/${id}/full`;
const thumbKey = (id) => `media/${id}/thumb`;
const urlOf = (key) => `${ENDPOINT}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

class StorageError extends Error {
  constructor(message, status) { super(message); this.status = status; this.notFound = status === 404; }
}

async function send(method, key, { body, headers = {}, query = '' } = {}) {
  const url = key === null ? `${ENDPOINT}/${BUCKET}${query}` : urlOf(key) + query;
  const res = await client().fetch(url, { method, body, headers });
  if (!res.ok && !(method === 'GET' && res.status === 206)) {
    const text = await res.text().catch(() => '');
    throw new StorageError(`storage ${method} ${key || ''} answered ${res.status} ${text.slice(0, 200)}`, res.status);
  }
  return res;
}

async function put(key, body, contentType) {
  await send('PUT', key, { body, headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) } });
}

// Stores a photo (large copy + thumbnail) or a video under the media id.
async function putMedia(id, img) {
  await put(fullKey(id), img.data, img.mime);
  if (img.thumb && img.thumb.length) await put(thumbKey(id), img.thumb, img.mime);
}

// The stored file as a fetch Response (status 200, or 206 for a byte range).
async function getMedia(id, { thumb = false, range } = {}) {
  return send('GET', thumb ? thumbKey(id) : fullKey(id), { headers: range ? { Range: range } : {} });
}

async function getMediaBuffer(id, opts) {
  const res = await getMedia(id, opts);
  return Buffer.from(await res.arrayBuffer());
}

async function deleteKeys(keys) {
  for (const key of keys) {
    await send('DELETE', key).catch((err) => { if (!err.notFound) throw err; });
  }
}

async function deleteMedia(id) {
  await deleteKeys([fullKey(id), thumbKey(id)]);
}

function xmlValues(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

// Every stored media id with its total size in bytes.
async function listMedia() {
  const out = new Map();
  let token = '';
  do {
    const query = `?list-type=2&prefix=media%2F${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const xml = await (await send('GET', null, { query })).text();
    for (const c of xmlValues(xml, 'Contents')) {
      const key = (xmlValues(c, 'Key')[0] || '').replace(/&amp;/g, '&');
      const m = /^media\/(\d+)\/(full|thumb)$/.exec(key);
      if (!m) continue;
      const id = Number(m[1]);
      const e = out.get(id) || { bytes: 0, keys: [], newest: 0 };
      e.bytes += Number(xmlValues(c, 'Size')[0] || 0);
      e.keys.push(key);
      e.newest = Math.max(e.newest, new Date(xmlValues(c, 'LastModified')[0] || 0).getTime() || 0);
      out.set(id, e);
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xmlValues(xml, 'NextContinuationToken')[0] || '') : '';
  } while (token);
  return out;
}

module.exports = { enabled, BUCKET, putMedia, getMedia, getMediaBuffer, deleteMedia, deleteKeys, listMedia, StorageError };
