'use strict';
const test = require('node:test');
const assert = require('node:assert');
const s = require('../social');

test('reads the caption from an Instagram link preview', () => {
  const d = '1,204 likes, 37 comments - rnbdancehalllovers on December 1, 2026: "OLD IS THE NEW VIBE 🔥\n📅 Saturday 13th December\n📍 Bakerloo Bar". ';
  assert.strictEqual(s.cleanInstagramDescription(d), 'OLD IS THE NEW VIBE 🔥\n📅 Saturday 13th December\n📍 Bakerloo Bar');
});

test('reads the caption and picture from Instagram embed HTML', () => {
  const html = '<div class="Embed"><img class="EmbeddedMediaImage" alt="x" src="https://scontent.cdninstagram.com/v/abc.jpg?a=1&amp;b=2"/>' +
    '<div class="Caption"><a class="CaptionUsername" href="#">rnbdancehalllovers</a> SUMMER VIBES 🔥<br/>📅 Sat 19 Dec<br/>⏰ 9PM<br />📍 Bakerloo Bar &amp; Grill' +
    '<div class="CaptionComments">View all 12 comments</div></div></div>';
  assert.strictEqual(s.instagramEmbedCaption(html), 'SUMMER VIBES 🔥\n📅 Sat 19 Dec\n⏰ 9PM\n📍 Bakerloo Bar & Grill');
  assert.strictEqual(s.instagramEmbedImage(html), 'https://scontent.cdninstagram.com/v/abc.jpg?a=1&b=2');
});

test('reads Open Graph tags', () => {
  const html = '<meta property="og:description" content="Party &quot;tonight&quot; at 8pm" /><meta property="og:image" content="https://x.fbcdn.net/p.jpg">';
  assert.strictEqual(s.metaTag(html, 'og:description'), 'Party "tonight" at 8pm');
  assert.strictEqual(s.metaTag(html, 'og:image'), 'https://x.fbcdn.net/p.jpg');
});

test('accepts social links only', () => {
  assert.strictEqual(s.checkUrl('instagram.com/p/ABC123/').hostname, 'instagram.com');
  assert.strictEqual(s.checkUrl('https://vm.tiktok.com/ZMabc/').hostname, 'vm.tiktok.com');
  assert.throws(() => s.checkUrl('http://localhost:3999/admin'), /Instagram, TikTok or Facebook/);
  assert.throws(() => s.checkUrl('https://evil.com/instagram.com'), /Instagram, TikTok or Facebook/);
  assert.throws(() => s.checkUrl(''), /Paste the link/);
});

test('explains that stories cannot be read', async () => {
  await assert.rejects(s.importPost('https://www.instagram.com/stories/rnbdancehalllovers/1234567890/'), /stories disappear/);
});
