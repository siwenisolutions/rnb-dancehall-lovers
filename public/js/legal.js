/* Policy pages: fill in the contact details from the site settings. */
(function () {
  'use strict';
  var R = window.RNB;
  R.api('/api/settings').then(function (s) {
    document.querySelectorAll('.legal-contacts [data-s]').forEach(function (li) {
      var v = s && s[li.getAttribute('data-s')];
      if (!v) return;
      var a = li.querySelector('a'), span = li.querySelector('span');
      if (a) {
        a.textContent = v;
        a.href = li.getAttribute('data-s') === 'contact_email' ? 'mailto:' + v : 'https://wa.me/' + String(v).replace(/\D/g, '').replace(/^0/, '263');
        if (a.href.indexOf('wa.me') !== -1) { a.target = '_blank'; a.rel = 'noopener'; }
      }
      if (span) span.textContent = v;
      li.hidden = false;
    });
  }).catch(function () { /* the page still reads fine */ });
})();
