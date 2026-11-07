(function () {
  'use strict';
  var R = window.RNB, el = R.el;
  var upcomingList = document.getElementById('upcomingList');

  function renderUpcoming(events, settings) {
    upcomingList.textContent = '';
    if (!events.length) {
      var ig = R.safeLink(settings.instagram_url);
      upcomingList.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1; margin-top:0;' }, [
        el('b', { text: 'New dates coming soon' }),
        'Follow us on Instagram to be the first to know about our next night.',
        el('br'),
        ig ? el('a', { class: 'btn btn-primary', href: ig, target: '_blank', rel: 'noopener', text: '@rnbdancehalllovers →' }) : null
      ]));
      return;
    }
    events.forEach(function (ev) { upcomingList.appendChild(R.eventCard(ev)); });
  }

  function renderExperience(photos) {
    if (!photos.length) return; // keep the built-in photos
    var row = document.getElementById('expRow');
    row.textContent = '';
    photos.forEach(function (p) {
      row.appendChild(el('a', { class: 'exp-card', href: '/gallery?category=experience' }, [
        el('div', { class: 'photo ph media', style: "background-image:url('" + R.mediaUrl(p.id, true) + "')", role: 'img', 'aria-label': p.caption || 'Experience photo' }),
        p.caption ? el('span', { class: 'cap', text: p.caption }) : null
      ]));
    });
  }

  function renderRecent(events) {
    if (!events.length) return; // keep the built-in photo cards
    var grid = document.getElementById('recentGrid');
    grid.textContent = '';
    events.forEach(function (ev) {
      var style = ev.cover_media_id ? "background-image:url('" + R.mediaUrl(ev.cover_media_id, true) + "')" : 'background:linear-gradient(135deg,#5b266c,#c11fd6)';
      grid.appendChild(el('a', { class: 'case-card ph media', href: '/events/' + ev.id, style: style }, [
        el('div', { class: 'meta' }, [ev.title, el('small', { text: R.fmtDay(ev.starts_at) + ' ' + R.fmtMonth(ev.starts_at) + (ev.venue ? ' · ' + ev.venue : '') })])
      ]));
    });
  }

  // Ticket cards: one per ticket link set in the admin panel. Falls back to
  // the site's own photos when no thumbnail has been uploaded.
  function renderTickets(s) {
    var grid = document.getElementById('ticketGrid');
    var fallback = { 1: '/img/p6.jpg', 2: '/img/p5.jpg' };
    var cards = [1, 2].map(function (n) {
      var url = R.safeLink(s['ticket' + n + '_url']);
      if (!url) return null;
      var img = s['ticket' + n + '_image'] ? R.mediaUrl(s['ticket' + n + '_image'], true) : fallback[n];
      var title = s['ticket' + n + '_title'] || 'RNB Dancehall Lovers';
      var host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
      return el('a', { class: 'ticket-card', href: url, target: '_blank', rel: 'noopener', 'aria-label': title + ': get tickets (opens ' + host + ')' }, [
        el('div', { class: 'ticket-thumb', style: "background-image:url('" + img + "')" }, [el('span', { class: 'ticket-chip', text: 'Tickets on sale' })]),
        el('div', { class: 'ticket-body' }, [
          el('div', { class: 'ticket-sub', text: s['ticket' + n + '_subtitle'] || host }),
          el('h3', { text: title }),
          el('span', { class: 'btn btn-primary', text: (s['ticket' + n + '_label'] || 'Get Tickets') + ' →' })
        ])
      ]);
    }).filter(Boolean);
    var section = document.getElementById('tickets');
    section.hidden = cards.length === 0;
    document.getElementById('heroTickets').hidden = cards.length === 0;
    grid.textContent = '';
    grid.classList.toggle('single', cards.length === 1);
    cards.forEach(function (c) { grid.appendChild(c); });
  }

  R.api('/api/home').then(function (data) {
    var s = data.settings || {};
    if (s.hero_text) document.getElementById('heroText').textContent = s.hero_text;
    if (s.about_text) document.getElementById('aboutText').textContent = s.about_text;
    R.renderFooter(s);
    renderTickets(s);
    renderUpcoming(data.upcoming || [], s);
    renderExperience(data.experience || []);
    renderRecent(data.past || []);
  }).catch(function () {
    upcomingList.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1; margin-top:0;' }, [
      el('b', { text: 'Events are loading slowly' }), 'Please refresh the page in a moment.'
    ]));
  });
})();
