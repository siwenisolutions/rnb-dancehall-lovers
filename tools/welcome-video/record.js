// Records each scene of the welcome video as its own clip, timed to its narration.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const BASE = 'http://localhost:3999';
const IMG = '/home/user/rnb-dancehall-lovers/public/img';
const scenes = JSON.parse(fs.readFileSync(path.join(HERE, 'scenes.json')));
const durations = JSON.parse(fs.readFileSync(path.join(HERE, 'durations.json')));
const only = process.argv[2] ? process.argv[2].split(',') : null;
const W = 1280, H = 720;

// Pointer + caption overlay, injected into every page.
const OVERLAY = `
(() => {
  try { localStorage.setItem('rnbWelcomeHidden', '1'); } catch (e) {}
  const add = () => {
    if (document.getElementById('demo-cursor')) return;
    const st = document.createElement('style');
    st.textContent = \`
      #demo-cursor{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
        background:rgba(193,31,214,.35);border:3px solid #c11fd6;z-index:2147483647;pointer-events:none;
        transition:transform .65s cubic-bezier(.4,.1,.2,1), scale .15s ease;box-shadow:0 0 0 6px rgba(193,31,214,.12)}
      #demo-cursor.press{scale:.7}
      #demo-caption{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:1000px;width:max-content;
        background:rgba(20,18,16,.86);color:#fff;font:600 21px/1.35 Archivo,Arial,sans-serif;padding:12px 22px;border-radius:16px;
        z-index:2147483646;pointer-events:none;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.3)}
      #demo-caption:empty{display:none}
      html{scroll-behavior:auto !important}
    \`;
    document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.style.transform = 'translate(' + (innerWidth * 0.62) + 'px,' + (innerHeight * 0.55) + 'px)';
    const cap = document.createElement('div'); cap.id = 'demo-caption';
    cap.textContent = sessionStorage.getItem('demoCap') || '';
    document.body.appendChild(c); document.body.appendChild(cap);
  };
  window.__caption = t => { sessionStorage.setItem('demoCap', t); const el = document.getElementById('demo-caption'); if (el) el.textContent = t; };
  window.__cursorTo = (x, y) => { const c = document.getElementById('demo-cursor'); if (c) c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  window.__press = () => { const c = document.getElementById('demo-cursor'); if (!c) return; c.classList.add('press'); setTimeout(() => c.classList.remove('press'), 180); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();`;

const wait = (p, ms) => p.waitForTimeout(ms);

async function point(page, sel, { click = false, dx = 0.5, dy = 0.5, noScroll = false } = {}) {
  const loc = page.locator(sel).first();
  if (!noScroll) await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  const b = await loc.boundingBox();
  if (!b) return;
  const x = b.x + b.width * dx, y = b.y + b.height * dy;
  await page.evaluate(([x, y]) => window.__cursorTo(x, y), [x, y]);
  await wait(page, 700);
  if (click) {
    await page.evaluate(() => window.__press());
    await page.mouse.click(x, y);
    await wait(page, 250);
  }
}

// Smooth, slow scroll so the movement reads well on video.
async function scrollTo(page, target, ms = 1600, offset = 90) {
  await page.evaluate(([target, ms, offset]) => new Promise(res => {
    const y0 = scrollY;
    const el = typeof target === 'string' ? document.querySelector(target) : null;
    const y1 = el ? el.getBoundingClientRect().top + scrollY - offset : target;
    const t0 = performance.now();
    const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const step = now => {
      const t = Math.min(1, (now - t0) / ms);
      scrollTo(0, y0 + (y1 - y0) * ease(t));
      t < 1 ? requestAnimationFrame(step) : res();
    };
    requestAnimationFrame(step);
  }), [target, ms, offset]);
}
async function jumpTo(page, sel, offset = 90) {
  await page.evaluate(([sel, offset]) => { const el = document.querySelector(sel); scrollTo(0, el.getBoundingClientRect().top + scrollY - offset); }, [sel, offset]);
}
async function type(page, sel, text, delay = 55) {
  await point(page, sel, { click: true });
  await page.locator(sel).pressSequentially(text, { delay });
}

const card = (body, extraCss = '') => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;overflow:hidden;font-family:Archivo,sans-serif;color:#fff;
  background:radial-gradient(1200px 600px at 15% 10%,#c11fd6 0%,transparent 60%),radial-gradient(900px 600px at 95% 100%,#ff5c7e 0%,transparent 55%),#141210;
  display:flex;align-items:center;justify-content:center}
.wrap{text-align:center;max-width:1050px;padding:0 40px}
.logo{width:150px;margin:0 auto 26px;animation:pop .9s cubic-bezier(.2,1.4,.4,1) both}
h1{font-family:Anton,sans-serif;font-weight:400;text-transform:uppercase;font-size:76px;line-height:.95;animation:up .9s .25s both}
h1 span{color:#ffe95f}
p.sub{margin-top:20px;font-size:24px;color:#efe7f2;animation:up .9s .55s both}
.chip{display:inline-block;margin-top:28px;background:#aaff5f;color:#0f2400;font-weight:800;padding:12px 22px;border-radius:999px;font-size:18px;animation:up .9s .85s both}
@keyframes up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
${extraCss}
</style></head><body>${body}</body></html>`;

const SCENES = {
  '01-welcome': {
    html: card(`<div class="wrap"><img class="logo" src="${BASE}/img/logo.png">
      <h1>Welcome to <span>RNB Dancehall Lovers</span></h1>
      <p class="sub">Your new website, built for you by Siweni Solutions</p>
      <div class="chip">Thank you for trusting Siweni ♥</div></div>`),
    run: async p => {}
  },
  '02-home': {
    url: '/',
    run: async p => {
      await wait(p, 1200);
      await point(p, '#heroTickets');
      await wait(p, 900);
      await point(p, '.hero-ctas .btn-outline');
      await wait(p, 1200);
      await scrollTo(p, '.make-merch', 2200, 40);
    }
  },
  '03-tickets': {
    url: '/', setup: async p => { await jumpTo(p, '.photo-row', 60); },
    run: async p => {
      await scrollTo(p, '#tickets', 1800);
      await wait(p, 800);
      await point(p, '.ticket-card >> nth=0', { dy: 0.4 });
      await wait(p, 1500);
      await point(p, '.ticket-card >> nth=1', { dy: 0.4 });
    }
  },
  '04-upcoming': {
    url: '/', setup: async p => { await jumpTo(p, '#tickets'); },
    run: async p => {
      await scrollTo(p, '#upcoming', 1800);
      await wait(p, 600);
      await point(p, '#upcomingList .event-card >> nth=0', { dy: 0.3 });
      await wait(p, 1200);
      await point(p, '#upcomingList .btn-primary >> nth=0');
    }
  },
  '05-vibe': {
    url: '/', setup: async p => { await jumpTo(p, '#experience'); },
    run: async p => {
      await wait(p, 1200);
      await scrollTo(p, '.custom-exp', 2600, 40);
      await point(p, '.pills .pill >> nth=3', { noScroll: true });
    }
  },
  '06-gallery': {
    url: '/', setup: async p => { await jumpTo(p, '#cases', 30); },
    run: async p => {
      await wait(p, 900);
      await point(p, '#cases .view-all');
      await wait(p, 700);
      await point(p, 'nav a[href="/gallery"]', { click: true });
      await p.waitForLoadState('networkidle');
      await wait(p, 900);
      await point(p, '.gallery-item >> nth=1', { click: true });
      await wait(p, 1500);
      await point(p, '.lb-next', { click: true });
    }
  },
  '07-event': {
    url: '/events/2',
    run: async p => {
      await wait(p, 1200);
      await point(p, '.event-detail h1');
      await wait(p, 800);
      await scrollTo(p, '#photosSection', 2200);
    }
  },
  '08-contact': {
    url: '/', setup: async p => { await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); },
    run: async p => {
      await wait(p, 600);
      await point(p, 'footer a[href^="mailto:"]');
      await wait(p, 900);
      await point(p, 'footer a[href^="tel:"]');
      await wait(p, 900);
      await point(p, 'footer .btn-cta');
    }
  },
  '09-capabilities': {
    html: card(`<div class="wrap" style="max-width:1160px">
      <h1 style="font-size:58px">What your website <span>can do</span></h1>
      <div class="grid">
        <div class="t" style="animation-delay:2.4s"><b>📱</b><span>Works on phones, tablets &amp; computers</span></div>
        <div class="t" style="animation-delay:5.6s"><b>👥</b><span>~100 people at the same moment<small>thousands of visitors a day</small></span></div>
        <div class="t" style="animation-delay:10.2s"><b>🚀</b><span>Upgradable in minutes<small>for bigger crowds</small></span></div>
        <div class="t" style="animation-delay:13.4s"><b>🎟️</b><span>Tickets via your partners<small>payments handled securely by them</small></span></div>
        <div class="t" style="animation-delay:18.6s"><b>📸</b><span>Thousands of photos<small>shrunk automatically</small></span></div>
        <div class="t" style="animation-delay:22.4s"><b>⚡</b><span>Changes go live instantly</span></div>
      </div></div>`,
      `.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:40px;text-align:left}
       .t{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:22px;padding:22px;display:flex;gap:14px;align-items:flex-start;opacity:0;animation:up .7s both}
       .t b{font-size:34px;line-height:1}
       .t span{font-weight:800;font-size:21px;line-height:1.25}
       .t small{display:block;font-weight:600;font-size:16px;color:#e6dbe9;margin-top:6px}`),
    run: async p => {}
  },
  '10-login': {
    url: '/admin', fresh: true,
    run: async p => {
      await wait(p, 900);
      await type(p, '#password', 'test-password-123', 70);
      await wait(p, 500);
      await point(p, '#loginForm button', { click: true });
      await wait(p, 2000);
    }
  },
  '11-overview': {
    url: '/admin',
    run: async p => {
      await wait(p, 900);
      await point(p, '.next-card', { dy: 0.25 });
      await wait(p, 1200);
      await point(p, '.tile-hot');
      await wait(p, 900);
      await point(p, '.chart-card', { dy: 0.6 });
      await wait(p, 900);
      await point(p, '#helpBtn');
    }
  },
  '12-add-event': {
    url: '/admin#events',
    run: async p => {
      await wait(p, 500);
      await type(p, '#evTitle', 'Summer Vibes', 60);
      await point(p, '#evStart', { click: false });
      await p.locator('#evStart').fill('2026-12-19T21:00');
      await wait(p, 400);
      await type(p, '#evVenue', 'Bakerloo Bar, Harare', 40);
      await type(p, '#evTicket', 'megaticket.africa/events/summer-vibes', 18);
      await wait(p, 300);
      await type(p, '#evDesc', 'Live DJs, R&B and dancehall all night.', 25);
      await point(p, '.drop-poster');
      await p.setInputFiles('#evPoster', path.join(IMG, 'p8.jpg'));
      await wait(p, 600);
      await point(p, '#evSubmit', { click: true });
      await wait(p, 2200);
      await point(p, '.ev-card >> nth=1', { dy: 0.4 });
    }
  },
  '13-event-photos': {
    url: '/admin#events',
    run: async p => {
      await wait(p, 600);
      await point(p, '.ev-card >> nth=1 >> .ev-actions button >> nth=1', { click: true });
      await wait(p, 1000);
      await point(p, '#photosDrawer .drop');
      await p.setInputFiles('#evPhotosInput', [path.join(IMG, 'p9.jpg'), path.join(IMG, 'p10.jpg'), path.join(IMG, 'p11.jpg')]);
      await wait(p, 600);
      await point(p, '#evPhotosUpload', { click: true });
      await p.waitForSelector('#eventPhotoGrid .ph >> nth=2', { timeout: 15000 }).catch(() => {});
      await wait(p, 600);
      await point(p, '#eventPhotoGrid .ph >> nth=1 >> text=Make cover');
    }
  },
  '14-photos': {
    url: '/admin#photos',
    run: async p => {
      await wait(p, 700);
      await point(p, '#photoCatSeg button >> nth=0');
      await wait(p, 900);
      await point(p, '#photoForm .drop');
      await wait(p, 900);
      await point(p, '#photoFilterSeg button >> nth=1', { click: true });
      await wait(p, 900);
      await point(p, '#photoGrid .ph >> nth=0 >> input');
      await wait(p, 900);
      await point(p, '#photoGrid .ph >> nth=0 >> .btn-danger');
    }
  },
  '15-details': {
    url: '/admin#details',
    run: async p => {
      await wait(p, 700);
      await point(p, '#s_hero_text');
      await wait(p, 700);
      await point(p, '#s_phone');
      await wait(p, 700);
      await point(p, '#s_instagram_url');
      await scrollTo(p, '.ticket-cards-edit', 2000, 120);
      await point(p, '.ticket-card-edit >> nth=0 >> .ticket-thumb-btn');
      await wait(p, 700);
      await point(p, '.save-bar .btn');
    }
  },
  '16-goodbye': {
    html: card(`<div class="wrap"><img class="logo" src="${BASE}/img/logo.png">
      <h1>Here's to many more <span>unforgettable nights</span></h1>
      <p class="sub">Watch this video again any time with the <b style="background:linear-gradient(135deg,#c11fd6,#ff5c7e);padding:4px 14px;border-radius:999px">Help</b> button in your admin panel</p>
      <div class="chip">Built with care by Siweni Solutions</div></div>`),
    run: async p => {}
  },
};

(async () => {
  const browser = await chromium.launch();
  const out = path.join(HERE, 'clips');
  fs.mkdirSync(out, { recursive: true });

  // Logged-in session for the admin scenes.
  const auth = await browser.newContext();
  const ap = await auth.newPage();
  await ap.goto(BASE + '/admin');
  await ap.fill('#password', 'test-password-123');
  await ap.click('#loginForm button');
  await ap.waitForTimeout(800);
  const state = await auth.storageState();
  await auth.close();

  const manifest = fs.existsSync(path.join(HERE, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'))) : {};
  for (const s of scenes) {
    if (only && !only.includes(s.id)) continue;
    const def = SCENES[s.id];
    const isAdmin = def.url && def.url.startsWith('/admin') && !def.fresh;
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      recordVideo: { dir: out, size: { width: W, height: H } },
      storageState: isAdmin ? state : undefined,
    });
    await ctx.addInitScript(OVERLAY);
    const t0 = Date.now();
    const page = await ctx.newPage();
    if (def.html) await page.setContent(def.html, { waitUntil: 'networkidle' });
    else await page.goto(BASE + def.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    if (def.setup) await def.setup(page);
    await page.waitForTimeout(400);
    if (!def.html) await page.evaluate(c => window.__caption(c), s.caption);
    const tReady = Date.now();
    const dur = durations[s.id] * 1000 + 900;
    await def.run(page, dur);
    const elapsed = Date.now() - tReady;
    if (elapsed < dur) await page.waitForTimeout(dur - elapsed);
    const len = Math.max(dur, Date.now() - tReady);
    const video = page.video();
    await ctx.close();
    const file = path.join(out, s.id + '.webm');
    fs.renameSync(await video.path(), file);
    manifest[s.id] = { file, offset: (tReady - t0) / 1000, len: len / 1000 };
    console.log(s.id, 'len', (len / 1000).toFixed(1), 'offset', ((tReady - t0) / 1000).toFixed(2));
  }
  fs.writeFileSync(path.join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 1));
  await browser.close();
})();
