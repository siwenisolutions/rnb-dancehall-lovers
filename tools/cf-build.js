'use strict';
// Build step for Cloudflare (run by wrangler before each deploy and by
// `wrangler dev`): bundles the HTML pages into generated/pages.js with
// "?v=<content hash>" on their CSS/JS links. The HTML files themselves are
// left out of the static assets (public/.assetsignore) so every page goes
// through the Worker, which fills in the website text.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PUBLIC = path.join(root, 'public');
const ASSET_LINK = /(href|src)="(\/(?:css|js)\/[^"?]+)"/g;

const versions = {};
for (const dir of ['css', 'js']) {
  for (const f of fs.readdirSync(path.join(PUBLIC, dir))) {
    const p = `/${dir}/${f}`;
    versions[p] = crypto.createHash('md5').update(fs.readFileSync(path.join(PUBLIC, dir, f))).digest('hex').slice(0, 10);
  }
}
const html = {};
for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.html'))) {
  html[f] = fs.readFileSync(path.join(PUBLIC, f), 'utf8')
    .replace(ASSET_LINK, (m, attr, p) => `${attr}="${p}?v=${versions[p] || '0'}"`);
}
fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
fs.writeFileSync(path.join(root, 'generated', 'pages.js'),
  `// Made by tools/cf-build.js. Do not edit.\nmodule.exports = ${JSON.stringify({ versions, html })};\n`);
console.log(`[build] ${Object.keys(html).length} pages, ${Object.keys(versions).length} versioned files`);
