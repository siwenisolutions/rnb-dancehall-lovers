'use strict';
// Helps Google find and understand the site:
// - robots.txt and sitemap.xml (every page, event and shop item),
// - a canonical address on each page (the main domain, not onrender.com),
// - schema.org data: who RnB Dancehall Lovers are (with their Instagram,
//   Facebook, TikTok and WhatsApp channel, so Google links the website to
//   those profiles), their upcoming events (can show in Google's event
//   listings) and shop items,
// - real titles and descriptions for event pages (built in the browser
//   otherwise, which Google may not wait for),
// - the Google Search Console verification tag, when set in the admin panel.

const NAMES = ['RnB Dancehall Lovers', 'R&B Dancehall Lovers', 'RNB Dancehall Lovers', "R'n'B Dancehall Lovers", 'Dancehall Lovers', 'RnB Dancehall Lovers Zimbabwe'];

module.exports = function seo({ pool, siteUrl, getSettings, eventColumns, UPCOMING }) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // JSON inside <script>: "<" can't end the script early.
  const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  const abs = (p) => siteUrl() + p;
  const media = (id) => abs(`/media/${id}.webp`);

  function organization(s, siteName) {
    const sameAs = ['instagram_url', 'facebook_url', 'tiktok_url', 'youtube_url', 'whatsapp_url'].map((k) => s[k]).filter((u) => /^https?:\/\//.test(u || ''));
    return {
      '@type': 'Organization',
      '@id': abs('/#organization'),
      name: siteName,
      alternateName: NAMES.filter((n) => n !== siteName),
      url: abs('/'),
      logo: abs('/img/logo.png'),
      slogan: 'Old is the new vibe',
      description: 'R&B and dancehall events in Zimbabwe celebrating 90s and 2000s music.',
      sameAs,
      email: s.contact_email || undefined,
      telephone: s.phone ? `+263${s.phone.replace(/\D/g, '').replace(/^(263|0)/, '')}` : undefined,
      address: s.address ? { '@type': 'PostalAddress', streetAddress: s.address, addressCountry: 'ZW' } : undefined,
    };
  }

  function eventLd(e, siteName) {
    const place = e.venue && !/^tba$/i.test(e.venue) ? e.venue : 'To be announced';
    return {
      '@type': 'Event',
      name: e.title,
      startDate: new Date(e.starts_at).toISOString(),
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: { '@type': 'Place', name: place, address: { '@type': 'PostalAddress', addressLocality: place, addressCountry: 'ZW' } },
      image: e.cover_media_id ? [media(e.cover_media_id)] : [abs('/img/logo.png')],
      description: e.description || `${siteName}: an R&B and dancehall night.`,
      url: abs(`/events/${e.id}`),
      organizer: { '@type': 'Organization', name: siteName, url: abs('/') },
      performer: { '@type': 'PerformingGroup', name: siteName },
      offers: e.ticket_url ? { '@type': 'Offer', url: e.ticket_url, availability: 'https://schema.org/InStock' } : undefined,
    };
  }

  // Extra tags for one page: canonical address, Google verification, schema.org.
  async function head(file, req, saved) {
    const s = await getSettings();
    const siteName = saved.site_name || 'RnB Dancehall Lovers';
    const path = file === 'index.html' ? '/' : req.path.replace(/\/+$/, '') || '/';
    const out = { tags: [], title: null, description: null, image: null };
    if (file !== '404.html') out.tags.push(`<link rel="canonical" href="${esc(abs(path))}">`);
    const code = String(s.google_verification || '').trim();
    if (code && file === 'index.html') out.tags.push(`<meta name="google-site-verification" content="${esc(code)}">`);
    const graph = [organization(s, siteName)];
    if (file === 'index.html') {
      graph.push({ '@type': 'WebSite', '@id': abs('/#website'), name: siteName, alternateName: NAMES.filter((n) => n !== siteName), url: abs('/'), publisher: { '@id': abs('/#organization') } });
    }
    const fmt = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Harare', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
    // Plain HTML versions of the event lists, in the page itself, so search
    // engines see them without running the page's scripts (which replace them).
    const card = (e) => `<article class="event-card"><a href="/events/${e.id}">${e.cover_media_id ? `<img src="/media/${e.cover_media_id}.webp?size=thumb" alt="${esc(e.title)}" loading="lazy" style="width:100%;aspect-ratio:4/5;object-fit:cover;display:block">` : ''}</a><div class="body"><h3><a href="/events/${e.id}">${esc(e.title)}</a></h3><div class="when">${esc(fmt(e.starts_at))}</div>${e.venue ? `<div class="when">${esc(e.venue)}</div>` : ''}</div></article>`;
    if (file === 'index.html' || file === 'events.html') {
      const { rows } = await pool.query(`SELECT ${eventColumns} FROM events e WHERE ${UPCOMING} ORDER BY e.starts_at LIMIT 10`);
      rows.forEach((e) => graph.push(eventLd(e, siteName)));
      out.lists = { upcomingList: rows.map(card).join('') };
      if (file === 'events.html') {
        const past = await pool.query(`SELECT ${eventColumns} FROM events e WHERE NOT (${UPCOMING}) ORDER BY e.starts_at DESC LIMIT 30`);
        out.lists.pastList = past.rows.map(card).join('');
      }
    }
    if (file === 'event.html') {
      const id = parseInt((/^\/events\/(\d+)/.exec(req.path) || [])[1], 10);
      if (id) {
        const { rows } = await pool.query(`SELECT ${eventColumns} FROM events e WHERE e.id = $1`, [id]);
        const e = rows[0];
        if (e) {
          graph.push(eventLd(e, siteName));
          const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Harare', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(e.starts_at));
          out.title = `${e.title} — ${siteName}`;
          out.description = `${when}${e.venue ? ` · ${e.venue}` : ''}. ${e.description || `${siteName}: R&B and dancehall, old school classics.`}`.slice(0, 300);
          out.image = e.cover_media_id ? media(e.cover_media_id) : null;
          out.lists = { detail: `<div class="event-detail">${e.cover_media_id ? `<img src="/media/${e.cover_media_id}.webp" alt="${esc(e.title)} flyer" style="width:100%;border-radius:18px">` : ''}<div><h1 class="display">${esc(e.title)}</h1><div class="when">${esc(fmt(e.starts_at))}</div>${e.venue ? `<div class="venue">${esc(e.venue)}</div>` : ''}${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}${e.ticket_url ? `<a class="btn btn-primary" href="${esc(e.ticket_url)}" rel="noopener">Get Tickets →</a>` : ''}</div></div>` };
        }
      }
    }
    if (file === 'shop.html') {
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.description, p.price_cents,
                (SELECT m.id FROM media m WHERE m.product_id = p.id ORDER BY m.created_at, m.id LIMIT 1) AS photo
           FROM products p WHERE p.active ORDER BY p.sort, p.id LIMIT 30`);
      rows.forEach((p) => graph.push({
        '@type': 'Product', name: p.name, description: p.description || `${siteName} merchandise`,
        image: p.photo ? [media(p.photo)] : undefined, brand: { '@type': 'Brand', name: siteName },
        url: abs(`/shop?item=${p.id}`),
        offers: { '@type': 'Offer', price: (p.price_cents / 100).toFixed(2), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: abs(`/shop?item=${p.id}`) },
      }));
    }
    out.tags.push(`<script type="application/ld+json">${json({ '@context': 'https://schema.org', '@graph': graph })}</script>`);
    return out;
  }

  function robots() {
    // The pages load their events and photos from /api/, so Google must be
    // able to read it (only the admin side is off limits).
    return `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/admin/\n\nSitemap: ${abs('/sitemap.xml')}\n`;
  }

  async function sitemap() {
    const urls = [
      { loc: '/', freq: 'daily', pri: '1.0' },
      { loc: '/events', freq: 'daily', pri: '0.9' },
      { loc: '/shop', freq: 'weekly', pri: '0.8' },
      { loc: '/gallery', freq: 'weekly', pri: '0.7' },
    ];
    const ev = await pool.query('SELECT id, created_at, starts_at FROM events ORDER BY starts_at DESC LIMIT 500');
    ev.rows.forEach((e) => urls.push({ loc: `/events/${e.id}`, freq: new Date(e.starts_at) > new Date() ? 'daily' : 'monthly', pri: '0.6' }));
    const body = urls.map((u) => `  <url><loc>${esc(abs(u.loc))}</loc><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  }

  return { head, robots, sitemap, esc };
};
