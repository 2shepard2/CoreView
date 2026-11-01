/* Holiday themes: decorations drawn over a screen (render.js stage.setTheme).
 *
 * ES5 (the bedroom frame runs Chrome 44). Everything is inline SVG or plain
 * divs moved by CSS transforms (render.css, "holiday themes"), never emoji:
 * Android 6 has no bat. The layer's font-size is 1% of the stage height, so
 * sizes in em scale with the screen. Each theme takes a level: "full" (all of
 * it) or "light" (corners and the odd visitor, for screens people read).
 * In the editor (stage.editing) only the still parts are drawn.
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var el = CVRender.util.el;

  function svgUrl(svg) {
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  }
  function svg(viewBox, body) {
    return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '">' + body + '</svg>');
  }
  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
  function anim(e, name, seconds, extra) {
    var v = name + ' ' + seconds + 's ' + (extra || 'linear');
    e.style.webkitAnimation = v;
    e.style.animation = v;
  }
  function delay(e, seconds) {
    e.style.webkitAnimationDelay = seconds + 's';
    e.style.animationDelay = seconds + 's';
  }
  function sprite(parent, cls, image, w, h) {
    var e = el('div', 'cvd-sprite ' + cls, parent);
    e.style.backgroundImage = image;
    e.style.width = w + 'em';
    e.style.height = h + 'em';
    return e;
  }
  // The house's hour (night: no flashes on the bedroom frame).
  function houseHour(stage) { return CVRender.localParts(stage.now(), stage.tzOffsetMin).h; }

  // Runs a visitor now and then; every timer is cleared on destroy.
  function scheduler(stage) {
    var timers = [], live = [];
    function later(fn, ms) {
      var t = setTimeout(function () {
        for (var i = 0; i < timers.length; i++) if (timers[i] === t) timers.splice(i, 1);
        fn();
      }, ms);
      timers.push(t);
    }
    return {
      // Call fn every lo-hi seconds (first time after first seconds).
      every: function (lo, hi, fn, first) {
        if (stage.editing) return;
        function run() { fn(); later(run, rand(lo, hi) * 1000); }
        later(run, (first === undefined ? rand(lo, hi) : first) * 1000);
      },
      // An element that removes itself after seconds.
      temp: function (e, seconds) {
        live.push(e);
        later(function () { if (e.parentNode) e.parentNode.removeChild(e); }, seconds * 1000);
      },
      stop: function () {
        for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
        timers = [];
        for (var j = 0; j < live.length; j++) if (live[j].parentNode) live[j].parentNode.removeChild(live[j]);
        live = [];
      }
    };
  }

  // ---------- shapes ----------
  // A corner web anchored at the top left (mirror with cvd-flip for the right).
  var COBWEB = (function () {
    var spokes = [0, 16, 33, 50, 66, 83, 90], radii = [18, 34, 50, 66, 84, 100], body = '', i, j;
    function pt(a, r) { var t = a * Math.PI / 180; return [r * Math.cos(t), r * Math.sin(t)]; }
    for (i = 0; i < spokes.length; i++) { var e = pt(spokes[i], 110); body += 'M0 0L' + e[0].toFixed(1) + ' ' + e[1].toFixed(1); }
    for (j = 0; j < radii.length; j++) {
      for (i = 0; i < spokes.length - 1; i++) {
        var a = pt(spokes[i], radii[j]), b = pt(spokes[i + 1], radii[j]);
        var m = pt((spokes[i] + spokes[i + 1]) / 2, radii[j] * 0.86);
        body += 'M' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + 'Q' + m[0].toFixed(1) + ' ' + m[1].toFixed(1) + ' ' + b[0].toFixed(1) + ' ' + b[1].toFixed(1);
      }
    }
    return svg('0 0 100 100', '<path d="' + body + '" fill="none" stroke="#e8e4f0" stroke-opacity="0.6" stroke-width="0.7"/>');
  })();
  var BAT = svg('0 0 100 50', '<path d="M50 20C48 15 46 13 45 15L44 9 41 15C35 8 25 6 12 10 19 14 21 19 19 25 25 22 30 24 32 29 36 27 40 29 42 33L50 42 58 33C60 29 64 27 68 29 70 24 75 22 81 25 79 19 81 14 88 10 75 6 65 8 59 15L56 9 55 15C54 13 52 15 50 20Z" fill="#14101c" stroke="#a58bd8" stroke-opacity="0.6" stroke-width="1.4"/>' +
    '<circle cx="47" cy="19" r="1.3" fill="#ff5a1f"/><circle cx="53" cy="19" r="1.3" fill="#ff5a1f"/>');
  var GHOST = svg('0 0 60 80', '<path d="M30 4C14 4 6 16 6 32V74L14 66 22 74 30 66 38 74 46 66 54 74V32C54 16 46 4 30 4Z" fill="#f4f1ff" fill-opacity="0.92"/>' +
    '<ellipse cx="22" cy="31" rx="4" ry="6" fill="#241c33"/><ellipse cx="38" cy="31" rx="4" ry="6" fill="#241c33"/><ellipse cx="30" cy="46" rx="4" ry="5.5" fill="#241c33"/>');
  var SPIDER = svg('0 0 40 40', '<g stroke="#1a1420" stroke-width="2" fill="none" stroke-linecap="round">' +
    '<path d="M16 18L6 10 2 16M16 21L4 20 1 27M17 24L7 30 5 37M24 18L34 10 38 16M24 21L36 20 39 27M23 24L33 30 35 37"/></g>' +
    '<ellipse cx="20" cy="25" rx="7" ry="8.5" fill="#1a1420" stroke="#b9a7d6" stroke-opacity="0.55"/><circle cx="20" cy="15" r="4.5" fill="#1a1420" stroke="#b9a7d6" stroke-opacity="0.55"/>' +
    '<circle cx="18.3" cy="14.5" r="1.1" fill="#ff3b30"/><circle cx="21.7" cy="14.5" r="1.1" fill="#ff3b30"/>');
  var PUMPKIN = svg('0 0 100 90', '<path d="M47 14C47 8 50 3 56 1L58 4C54 6 53 10 53 15Z" fill="#3f5d1e"/>' +
    '<ellipse cx="30" cy="54" rx="22" ry="31" fill="#d65a00"/><ellipse cx="70" cy="54" rx="22" ry="31" fill="#d65a00"/>' +
    '<ellipse cx="50" cy="53" rx="25" ry="34" fill="#f07400"/>' +
    '<path d="M31 42L41 34 43 47ZM69 42L59 34 57 47ZM50 50L45 58H55Z" fill="#ffd24a"/>' +
    '<path d="M26 63C34 74 66 74 74 63L68 66 64 62 58 68 54 63 50 69 46 63 42 68 36 62 32 66Z" fill="#ffd24a"/>');
  function leaf(color) {
    return svg('0 0 40 48', '<path d="M20 2C29 9 37 18 35 29 33 38 27 42 20 46 13 42 7 38 5 29 3 18 11 9 20 2Z" fill="' + color + '"/>' +
      '<path d="M20 6V46M20 20L29 14M20 28L31 22M20 20L11 14M20 28L9 22" stroke="#5a2a0a" stroke-opacity="0.45" stroke-width="1.2" fill="none"/>');
  }
  var MAPLE = svg('0 0 50 50', '<path d="M25 2L29 13 37 9 35 20 46 18 40 27 47 31 35 34 37 42 27 37V48H23V37L13 42 15 34 3 31 10 27 4 18 15 20 13 9 21 13Z" fill="#c2410c"/>');
  var FLAKE = svg('0 0 40 40', '<g stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" fill="none">' +
    '<path d="M20 3V37M5.3 11.5L34.7 28.5M5.3 28.5L34.7 11.5M20 9L16 5M20 9L24 5M20 31L16 35M20 31L24 35"/></g>');
  var WIRE = svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 50" preserveAspectRatio="none"><path d="M0 6Q110 66 220 6" fill="none" stroke="#1d3b1f" stroke-width="2.5"/></svg>');
  var STAR = svg('0 0 40 40', '<path d="M20 0C21 13 27 19 40 20 27 21 21 27 20 40 19 27 13 21 0 20 13 19 19 13 20 0Z" fill="#fff4c2"/>');

  // ---------- Halloween ----------
  // Cobwebs, a pumpkin on each lower corner, fog along the bottom; bats cross
  // now and then, a ghost drifts up, a spider drops from the web, and (late
  // evening only, never at night) lightning flickers.
  CVRender.registerTheme('halloween', function (layer, stage, level) {
    var full = level === 'full', sched = scheduler(stage);
    el('div', 'cvd-vignette cvd-vignette-halloween' + (full ? '' : ' cvd-soft'), layer);
    var webR = sprite(layer, 'cvd-web cvd-flip', COBWEB, full ? 17 : 13, full ? 17 : 13);
    webR.style.right = '0';
    var pumpkins = [];
    // A pumpkin sits in a lower corner only if no widget is there (a clock, a
    // note, a map caption...). Only near-full-screen widgets (a photo backdrop) don't count.
    function cornerFree(right) {
      var v = stage.view, ws = (v && v.widgets) || [], k = stage.height / Math.max(1, stage.width);
      var x0 = right ? 100 - 14 * k : 0, x1 = right ? 100 : 14 * k, y0 = 86, y1 = 100;
      for (var i = 0; i < ws.length; i++) {
        var w = ws[i];
        if (w.w * w.h > 8000) continue;
        if (w.x < x1 && w.x + w.w > x0 && w.y < y1 && w.y + w.h > y0) return false;
      }
      return true;
    }
    function placePumpkins() {
      for (var i = 0; i < pumpkins.length; i++) if (pumpkins[i].parentNode) pumpkins[i].parentNode.removeChild(pumpkins[i]);
      pumpkins = [];
      for (var side = 0; side < 2; side++) {
        if (!cornerFree(side === 1)) continue;
        var spot = el('div', 'cvd-pumpkin ' + (side ? 'cvd-right' : 'cvd-left'), layer);
        anim(el('div', 'cvd-glow', spot), 'cvd-flicker', rand(2.6, 3.4), 'ease-in-out infinite');
        sprite(spot, 'cvd-pumpkin-body', PUMPKIN, 12, 10.8);
        pumpkins.push(spot);
      }
    }
    if (full) {
      sprite(layer, 'cvd-web', COBWEB, 17, 17).style.left = '0';
      var fog = el('div', 'cvd-fog', layer);
      el('div', 'cvd-fog-band', fog);
      el('div', 'cvd-fog-band cvd-fog-slow', fog);
      placePumpkins();
    }

    function bats() {
      var n = full ? Math.floor(rand(3, 6)) : 2, ltr = Math.random() < 0.5, top = rand(6, 45);
      for (var i = 0; i < n; i++) {
        var lane = el('div', 'cvd-lane', layer);
        lane.style.top = top + rand(-5, 9) + 'em';
        anim(lane, ltr ? 'cvd-cross-lr' : 'cvd-cross-rl', rand(7, 10), 'linear 1 both');
        delay(lane, i * rand(0.25, 0.7));
        var bob = el('div', 'cvd-bob', lane);
        anim(bob, 'cvd-bob', rand(1.1, 1.7), 'ease-in-out infinite alternate');
        var size = rand(5, 8);
        var bat = sprite(bob, 'cvd-bat', BAT, size, size / 2);
        anim(bat, 'cvd-flap', rand(0.18, 0.26), 'ease-in-out infinite alternate');
        sched.temp(lane, 14);
      }
    }
    function ghost() {
      var lane = el('div', 'cvd-rise', layer);
      lane.style.left = rand(8, 85) + '%';
      anim(lane, 'cvd-rise', 13, 'ease-in-out 1 both');
      var wob = el('div', 'cvd-wobble', lane);
      anim(wob, 'cvd-wobble', 2.4, 'ease-in-out infinite alternate');
      sprite(wob, 'cvd-ghost', GHOST, 7, 9.3);
      sched.temp(lane, 14);
    }
    function spider() {
      var drop = el('div', 'cvd-spider', layer);
      drop.style.left = rand(4, 12) + 'em';
      el('div', 'cvd-thread', drop);
      sprite(drop, 'cvd-spider-body', SPIDER, 4.5, 4.5);
      anim(drop, 'cvd-dangle', 16, 'ease-in-out 1 both');
      sched.temp(drop, 17);
    }
    function lightning() {
      var hr = houseHour(stage);
      if (hr < 17 || hr >= 21) return;
      var flash = el('div', 'cvd-flash', layer);
      anim(flash, 'cvd-flash', 1.6, 'linear 1 both');
      sched.temp(flash, 2);
    }

    if (stage.editing) {
      var still = sprite(layer, 'cvd-ghost cvd-still', GHOST, 7, 9.3);
      still.style.left = '78%'; still.style.top = '30%';
    }
    sched.every(full ? 45 : 150, full ? 100 : 260, bats, full ? 6 : 30);
    if (full) {
      sched.every(80, 170, ghost, 20);
      sched.every(200, 380, spider, 50);
      sched.every(420, 800, lightning);
    }
    return { destroy: sched.stop, view: full ? placePumpkins : null, resize: full ? placePumpkins : null };
  });

  // ---------- Thanksgiving ----------
  // Autumn leaves drifting down (full: a steady fall; light: a gust now and then).
  CVRender.registerTheme('thanksgiving', function (layer, stage, level) {
    var full = level === 'full', sched = scheduler(stage);
    var colors = ['#c2410c', '#d9480f', '#e67700', '#f59f00', '#a61e4d', '#9a5b13'];
    el('div', 'cvd-vignette cvd-vignette-autumn' + (full ? '' : ' cvd-soft'), layer);
    function fallingLeaf(first, once) {
      var lane = el('div', 'cvd-fall', layer);
      lane.style.left = rand(-2, 97) + '%';
      var seconds = rand(14, 22);
      anim(lane, 'cvd-fall', seconds, once ? 'linear 1 both' : 'linear infinite');
      delay(lane, first ? -rand(0, seconds) : rand(0, 3));
      var sway = el('div', 'cvd-sway', lane);
      anim(sway, 'cvd-sway', rand(2.5, 4), 'ease-in-out infinite alternate');
      var size = rand(3, 5.5);
      var l = sprite(sway, 'cvd-leaf', Math.random() < 0.3 ? MAPLE : leaf(pick(colors)), size, size * 1.2);
      anim(l, 'cvd-spin', rand(4, 8), 'linear infinite');
      if (once) sched.temp(lane, seconds + 4);
    }
    if (stage.editing) {
      for (var k = 0; k < 4; k++) { var s = sprite(layer, 'cvd-still', leaf(colors[k]), 4, 4.8); s.style.left = 10 + k * 24 + '%'; s.style.top = 8 + (k % 2) * 30 + '%'; }
      return null;
    }
    if (full) for (var i = 0; i < 9; i++) fallingLeaf(true, false);
    sched.every(full ? 120 : 180, full ? 240 : 360, function () {
      for (var j = 0; j < (full ? 6 : 5); j++) fallingLeaf(false, true);
    }, full ? 60 : 10);
    return { destroy: sched.stop };
  });

  // ---------- Christmas ----------
  // Snow, and (full) a string of twinkling lights along the top.
  CVRender.registerTheme('christmas', function (layer, stage, level) {
    var full = level === 'full', sched = scheduler(stage), lights = null;
    el('div', 'cvd-vignette cvd-vignette-winter' + (full ? '' : ' cvd-soft'), layer);
    var count = full ? 26 : 12;
    for (var i = 0; i < count; i++) {
      var lane = el('div', 'cvd-fall', layer);
      lane.style.left = rand(-2, 99) + '%';
      var seconds = rand(16, 30);
      if (stage.editing) lane.style.top = rand(0, 85) + '%';
      else { anim(lane, 'cvd-fall', seconds, 'linear infinite'); delay(lane, -rand(0, seconds)); }
      var sway = el('div', 'cvd-sway', lane);
      if (!stage.editing) anim(sway, 'cvd-sway', rand(3, 5), 'ease-in-out infinite alternate');
      if (Math.random() < 0.35) {
        var size = rand(1.8, 3.2);
        var f = sprite(sway, 'cvd-flake', FLAKE, size, size);
        if (!stage.editing) anim(f, 'cvd-spin', rand(8, 14), 'linear infinite');
      } else {
        var dot = el('div', 'cvd-snow', sway);
        var d = rand(0.6, 1.4);
        dot.style.width = dot.style.height = d + 'em';
        dot.style.opacity = rand(0.55, 0.95);
      }
    }
    var COLORS = ['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ff9f0a'];
    function stringLights() {
      if (lights && lights.parentNode) lights.parentNode.removeChild(lights);
      lights = el('div', 'cvd-lights', layer);
      var em = Math.max(1, stage.height / 100), span = 22, n = Math.ceil(stage.width / (span * em));
      for (var s = 0; s < n; s++) {
        var wire = el('div', 'cvd-wire', lights);
        wire.style.left = s * span + 'em';
        wire.style.width = span + 'em';
        wire.style.backgroundImage = WIRE;
        for (var b = 0; b < 4; b++) {
          var x = (b + 0.5) / 4, sag = Math.sin(Math.PI * x) * 3;
          var bulb = el('div', 'cvd-bulb', lights);
          var c = COLORS[(s * 4 + b) % COLORS.length];
          bulb.style.left = s * span + x * span - 0.6 + 'em';
          bulb.style.top = 0.6 + sag + 'em';
          bulb.style.backgroundColor = c;
          bulb.style.boxShadow = '0 0 1.2em 0.3em ' + c;
          if (!stage.editing) { anim(bulb, 'cvd-twinkle', rand(1.2, 2.4), 'ease-in-out infinite alternate'); delay(bulb, -rand(0, 2)); }
        }
      }
    }
    if (full) stringLights();
    return { destroy: sched.stop, resize: function () { if (full) stringLights(); } };
  });

  // ---------- New Year's ----------
  // Sparkles in the corners and a shower of confetti now and then; a long one
  // in the first minutes of January 1.
  CVRender.registerTheme('newyear', function (layer, stage, level) {
    var full = level === 'full', sched = scheduler(stage);
    var colors = ['#ffd60a', '#e5e5ea', '#ff375f', '#64d2ff', '#bf5af2', '#f5c451'];
    el('div', 'cvd-vignette cvd-vignette-gold' + (full ? '' : ' cvd-soft'), layer);
    var spots = full ? [[3, 4], [10, 14], [90, 5], [95, 18], [5, 82], [93, 86]] : [[94, 6], [5, 8]];
    for (var i = 0; i < spots.length; i++) {
      var s = sprite(layer, 'cvd-star', STAR, i % 2 ? 2.4 : 3.6, i % 2 ? 2.4 : 3.6);
      s.style.left = spots[i][0] + '%'; s.style.top = spots[i][1] + '%';
      if (!stage.editing) { anim(s, 'cvd-sparkle', rand(1.6, 2.8), 'ease-in-out infinite alternate'); delay(s, -rand(0, 2)); }
    }
    function confetti(pieces, spread) {
      for (var j = 0; j < pieces; j++) {
        var lane = el('div', 'cvd-fall', layer);
        lane.style.left = rand(0, 98) + '%';
        var seconds = rand(6, 10);
        anim(lane, 'cvd-fall', seconds, 'linear 1 both');
        delay(lane, rand(0, spread));
        var sway = el('div', 'cvd-sway', lane);
        anim(sway, 'cvd-sway', rand(1.2, 2), 'ease-in-out infinite alternate');
        var bit = el('div', 'cvd-confetti', sway);
        bit.style.backgroundColor = pick(colors);
        bit.style.width = rand(0.8, 1.4) + 'em';
        bit.style.height = rand(0.4, 0.7) + 'em';
        anim(bit, 'cvd-tumble', rand(1, 2), 'linear infinite');
        sched.temp(lane, seconds + spread + 1);
      }
    }
    sched.every(full ? 150 : 300, full ? 260 : 480, function () { confetti(full ? 34 : 18, 3); }, full ? 8 : 40);
    // Midnight on New Year's Day: five minutes of confetti.
    sched.every(20, 20, function () {
      var p = CVRender.localParts(stage.now(), stage.tzOffsetMin);
      if (p.mo === 0 && p.d === 1 && p.h === 0 && p.mi < 5) confetti(full ? 40 : 24, 18);
    }, 1);
    return { destroy: sched.stop };
  });
})();
