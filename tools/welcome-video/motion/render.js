// Renders the motion-graphic layers and the animated title cards.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const STAGE = 'file://' + path.join(HERE, 'stage.html');
const VID = path.join(HERE, '..', 'video');
const old = JSON.parse(fs.readFileSync(path.join(VID, 'manifest.json')));
const FPS = 30;

const TITLES = {
  '02-home': ['The website', '1 / 7', 'Your <b>home page</b>'],
  '03-tickets': ['The website', '2 / 7', 'Tickets <b>on sale</b>'],
  '04-upcoming': ['The website', '3 / 7', 'Upcoming <b>events</b>'],
  '05-vibe': ['The website', '4 / 7', 'Slideshows <b>everywhere</b>'],
  '06-gallery': ['The website', '5 / 7', 'Recent events <b>&amp; gallery</b>'],
  '07-event': ['The website', '6 / 7', 'A page for <b>every event</b>'],
  '08-contact': ['The website', '7 / 7', 'Easy to <b>reach you</b>'],
  '10-login': ['Your admin panel', '1 / 6', 'Log <b>in</b>'],
  '11-overview': ['Your admin panel', '2 / 6', 'Everything <b>at a glance</b>'],
  '12-add-event': ['Your admin panel', '3 / 6', 'Add an event <b>in seconds</b>'],
  '13-event-photos': ['Your admin panel', '4 / 6', 'Photos <b>from the night</b>'],
  '14-photos': ['Your admin panel', '5 / 6', 'Your <b>website photos</b>'],
  '15-details': ['Your admin panel', '6 / 6', 'Words, pictures <b>&amp; tickets</b>'],
};
const CARDS = { '01-welcome': 'welcome', '09-capabilities': 'capabilities', '16-goodbye': 'goodbye' };

(async () => {
  const b = await chromium.launch();
  const out = path.join(HERE, 'layers');
  fs.mkdirSync(out, { recursive: true });
  const shot = async (params, file, size = { width: 1280, height: 720 }, transparent = true) => {
    const p = await b.newPage({ viewport: size });
    await p.goto(STAGE + '#' + encodeURIComponent(JSON.stringify(params)));
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(out, file), omitBackground: transparent });
    await p.close();
  };
  await shot({ mode: 'bg' }, 'bg.png', undefined, false);
  await shot({ mode: 'bezel', url: 'rnbdancehalllovers.co.zw' }, 'bezel-site.png', { width: 960, height: 600 });
  await shot({ mode: 'bezel', url: 'rnbdancehalllovers.co.zw/admin' }, 'bezel-admin.png', { width: 960, height: 600 });
  await shot({ mode: 'mask' }, 'mask.png', { width: 880, height: 495 }, false);
  for (const [id, [chip, count, title]] of Object.entries(TITLES)) {
    await shot({ mode: 'title', chip, count, title }, `title-${id}.png`);
  }
  console.log('layers done');

  // Title cards: step the animation frame by frame for smooth, sharp motion.
  for (const [id, scene] of Object.entries(CARDS)) {
    const len = old[id].len;
    const dir = path.join(HERE, 'frames', id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(STAGE + '#' + encodeURIComponent(JSON.stringify({ mode: 'card', scene })));
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(500);
    const n = Math.round(len * FPS);
    for (let i = 0; i < n; i++) {
      await p.evaluate(t => window.__seek(t), i / FPS);
      await p.screenshot({ path: path.join(dir, String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 92 });
    }
    await p.close();
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(dir, '%05d.jpg'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', path.join(HERE, `card-${id}.mp4`)]);
    console.log('card', id, n, 'frames');
  }
  await b.close();
})();
