'use strict';
// Every piece of fixed text on the public website, editable from the admin
// panel (Website text). Pages refer to a field as {{key}}; the server fills
// in the client's wording (or the default below) before sending the page.
// Fields marked client: true are also handed to the page's scripts
// (window.RNB.t), for text that the scripts build, such as the menu.
//
// Types:
//   line    one line of text
//   text    a paragraph; new lines are kept
//   heading big title; each new line starts a new line on the page and
//           *stars* around words colour them
//   list    one item per line

const FIELDS = [
  // ---------- every page ----------
  { key: 'site_name', page: 'Every page', section: 'Footer', label: 'Website name', type: 'line', def: 'RnB Dancehall Lovers', client: true, hint: 'Used in the footer, the browser tab and when links are shared.' },
  { key: 'nav_tickets', page: 'Every page', section: 'Menu', label: 'Menu: tickets', type: 'line', def: 'Tickets', client: true },
  { key: 'nav_upcoming', page: 'Every page', section: 'Menu', label: 'Menu: upcoming', type: 'line', def: 'Upcoming', client: true },
  { key: 'nav_events', page: 'Every page', section: 'Menu', label: 'Menu: events', type: 'line', def: 'Events', client: true },
  { key: 'nav_gallery', page: 'Every page', section: 'Menu', label: 'Menu: gallery', type: 'line', def: 'Gallery', client: true },
  { key: 'nav_experiences', page: 'Every page', section: 'Menu', label: 'Menu: experiences', type: 'line', def: 'Experiences', client: true },
  { key: 'footer_events', page: 'Every page', section: 'Footer', label: 'Footer: events heading', type: 'line', def: 'Events', client: true },
  { key: 'footer_upcoming', page: 'Every page', section: 'Footer', label: 'Footer: upcoming events link', type: 'line', def: 'Upcoming Events', client: true },
  { key: 'footer_past', page: 'Every page', section: 'Footer', label: 'Footer: past events link', type: 'line', def: 'Past Events', client: true },
  { key: 'footer_gallery', page: 'Every page', section: 'Footer', label: 'Footer: gallery link', type: 'line', def: 'Photo Gallery', client: true },
  { key: 'footer_experience', page: 'Every page', section: 'Footer', label: 'Footer: experience link', type: 'line', def: 'The Experience', client: true },
  { key: 'footer_visit', page: 'Every page', section: 'Footer', label: 'Footer: address heading', type: 'line', def: 'Visit', client: true },
  { key: 'footer_contact', page: 'Every page', section: 'Footer', label: 'Footer: contact heading', type: 'line', def: 'Contact', client: true },
  { key: 'footer_place', page: 'Every page', section: 'Footer', label: 'Footer: city after the © line', type: 'line', def: 'Harare, Zimbabwe', client: true },

  // ---------- home page ----------
  { key: 'home_title', page: 'Home page', section: 'Browser tab and sharing', label: 'Title in the browser tab', type: 'line', def: 'RnB Dancehall Lovers — Old Is the New Vibe' },
  { key: 'home_description', page: 'Home page', section: 'Browser tab and sharing', label: 'Description for Google and shared links', type: 'text', def: 'RnB Dancehall Lovers: R&B and dancehall events in Harare, Zimbabwe. See upcoming events, get tickets and browse photos from our nights.' },

  { key: 'hero_title', page: 'Home page', section: 'Header', label: 'Big title', type: 'heading', def: 'OLD IS THE\nNEW *VIBE*', hint: 'A new line starts a new line on the page. Put *stars* around words to make them purple.' },
  { key: 'hero_btn1', page: 'Home page', section: 'Header', label: 'First button', type: 'line', def: 'Get Tickets' },
  { key: 'hero_btn2', page: 'Home page', section: 'Header', label: 'Second button', type: 'line', def: 'Upcoming Events' },

  { key: 'intro1_eyebrow', page: 'Home page', section: 'Intro cards', label: 'Light card: small top line', type: 'line', def: 'RnB Dancehall Lovers' },
  { key: 'intro1_title', page: 'Home page', section: 'Intro cards', label: 'Light card: title', type: 'heading', def: 'OLD IS THE NEW VIBE.' },
  { key: 'intro1_sub', page: 'Home page', section: 'Intro cards', label: 'Light card: line under the title', type: 'line', def: '90s & 00s RnB • Dancehall • Old School Classics' },
  { key: 'intro1_btn1', page: 'Home page', section: 'Intro cards', label: 'Light card: first button', type: 'line', def: 'Get Tickets' },
  { key: 'intro1_btn2', page: 'Home page', section: 'Intro cards', label: 'Light card: second button', type: 'line', def: 'Upcoming Events' },
  { key: 'intro2_eyebrow', page: 'Home page', section: 'Intro cards', label: 'Dark card: small top line', type: 'line', def: 'Born in Zimbabwe' },
  { key: 'intro2_title', page: 'Home page', section: 'Intro cards', label: 'Dark card: title', type: 'heading', def: "MORE THAN MUSIC.\nIT'S A MOVEMENT." },
  { key: 'intro2_sub', page: 'Home page', section: 'Intro cards', label: 'Dark card: line under the title', type: 'line', def: 'Different ages. Different cultures. One love for music.' },

  { key: 'home_words', page: 'Home page', section: 'Word strip', label: 'Words in the strip under the intro cards', type: 'list', def: 'R&B\nDancehall\nSlow Jams\nRiddims\nThrowbacks\nLive DJs\nSound Systems\nHarare' },

  { key: 'upcoming_title1', page: 'Home page', section: 'Upcoming events', label: 'Title, first line (outlined)', type: 'line', def: 'UPCOMING' },
  { key: 'upcoming_title2', page: 'Home page', section: 'Upcoming events', label: 'Title, second line', type: 'line', def: 'EVENTS' },
  { key: 'upcoming_link', page: 'Home page', section: 'Upcoming events', label: 'Link to all events', type: 'line', def: 'View all events →' },
  { key: 'upcoming_empty_title', page: 'Home page', section: 'Upcoming events', label: 'When there are no upcoming events: title', type: 'line', def: 'New dates coming soon', client: true },
  { key: 'upcoming_empty_text', page: 'Home page', section: 'Upcoming events', label: 'When there are no upcoming events: text', type: 'text', def: 'Follow us on Instagram to be the first to know about our next night.', client: true },

  { key: 'tickets_title1', page: 'Home page', section: 'Tickets on sale', label: 'Title, first line (outlined)', type: 'line', def: 'TICKETS' },
  { key: 'tickets_title2', page: 'Home page', section: 'Tickets on sale', label: 'Title, second line', type: 'line', def: 'ON SALE' },
  { key: 'tickets_note', page: 'Home page', section: 'Tickets on sale', label: 'Note next to the title', type: 'text', def: "Secure your spot. You'll be taken to the official ticketing site to pay." },
  { key: 'ticket_btn', page: 'Home page', section: 'Tickets on sale', label: 'Button on tickets for your events', type: 'line', def: 'Get Tickets', client: true, hint: 'Events with a ticket link (Events page) show here by themselves until the event has happened.' },
  { key: 'ticket_chip', page: 'Home page', section: 'Tickets on sale', label: 'Label on the ticket pictures', type: 'line', def: 'Tickets on sale', client: true, hint: 'The ticket cards themselves (name, link, button) are under Website details.' },

  { key: 'exp_title1', page: 'Home page', section: 'The Experience', label: 'Title, first line (outlined)', type: 'line', def: 'THE' },
  { key: 'exp_title2', page: 'Home page', section: 'The Experience', label: 'Title, second line', type: 'line', def: 'EXPERIENCE' },
  { key: 'exp_link', page: 'Home page', section: 'The Experience', label: 'Link to the gallery', type: 'line', def: 'View all →' },
  { key: 'promo_title', page: 'Home page', section: 'The Experience', label: 'Pink banner: title', type: 'heading', def: 'ANY VIBE,\n*ANY NIGHT.*', accent: 'dark', hint: 'Put *stars* around words to make them black.' },
  { key: 'promo_text', page: 'Home page', section: 'The Experience', label: 'Pink banner: text', type: 'text', def: "Unleash infinite possibilities. Whether it's R&B slow jams or dancehall riddims, our lineups and sound are tailored to any crowd, any night. Let us find the perfect vibe to make your night unforgettable." },

  { key: 'merch_title', page: 'Home page', section: 'Merchandise', label: 'Title', type: 'heading', def: 'MERCHANDISE' },
  { key: 'merch_text', page: 'Home page', section: 'Merchandise', label: 'Text', type: 'text', def: 'Rep the movement. Official RnB Dancehall Lovers gear, from caps and tees to cups and ice buckets.' },
  { key: 'merch_btn', page: 'Home page', section: 'Merchandise', label: 'Button', type: 'line', def: 'See The Gallery →' },
  { key: 'merch_items', page: 'Home page', section: 'Merchandise', label: 'Items', type: 'list', def: 'Caps\nHats\nT-Shirts\nJackets\nTracksuits\nWaving Fingers\nCigars\nSocks\nCups\nIce Buckets\nKey Holders' },

  { key: 'recent_title1', page: 'Home page', section: 'Recent events', label: 'Title, first line (outlined)', type: 'line', def: 'RECENT' },
  { key: 'recent_title2', page: 'Home page', section: 'Recent events', label: 'Title, second line', type: 'line', def: 'EVENTS' },
  { key: 'recent_link', page: 'Home page', section: 'Recent events', label: 'Link to event history', type: 'line', def: 'Event history →' },
  { key: 'recent_cards', page: 'Home page', section: 'Recent events', label: 'Photo cards shown until you add past events', type: 'list', def: 'Crew Links | Bakerloo Bar\nPacked Out | Old Is The New Vibe\nCrowd Favorites | Palm Tree Terrace\nPhoto Wall | Step & Repeat\nOn The Dancefloor | Live Set\nSquad Goals | Matching Fits\nCognac Corner | Bakerloo Bar\nGood Times | Old Is The New Vibe', hint: 'One card per line: big words | small words. At most 8.' },

  { key: 'banner_1a', page: 'Home page', section: 'Big words banner', label: 'Line 1, before the arrows', type: 'line', def: 'HARARE' },
  { key: 'banner_1b', page: 'Home page', section: 'Big words banner', label: 'Line 1, after the arrows', type: 'line', def: 'LIVE' },
  { key: 'banner_2a', page: 'Home page', section: 'Big words banner', label: 'Line 2', type: 'line', def: 'R&B & DANCEHALL' },
  { key: 'banner_2b', page: 'Home page', section: 'Big words banner', label: 'Line 2, outlined word', type: 'line', def: 'LOVERS' },
  { key: 'banner_3', page: 'Home page', section: 'Big words banner', label: 'Line 3', type: 'line', def: 'UNFORGETTABLE NIGHTS' },
  { key: 'banner_4', page: 'Home page', section: 'Big words banner', label: 'Line 4 (outlined)', type: 'line', def: 'SINCE 2025' },
  { key: 'banner_scroll', page: 'Home page', section: 'Big words banner', label: 'Moving words under the banner', type: 'line', def: 'VIBE & CONNECT →' },

  { key: 'join1_words', page: 'Home page', section: 'Bottom panels', label: 'Left panel: moving words', type: 'list', def: 'JOIN US →\nBOOK YOUR NIGHT →' },
  { key: 'join1_btn', page: 'Home page', section: 'Bottom panels', label: 'Left panel: button', type: 'line', def: 'Get tickets →' },
  { key: 'join2_words', page: 'Home page', section: 'Bottom panels', label: 'Right panel: moving words', type: 'list', def: 'OUR EVENTS →\nSEE THE PHOTOS →' },
  { key: 'join2_btn', page: 'Home page', section: 'Bottom panels', label: 'Right panel: button', type: 'line', def: 'See the photos →' },

  // ---------- events ----------
  { key: 'back_home', page: 'Events page', section: 'Top of the page', label: '"Back to home" link', type: 'line', def: '← Back to home' },
  { key: 'events_title1', page: 'Events page', section: 'Top of the page', label: 'Title, first line (outlined)', type: 'line', def: 'ALL' },
  { key: 'events_title2', page: 'Events page', section: 'Top of the page', label: 'Title, second line', type: 'line', def: 'EVENTS' },
  { key: 'events_tab_upcoming', page: 'Events page', section: 'Top of the page', label: 'Upcoming tab and heading', type: 'line', def: 'Upcoming' },
  { key: 'events_tab_past', page: 'Events page', section: 'Top of the page', label: 'History tab and heading', type: 'line', def: 'Event history' },
  { key: 'events_past_text', page: 'Events page', section: 'Event lists', label: 'Text above past events', type: 'text', def: 'Every past event, with its photos. Events show on the home page for 30 days, then live here.' },
  { key: 'events_empty_upcoming', page: 'Events page', section: 'Event lists', label: 'When there are no upcoming events', type: 'line', def: 'No upcoming events yet. New dates coming soon.', client: true },
  { key: 'events_empty_past', page: 'Events page', section: 'Event lists', label: 'When there are no past events', type: 'line', def: 'No past events added yet.', client: true },
  { key: 'event_back', page: 'Events page', section: 'One event', label: '"All events" link', type: 'line', def: '← All events' },
  { key: 'event_photos', page: 'Events page', section: 'One event', label: 'Photos heading', type: 'line', def: 'Photos' },
  { key: 'event_tag_upcoming', page: 'Events page', section: 'One event', label: 'Label for an upcoming event', type: 'line', def: 'Upcoming', client: true },
  { key: 'event_tag_past', page: 'Events page', section: 'One event', label: 'Label for a past event', type: 'line', def: 'Past event', client: true },
  { key: 'tables_btn', page: 'Events page', section: 'One event', label: 'Table booking button', type: 'line', def: 'Buy Tables', client: true, hint: 'Shows on events that have a tables link (Admin → Events).' },
  { key: 'flyer_tag_tickets', page: 'Events page', section: 'One event', label: 'Label on the tickets flyer', type: 'line', def: 'Tickets', client: true },
  { key: 'flyer_tag_tables', page: 'Events page', section: 'One event', label: 'Label on the tables flyer', type: 'line', def: 'Tables', client: true },
  { key: 'event_ticket_btn', page: 'Events page', section: 'One event', label: 'Ticket button', type: 'line', def: 'Get Tickets →', client: true },

  // ---------- gallery ----------
  { key: 'gallery_title1', page: 'Gallery page', section: 'Top of the page', label: 'Title, first line (outlined)', type: 'line', def: 'PHOTO' },
  { key: 'gallery_title2', page: 'Gallery page', section: 'Top of the page', label: 'Title, second line', type: 'line', def: 'GALLERY' },
  { key: 'gallery_tab_all', page: 'Gallery page', section: 'Top of the page', label: 'Tab: all photos', type: 'line', def: 'All photos' },
  { key: 'gallery_tab_experience', page: 'Gallery page', section: 'Top of the page', label: 'Tab: the experience', type: 'line', def: 'The Experience' },
  { key: 'gallery_tab_event', page: 'Gallery page', section: 'Top of the page', label: 'Tab: event photos', type: 'line', def: 'Event photos' },
  { key: 'gallery_tab_highlights', page: 'Gallery page', section: 'Top of the page', label: 'Tab: highlights', type: 'line', def: 'Highlights' },
  { key: 'gallery_this_month', page: 'Gallery page', section: 'Photos', label: 'Heading for this month', type: 'line', def: 'This month', client: true },
  { key: 'gallery_last_month', page: 'Gallery page', section: 'Photos', label: 'Heading for last month', type: 'line', def: 'Last month', client: true },
  { key: 'photo_download', page: 'Gallery page', section: 'Photos', label: 'Photo viewer: download button', type: 'line', def: 'Download', client: true },
  { key: 'photo_share', page: 'Gallery page', section: 'Photos', label: 'Photo viewer: share button', type: 'line', def: 'Share', client: true },
  { key: 'gallery_empty', page: 'Gallery page', section: 'Photos', label: 'When a tab has no photos', type: 'line', def: 'No photos here yet.', client: true },

  // ---------- 404 ----------
  { key: 'notfound_title', page: '"Page not found" page', section: 'Whole page', label: 'Title', type: 'heading', def: 'LOST THE RIDDIM?' },
  { key: 'notfound_text', page: '"Page not found" page', section: 'Whole page', label: 'Text', type: 'text', def: "That page doesn't exist. Head back to the home page or check out our events." },
  { key: 'notfound_btn1', page: '"Page not found" page', section: 'Whole page', label: 'First button', type: 'line', def: 'Home' },
  { key: 'notfound_btn2', page: '"Page not found" page', section: 'Whole page', label: 'Second button', type: 'line', def: 'Events' },
];

// Where each section is on the website, for the admin panel's live preview:
// the page to open and the part of it to show (a CSS selector). Sections
// without a url are edited as a form (they aren't visible on the page).
const SECTIONS = [
  { page: 'Every page', section: 'Menu', url: '/events', show: 'header' },
  { page: 'Every page', section: 'Footer', url: '/', show: 'footer' },
  { page: 'Home page', section: 'Browser tab and sharing', url: null, show: null },
  { page: 'Home page', section: 'Header', url: '/', show: '.hero', hero: true },
  { page: 'Home page', section: 'Intro cards', url: '/', show: '.intro-cards' },
  { page: 'Home page', section: 'Word strip', url: '/', show: '.logos' },
  { page: 'Home page', section: 'Upcoming events', url: '/', show: '#upcoming' },
  { page: 'Home page', section: 'Tickets on sale', url: '/', show: '#tickets' },
  { page: 'Home page', section: 'The Experience', url: '/', show: '#experience' },
  { page: 'Home page', section: 'Merchandise', url: '/', show: '.custom-exp' },
  { page: 'Home page', section: 'Recent events', url: '/', show: '#cases' },
  { page: 'Home page', section: 'Big words banner', url: '/', show: '.stat-banner' },
  { page: 'Home page', section: 'Bottom panels', url: '/', show: '.join' },
  { page: 'Events page', section: 'Top of the page', url: '/events', show: '.page-head' },
  { page: 'Events page', section: 'Event lists', url: '/events', show: '#upcoming, #past' },
  { page: 'Events page', section: 'One event', url: '/events/:event', show: 'main' },
  { page: 'Gallery page', section: 'Top of the page', url: '/gallery', show: '.page-head' },
  { page: 'Gallery page', section: 'Photos', url: '/gallery', show: '#grid, #status' },
  { page: '"Page not found" page', section: 'Whole page', url: '/rnb-page-that-is-not-there', show: 'main' },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const MAX = { line: 200, text: 2000, heading: 200, list: 2000 };
const RECENT_PHOTOS = ['p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function lines(v) { return String(v).split('\n').map((l) => l.trim()).filter(Boolean); }

// Big titles: new lines become line breaks, *word* gets the accent colour.
function heading(v, accent) {
  const open = accent === 'dark' ? '<span style="color:#141108">' : '<span class="accent">';
  return lines(v).map((l) => esc(l).replace(/\*([^*]+)\*/g, `${open}$1</span>`).replace(/\*/g, '')).join('<br>');
}

// Special layouts for some lists.
const RENDER = {
  home_words: (v) => lines(v).map((w) => `<span>${esc(w)}</span>`).join(''),
  merch_items: (v) => lines(v).map((w) => `<div class="pill">${esc(w)}</div>`).join(''),
  recent_cards: (v) => lines(v).slice(0, 8).map((l, i) => {
    const [big, small = ''] = l.split('|').map((x) => x.trim());
    return `<div class="case-card ph ${RECENT_PHOTOS[i]}"><div class="meta">${esc(big)}<small>${esc(small)}</small></div></div>`;
  }).join(''),
  banner_scroll: (v) => Array(8).fill(`<span>${esc(v)}</span>`).join(''),
  join1_words: (v) => repeat(v),
  join2_words: (v) => repeat(v),
};
function repeat(v) {
  const words = lines(v);
  if (!words.length) return '';
  const out = [];
  while (out.length < 8) out.push(...words);
  return out.slice(0, Math.max(8, words.length)).map((w) => `<span>${esc(w)}</span>`).join('');
}

// HTML for one field, given its current value.
function render(field, value) {
  if (RENDER[field.key]) return RENDER[field.key](value);
  if (field.type === 'heading') return heading(value, field.accent);
  if (field.type === 'text') return lines(value).map(esc).join('<br>');
  if (field.type === 'list') return lines(value).map(esc).join(', ');
  return esc(value);
}

// The value to use: the client's own words, else the default.
function valueOf(field, saved) {
  const v = saved[field.key];
  return typeof v === 'string' && v.trim() !== '' ? v : field.def;
}

// Fills {{key}} placeholders in a page. Unknown keys are left out.
// With edit: true (the admin panel's preview), text shown on the page is
// wrapped in <span data-rnb-k="key"> so it can be tapped and edited; text in
// tags, the tab title and scripts is filled in as usual.
const RAW_TAGS = /^<(title|script|style|textarea)\b/i;
const RAW_END = /^<\/(title|script|style|textarea)\b/i;
function fillPage(html, saved, opts) {
  const fill = (key) => {
    const f = BY_KEY.get(key);
    return f ? render(f, valueOf(f, saved)) : '';
  };
  if (!opts || !opts.edit) return html.replace(/\{\{([a-z0-9_]+)\}\}/g, (m, key) => fill(key));
  let raw = false;
  return html.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      if (RAW_TAGS.test(part)) raw = true;
      else if (RAW_END.test(part)) raw = false;
      return part.replace(/\{\{([a-z0-9_]+)\}\}/g, (m, key) => fill(key));
    }
    return part.replace(/\{\{([a-z0-9_]+)\}\}/g, (m, key) => {
      if (raw || !BY_KEY.has(key)) return fill(key);
      // Lists with their own layout keep it: the wrapper takes no space.
      const cls = RENDER[key] ? ' class="rnb-k-box"' : '';
      return `<span data-rnb-k="${key}"${cls}>${fill(key)}</span>`;
    });
  }).join('');
}

// Words the page scripts need, as plain text.
function clientText(saved) {
  const out = {};
  for (const f of FIELDS) if (f.client) out[f.key] = valueOf(f, saved);
  return out;
}

// Checks and tidies text sent from the admin panel. Returns the cleaned value,
// or throws with a message for the person.
function clean(field, value) {
  if (typeof value !== 'string') throw Object.assign(new Error(`${field.label}: please type some text.`), { status: 400 });
  let v = value.replace(/\r\n?/g, '\n');
  if (field.type === 'line') v = v.replace(/\s*\n\s*/g, ' ');
  v = v.split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').trim();
  if (v.length > MAX[field.type]) {
    throw Object.assign(new Error(`${field.label}: please keep it under ${MAX[field.type]} characters.`), { status: 400 });
  }
  return v;
}

module.exports = { FIELDS, SECTIONS, BY_KEY, fillPage, clientText, clean, valueOf, render };
