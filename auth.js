'use strict';
// Admin accounts: email + password, stored as a salted scrypt hash.
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Always does the same work, even for an unknown account, so timing doesn't
// reveal which emails exist.
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(KEYLEN).toString('base64');
async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const got = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return stored ? crypto.timingSafeEqual(got, expected) : false;
}

const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', 'qwerty123',
  'qwertyuiop', 'iloveyou', 'admin123', 'administrator', 'welcome1', 'letmein123', 'changeme', 'zimbabwe',
  'harare123', 'rnbdancehall', 'rnbdancehalllovers', 'dancehall', 'dancehalllovers',
]);

// Returns a message saying what's wrong with a new password, or '' if it's fine.
function passwordProblem(password, email) {
  const pw = String(password || '');
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  const simple = pw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (COMMON.has(simple) || COMMON.has(simple.replace(/\d+$/, ''))) return 'That password is too easy to guess. Try a short sentence you will remember.';
  if (/^(.)\1+$/.test(pw)) return 'That password is too easy to guess.';
  const local = String(email || '').toLowerCase().split('@')[0];
  if (local.length >= 4 && simple.includes(local.replace(/[^a-z0-9]/g, ''))) return "Don't use your email address in your password.";
  return '';
}

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, normaliseEmail, validEmail };
