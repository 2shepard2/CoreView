/* Countdown ("Big day"): how long until a day the family is waiting for.
 *
 *   days to go         -> one huge number, "days to go" under it
 *   the day before     -> "1", "Tomorrow!"
 *   the day itself     -> hours (or minutes) left, if a time was set
 *   it's here          -> the "it's here" words, big, for the whole day
 *   after the day      -> the same words, smaller, with the date
 *   no / bad date      -> "Pick a date for this countdown in Studio" (grey, still)
 *
 * Days are calendar days in the house's time zone (sleeps, not 24-hour
 * blocks), so "11 days" doesn't turn into "10" at lunchtime. No seconds:
 * the picture changes at most once a minute (design guide, rule 2).
 *
 * Looks: "neon" = a sunset-coast scene drawn in inline SVG (sun with stripes,
 * palms, a grid floor that drifts slowly); "plain" = white text on whatever is
 * behind it (put it over photos). ES5 only (tests/es5.test.js).
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // "2026-11-19" + "18:30" -> { y, mo (0-11), d, h, mi } or null.
  function parseTarget(date, time) {
    var m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(date || '');
    if (!m) return null;
    var t = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: 0, mi: 0 };
    var check = new Date(Date.UTC(t.y, t.mo, t.d));
    if (check.getUTCMonth() !== t.mo || check.getUTCDate() !== t.d) return null;
    var tm = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time || '');
    if (tm && +tm[1] < 24 && +tm[2] < 60) { t.h = +tm[1]; t.mi = +tm[2]; }
    return t;
  }

  // Everything the picture shows, as plain data.
  function compute(props, stage) {
    var t = parseTarget(props.date, props.time);
    if (!t) return { kind: 'unset' };
    var now = stage.now(), off = stage.tzOffsetMin || 0;
    var p = CVRender.localParts(now, off);
    // House-local wall time of the target, as a UTC instant.
    var targetMs = Date.UTC(t.y, t.mo, t.d, t.h, t.mi) - off * 60000;
    var dayIndex = function (y, mo, d) { return Math.round(Date.UTC(y, mo, d) / 86400000); };
    var days = dayIndex(t.y, t.mo, t.d) - dayIndex(p.y, p.mo, p.d);
    var wd = new Date(Date.UTC(t.y, t.mo, t.d)).getUTCDay();
    var when = DAYS[wd] + ', ' + MONTHS[t.mo] + ' ' + t.d + (t.y !== p.y ? ', ' + t.y : '');
    var left = targetMs - now;
    if (left <= 0) return { kind: days === 0 ? 'today' : 'after', when: when };
    if (days >= 1) return { kind: 'days', n: days, label: days === 1 ? 'Tomorrow!' : 'days to go', when: when };
    var mins = Math.ceil(left / 60000);
    if (mins >= 60) {
      var h = Math.floor(mins / 60), mm = mins % 60;
      return { kind: 'hours', n: h + ':' + (mm < 10 ? '0' : '') + mm, label: 'hours to go', when: 'Today' };
    }
    return { kind: 'hours', n: '' + mins, label: mins === 1 ? 'minute to go' : 'minutes to go', when: 'Today' };
  }

  // ---------- the neon coast backdrop (inline SVG, no style attributes) ----------
  // Bands cut through the lower half of the sun, wider toward the horizon,
  // like an old poster (an SVG mask: black hides).
  var SUN_STRIPES = (function () {
    var s = '', i;
    for (i = 0; i < 5; i++) s += '<rect x="0" y="' + (45 + i * 3.1).toFixed(2) + '" width="200" height="' + (0.6 + i * 0.45).toFixed(2) + '" fill="#000"/>';
    return s;
  })();
  function palm(x, flip, scale) {
    var t = 'translate(' + x + ' 100) scale(' + (flip ? -scale : scale) + ' ' + scale + ')';
    return '<g transform="' + t + '" fill="#14051f" stroke="#ff4fb0" stroke-opacity="0.7" stroke-width="0.45" stroke-linejoin="round">' +
      '<path d="M-1.2 0C-0.6-14 0.4-26 3.6-38L5.2-37.6C2.4-26 1.6-14 1.4 0Z"/>' +
      '<path d="M4.4-38C-4-41-11-38-16-31-10-35-3-36 4.4-37Z"/>' +
      '<path d="M4.4-38C-2-46-10-47-16-44-9-44-2-42 4.4-37Z"/>' +
      '<path d="M4.4-38C6-47 12-51 19-51 13-48 8-44 5-37Z"/>' +
      '<path d="M4.4-38C12-42 20-40 25-33 18-37 11-38 5-37Z"/>' +
      '<path d="M4.4-38C8-36 13-31 14-24 10-30 7-34 4.4-37Z"/>' +
      '</g>';
  }
  function backdrop(root, stage) {
    var sky = el('div', 'cd-sky', root);
    var grid = '', i;
    for (i = -10; i <= 10; i++) grid += '<path d="M' + (100 + i * 4) + ' 0L' + (100 + i * 30) + ' 40"/>';
    sky.innerHTML =
      '<svg class="cd-scene" viewBox="0 0 200 100" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<linearGradient id="cdSun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe46b"/><stop offset="0.55" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ff2d8a"/></linearGradient>' +
      '<mask id="cdCut" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="100"><rect x="0" y="0" width="200" height="60" fill="#fff"/>' + SUN_STRIPES + '</mask>' +
      '</defs>' +
      '<circle cx="100" cy="62" r="27" fill="url(#cdSun)" mask="url(#cdCut)"/>' +
      '<rect x="0" y="60" width="200" height="40" fill="#1a0630"/>' +
      '<g class="cd-grid-v" stroke="#ff3ea5" stroke-opacity="0.55" stroke-width="0.35" fill="none" transform="translate(0 60)">' + grid + '</g>' +
      '<path d="M0 60H200" stroke="#ff7ad1" stroke-width="0.6"/>' +
      palm(14, false, 0.95) + palm(30, true, 0.7) + palm(186, true, 1) + palm(171, false, 0.68) +
      '</svg>';
    // Horizontal grid lines drift toward the viewer: CSS-animated divs in a
    // floor box, phase from the clock so a redraw doesn't restart them.
    var floor = el('div', 'cd-floor', root);
    for (i = 0; i < 6; i++) {
      var line = el('div', 'cd-hline', floor);
      var delay = -((stage.now() / 1000) % 12) - i * 2;
      line.style.webkitAnimationDelay = delay + 's';
      line.style.animationDelay = delay + 's';
    }
  }

  function countdownWidget(box, stage) {
    var props = {}, sig = null;
    var root = el('div', 'cd-root', box);
    function render() {
      var d = compute(props, stage), look = props.style === 'plain' ? 'plain' : 'neon';
      var s = JSON.stringify([d, props, stage.height]);
      if (s === sig) return;
      sig = s;
      box.style.fontSize = (props.size || 1) * stage.height / 100 + 'px';
      clear(root);
      root.className = 'cd-root cd-' + look + ' cd-k-' + d.kind;
      if (look === 'neon') backdrop(root, stage);
      var card = el('div', 'cd-card', root);
      var title = (props.title || '').trim();
      if (title) el('div', 'cd-title', card).textContent = title;
      if (d.kind === 'unset') {
        el('div', 'cd-unset', card).textContent = 'Pick a date for this countdown in Studio';
        return;
      }
      if (d.kind === 'today' || d.kind === 'after') {
        el('div', 'cd-done', card).textContent = (props.doneText || '').trim() || "It's here!";
        if (d.kind === 'after') el('div', 'cd-when', card).textContent = d.when;
        return;
      }
      el('div', 'cd-num' + (String(d.n).length > 3 ? ' cd-num-long' : ''), card).textContent = d.n;
      el('div', 'cd-label', card).textContent = d.label;
      el('div', 'cd-when', card).textContent = d.when;
    }
    return {
      update: function (p) { props = p || {}; sig = null; render(); },
      tick: render,
      resize: function () { sig = null; render(); }
    };
  }
  CVRender.register('countdown', countdownWidget);
  // For tests: the date maths without a DOM.
  CVRender.countdownCompute = compute;
})();
