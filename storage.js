'use strict';
// Photos and videos live in Neon Object Storage (5 GB on the free plan),
// not in the database. Without the AWS_* settings below everything falls back
// to storing files in the database, as before.
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const BUCKET = process.env.MEDIA_BUCKET || '';
const enabled = !!(BUCKET && process.env.AWS_ENDPOINT_URL_S3
  && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

const client = enabled ? new S3Client({
  region: process.env.AWS_REGION || 'eu-central-1',
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
}) : null;

const fullKey = (id) => `media/${id}/full`;
const thumbKey = (id) => `media/${id}/thumb`;

async function put(key, body, contentType) {
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

// Stores a photo (large copy + thumbnail) or a video under the media id.
async function putMedia(id, img) {
  await put(fullKey(id), img.data, img.mime);
  if (img.thumb && img.thumb.length) await put(thumbKey(id), img.thumb, img.mime);
}

// Returns { body (stream), length, contentRange } for a file, or a byte range of it.
async function getMedia(id, { thumb = false, range } = {}) {
  const r = await client.send(new GetObjectCommand({
    Bucket: BUCKET, Key: thumb ? thumbKey(id) : fullKey(id), Range: range || undefined,
  }));
  return { body: r.Body, length: Number(r.ContentLength), contentRange: r.ContentRange };
}

async function getMediaBuffer(id) {
  const { body } = await getMedia(id);
  return Buffer.from(await body.transformToByteArray());
}

async function deleteKeys(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await client.send(new DeleteObjectsCommand({
      Bucket: BUCKET, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
    }));
  }
}

async function deleteMedia(id) {
  await deleteKeys([fullKey(id), thumbKey(id)]);
}

// Every stored media id with its total size in bytes.
async function listMedia() {
  const out = new Map();
  let token;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'media/', ContinuationToken: token }));
    for (const o of r.Contents || []) {
      const m = /^media\/(\d+)\/(full|thumb)$/.exec(o.Key);
      if (!m) continue;
      const id = Number(m[1]);
      const e = out.get(id) || { bytes: 0, keys: [], newest: 0 };
      e.bytes += Number(o.Size); e.keys.push(o.Key);
      e.newest = Math.max(e.newest, new Date(o.LastModified).getTime() || 0);
      out.set(id, e);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

module.exports = { enabled, BUCKET, putMedia, getMedia, getMediaBuffer, deleteMedia, deleteKeys, listMedia };
