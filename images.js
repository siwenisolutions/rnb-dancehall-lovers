'use strict';
const sharp = require('sharp');

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
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(data)
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 })
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

module.exports = { processImage, detectVideo };
