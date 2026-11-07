/* Gentle random floating for decorative elements on the home page.
   Each element drifts to a random offset over a random duration, then picks a
   new one, so nothing moves in sync. Uses the CSS `translate`/`rotate`
   properties so it stacks on top of each element's own transform (tilts etc).
   Paused while off-screen; disabled for people who prefer reduced motion. */
(function () {
  'use strict';
  if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var GROUPS = [
    { sel: '.floaters .floater', x: 46, y: 34, r: 0, min: 2600, max: 5200 },  // circle photos
    { sel: '.pills .pill', x: 42, y: 11, r: 8, min: 1800, max: 3800 },        // colourful tags
    { sel: '.join .join-panel', x: 18, y: 16, r: 3, min: 2600, max: 4600 }    // join us / our events
  ];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function step(node, g) {
    if (!node._floatOn) { node._floatTimer = null; return; }
    var d = Math.round(rand(g.min, g.max));
    node.style.transition = 'translate ' + d + 'ms ease-in-out, rotate ' + d + 'ms ease-in-out, scale .25s ease';
    node.style.translate = rand(-g.x, g.x).toFixed(1) + 'px ' + rand(-g.y, g.y).toFixed(1) + 'px';
    if (g.r) node.style.rotate = rand(-g.r, g.r).toFixed(1) + 'deg';
    node._floatTimer = setTimeout(function () { step(node, g); }, d);
  }

  var observer = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var node = e.target;
      node._floatOn = e.isIntersecting;
      if (node._floatOn && !node._floatTimer) {
        node._floatTimer = setTimeout(function () { step(node, node._floatGroup); }, rand(0, 600));
      } else if (!node._floatOn && node._floatTimer) {
        clearTimeout(node._floatTimer);
        node._floatTimer = null;
      }
    });
  }, { rootMargin: '80px' }) : null;

  GROUPS.forEach(function (g) {
    Array.prototype.forEach.call(document.querySelectorAll(g.sel), function (node) {
      node._floatGroup = g;
      if (observer) observer.observe(node);
      else { node._floatOn = true; step(node, g); }
    });
  });
})();
