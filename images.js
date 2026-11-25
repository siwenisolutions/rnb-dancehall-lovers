'use strict';
// Photos on Cloudflare Workers. The admin panel shrinks photos in the
// browser before uploading them (a large copy up to 1600 px and a 640 px
// thumbnail, see public/js/admin.js), so the server only checks them and
// reads their size. Photos fetched by the server itself (a Megaticket flyer,
// a social media post, an old browser without resizing) are shrunk with
// Cloudflare Images when the IMAGES binding is there (free plan: 5,000 a
// month), else kept as they are.

const FULL_PX = 1600, FULL_Q = 74, THUMB_PX = 640, THUMB_Q = 66;
const MAX_INPUT = 20 * 1024 * 1024;

function bad() {
  return Object.assign(new Error('That file is not a supported image.'), { status: 400 });
}

// 'jpeg' | 'png' | 'webp' | 'gif' | 'heif' | 'avif' | null
function formatOf(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'heif';
    if (/^avi[fs]$/.test(brand)) return 'avif';
  }
  return null;
}

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heif: 'image/heic', avif: 'image/avif' };

// Width and height read from the file header, or null.
function sizeOf(b) {
  const f = formatOf(b);
  try {
    if (f === 'png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (f === 'gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (f === 'webp') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const n = b.readUInt32LE(21);
        return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
      }
    }
    if (f === 'jpeg') {
      let i = 2;
      let orientation = 1;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker === 0xe1 && b.toString('ascii', i + 4, i + 8) === 'Exif') orientation = exifOrientation(b, i + 10) || 1;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7);
          return orientation >= 5 ? { width: h, height: w } : { width: w, height: h };
        }
        i += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return null;
}

function exifOrientation(b, start) {
  const le = b.toString('ascii', start, start + 2) === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = start + u32(start + 4);
  const n = u16(ifd);
  for (let k = 0; k < n; k += 1) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return 0;
}

function imagesBinding() {
  const env = globalThis.__env;
  return env && env.IMAGES ? env.IMAGES : null;
}

// Shrinks a photo with Cloudflare Images. Returns a Buffer, or null when
// that isn't available (no binding, monthly limit reached, unreadable file).
async function shrink(buffer, px, quality, format = 'image/webp') {
  const images = imagesBinding();
  if (!images || buffer.length > MAX_INPUT) return null;
  try {
    const out = await images.input(new Blob([buffer]).stream())
      .transform({ width: px, height: px, fit: 'scale-down' })
      .output({ format, quality });
    return Buffer.from(await out.response().arrayBuffer());
  } catch (err) {
    console.warn('[images] could not shrink:', err.message);
    return null;
  }
}

// Turns an uploaded or downloaded photo into { mime, width, height, data, thumb }.
// `thumbBuffer` is the thumbnail the admin's browser made, when there is one.
async function processImage(buffer, thumbBuffer) {
  const fmt = formatOf(buffer);
  if (!fmt) throw bad();
  // Already shrunk by the browser: keep as is.
  if (thumbBuffer && thumbBuffer.length && formatOf(thumbBuffer) && (fmt === 'webp' || fmt === 'jpeg')) {
    const size = sizeOf(buffer);
    if (!size) throw bad();
    return { mime: MIME[fmt], width: size.width, height: size.height, data: buffer, thumb: thumbBuffer };
  }
  const full = await shrink(buffer, FULL_PX, FULL_Q);
  if (full) {
    const thumb = (await shrink(full, THUMB_PX, THUMB_Q)) || full;
    const size = sizeOf(full) || sizeOf(buffer) || { width: 0, height: 0 };
    return { mime: 'image/webp', width: size.width, height: size.height, data: full, thumb };
  }
  // No way to shrink it here: browsers can show these as they are.
  if (!['jpeg', 'png', 'webp', 'gif'].includes(fmt)) throw bad();
  const size = sizeOf(buffer);
  if (!size) throw bad();
  return { mime: MIME[fmt], width: size.width, height: size.height, data: buffer, thumb: buffer };
}

// Returns the video type if the file really is an MP4/MOV or WebM video, else null.
// Videos are stored as uploaded (there is no video converter on Workers).
function detectVideo(buffer) {
  if (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    if (formatOf(buffer)) return null; // HEIC/AVIF photo, not a video
    const brand = buffer.toString('ascii', 8, 12);
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (buffer.length > 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

module.exports = { processImage, detectVideo, shrink, formatOf, sizeOf, MIME };
