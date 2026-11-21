'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const content = require('../content');
const auth = require('../auth');

test('every {{placeholder}} in the pages is a known field', () => {
  const dir = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of html.matchAll(/\{\{([a-z0-9_]+)\}\}/g)) assert.ok(content.BY_KEY.has(m[1]), `${f}: ${m[1]}`);
  }
});

test('typed text can never become HTML', () => {
  const out = content.fillPage('<h1>{{hero_title}}</h1><p>{{promo_text}}</p>', {
    hero_title: 'A *B* <img src=x onerror=alert(1)>', promo_text: '"x" & <b>',
  });
  assert.strictEqual(out, '<h1>A <span class="accent">B</span> &lt;img src=x onerror=alert(1)&gt;</h1><p>&quot;x&quot; &amp; &lt;b&gt;</p>');
});

test('empty saved text falls back to the original words', () => {
  assert.strictEqual(content.fillPage('{{nav_events}}', { nav_events: '  ' }), 'Events');
  assert.strictEqual(content.clientText({}).site_name, 'RnB Dancehall Lovers');
});

test('lists and cards render one item per line', () => {
  assert.strictEqual(content.fillPage('{{merch_items}}', { merch_items: 'Caps\n\nHats ' }), '<div class="pill">Caps</div><div class="pill">Hats</div>');
  assert.match(content.fillPage('{{recent_cards}}', { recent_cards: 'Big | small' }), /Big<small>small<\/small>/);
});

test('passwords: hashing, checking and rules', async () => {
  const h = await auth.hashPassword('riddims on a friday');
  assert.ok(await auth.verifyPassword('riddims on a friday', h));
  assert.ok(!(await auth.verifyPassword('riddims on a friday!', h)));
  assert.ok(!(await auth.verifyPassword('anything', null)));
  assert.ok(auth.passwordProblem('short', 'a@b.co'));
  assert.ok(auth.passwordProblem('Password123', 'a@b.co'));
  assert.ok(auth.passwordProblem('tendai-2026-xyz', 'tendai@b.co'));
  assert.strictEqual(auth.passwordProblem('sweet jams every saturday', 'tendai@b.co'), '');
});
