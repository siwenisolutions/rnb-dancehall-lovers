'use strict';
const sharp = require('sharp');

// Compression for stored photos: large copy and thumbnail.
const FULL_PX = 1600, FULL_Q = 74, THUMB_PX = 640, THUMB_Q = 66;

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'tiff']);

// Normalises an uploaded photo: checks it really is an image, fixes phone
// rotation, strips metadata (GPS etc.) and stores a large copy plus a thumbnail
// as WebP so the database stays small.
async function processImage(buffer) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw Object.assign(new Error('That file is not a supported image.'), { status: 400 });
  }
  if (!ALLOWED_FORMATS.has(meta.format)) {
    throw Object.assign(new Error('That file is not a supported image.'), { status: 400 });
  }
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: FULL_PX, height: FULL_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: FULL_Q, effort: 5 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(data)
    .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_Q, effort: 5 })
    .toBuffer();
  return { mime: 'image/webp', width: info.width, height: info.height, data, thumb };
}

// Returns the video type if the file really is an MP4/MOV or WebM video, else null.
// Videos are stored as uploaded (the server has no video converter).
function detectVideo(buffer) {
  if (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (buffer.length > 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

// Re-compresses a stored photo with the current settings. Returns null when
// the result would not be smaller (nothing to gain).
async function recompress(data, thumb) {
  const meta = await sharp(data).metadata();
  const full = await sharp(data)
    .resize({ width: FULL_PX, height: FULL_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: FULL_Q, effort: 5 })
    .toBuffer({ resolveWithObject: true });
  const small = await sharp(full.data)
    .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_Q, effort: 5 })
    .toBuffer();
  const newData = full.data.length < data.length ? full.data : data;
  const newThumb = small.length < thumb.length ? small : thumb;
  if (newData === data && newThumb === thumb) return null;
  return {
    data: newData, thumb: newThumb,
    width: newData === data ? meta.width : full.info.width,
    height: newData === data ? meta.height : full.info.height,
  };
}

module.exports = { processImage, detectVideo, recompress };
