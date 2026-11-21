'use strict';
// Shrinks uploaded videos: at most 1920 px on the long side, 30 fps, H.264 at
// CRF 23 (visually the same as a phone's original), AAC sound, and the index
// at the front so playback starts straight away.
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const MAX_SIDE = 1920;
const CRF = Number(process.env.VIDEO_CRF || 23);
const TIMEOUT_MS = 45 * 60 * 1000; // the free server is slow; long clips take a while

function compressArgs(input, output) {
  const w = `if(gte(iw,ih),min(${MAX_SIDE},iw),-2)`;
  const h = `if(gte(iw,ih),-2,trunc(min(${MAX_SIDE},ih)/2)*2)`;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-threads', '1', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=w='${w}':h='${h}'`,
    '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(CRF),
    '-pix_fmt', 'yuv420p', '-threads', '1',
    // Smaller look-ahead keeps memory low on the 512 MB server.
    '-x264-params', 'rc-lookahead=10:threads=1',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ];
}

function compressVideo(input, output) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('No video converter on this server.'));
    const p = spawn(ffmpegPath, compressArgs(input, output), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? `stopped (${signal})` : `ffmpeg exited ${code}: ${err.trim().slice(-300)}`));
    });
  });
}

// Rewrites a video without re-encoding (same picture, same size) so its index
// sits at the start of the file: the browser can then start playing after the
// first piece arrives instead of fetching the end of the file first.
function fastStart(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
      '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`remux failed: ${err.trim().slice(-200)}`))));
  });
}

// True when an MP4/MOV already has its index ('moov') before the picture data ('mdat').
function isFastStart(buf) {
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (size < 8) return false;
    i += size;
  }
  return false;
}

module.exports = { compressVideo, compressArgs, fastStart, isFastStart };
