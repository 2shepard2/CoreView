/* Ambient: a slow, full-screen animation for screens that sit idle (a
 * garage TV between door openings, a hallway at night).
 *
 *   aurora  ribbons of light drifting like the northern lights
 *   lava    soft glowing blobs rising and sinking like a lava lamp
 *   stars   a field of stars drifting past
 *
 * Drawn on a small canvas (about 480 px wide) that CSS scales up: the soft
 * look needs no detail, and old sticks and frames keep up. About 30 frames a
 * second; one still frame in the editor. ES5 only (tests/es5.test.js).
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var el = CVRender.util.el;

  var PALETTES = {
    aurora: ['#2bd9a0', '#3aa8ff', '#9b5cff', '#1de9b6'],
    sunset: ['#ff7a45', '#ff3d7f', '#ffc145', '#8a4dff'],
    ocean: ['#00b4d8', '#0077b6', '#48cae4', '#90e0ef'],
    halloween: ['#ff7a00', '#9b30ff', '#ffb000', '#5b1fa8'],
    holiday: ['#ff3b30', '#34c759', '#ffd60a', '#e5e5ea']
  };

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function ambientWidget(box, stage) {
    var props = {}, canvas = el('canvas', 'cv-ambient-canvas', box), ctx = canvas.getContext('2d');
    var raf = null, last = 0, t0 = new Date().getTime(), W = 0, H = 0, stars = [], blobs = [];

    function size() {
      var bw = box.clientWidth || 1, bh = box.clientHeight || 1;
      W = Math.min(480, bw); H = Math.max(1, Math.round(W * bh / bw));
      canvas.width = W; canvas.height = H;
      stars = []; blobs = [];
      for (var i = 0; i < 140; i++) stars.push({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() });
      for (var j = 0; j < 7; j++) blobs.push({ x: Math.random(), p: Math.random() * 6.28, s: 0.2 + Math.random() * 0.25, r: 0.18 + Math.random() * 0.16, c: j });
    }

    function aurora(t, pal) {
      ctx.fillStyle = '#04070d';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (var k = 0; k < 4; k++) {
        var base = H * (0.3 + k * 0.12), amp = H * (0.08 + 0.04 * k), sp = 0.05 + k * 0.02;
        for (var layer = 0; layer < 3; layer++) {
          ctx.beginPath();
          for (var x = 0; x <= W; x += 6) {
            var y = base + Math.sin(x / W * (3 + k) + t * sp * 6 + k) * amp + Math.sin(x / W * 9 - t * sp * 4) * amp * 0.3;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = rgba(pal[k % pal.length], 0.05 + 0.04 * (0.5 + 0.5 * Math.sin(t * 0.3 + k)));
          ctx.lineWidth = H * (0.05 + layer * 0.07);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function lava(t, pal) {
      ctx.fillStyle = '#07040c';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        var x = W * (0.12 + 0.76 * (0.5 + 0.5 * Math.sin(t * 0.3 * b.s + b.p * 2 + b.x)));
        var y = H * (0.5 + 0.42 * Math.sin(t * b.s * 0.35 + b.p));
        var r = Math.min(W, H) * b.r * (1 + 0.15 * Math.sin(t * 0.4 + b.p));
        var g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(pal[b.c % pal.length], 0.55));
        g.addColorStop(1, rgba(pal[b.c % pal.length], 0));
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function starfield(t, pal, dt) {
      ctx.fillStyle = 'rgba(2,3,8,0.35)';
      ctx.fillRect(0, 0, W, H);
      var cx = W / 2, cy = H / 2;
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        s.z -= dt * 0.00006;
        if (s.z <= 0.02) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; }
        var px = cx + s.x / s.z * cx * 0.6, py = cy + s.y / s.z * cy * 0.6;
        if (px < 0 || px > W || py < 0 || py > H) { s.z = 0; continue; }
        var sz = (1 - s.z) * 2.2 + 0.3;
        ctx.fillStyle = i % 9 === 0 ? pal[i % pal.length] : 'rgba(235,240,255,' + (1 - s.z) + ')';
        ctx.fillRect(px, py, sz, sz);
      }
    }

    function draw(now) {
      var dt = last ? Math.min(100, now - last) : 16;
      last = now;
      var t = (new Date().getTime() - t0) / 1000 * ((props.speed || 5) / 5);
      var pal = PALETTES[props.palette] || PALETTES.aurora;
      if (props.style === 'lava') lava(t, pal);
      else if (props.style === 'stars') starfield(t, pal, dt);
      else aurora(t, pal);
    }
    function loop(now) {
      raf = window.requestAnimationFrame(loop);
      if (now - last < 30) return; // about 30 frames a second
      draw(now);
    }
    function stop() { if (raf) window.cancelAnimationFrame(raf); raf = null; }

    return {
      update: function (pr) {
        props = pr;
        size();
        stop();
        last = 0;
        if (stage.editing) { t0 -= 20000; draw(16); return; }
        if (props.style === 'stars') { ctx.fillStyle = '#020308'; ctx.fillRect(0, 0, W, H); }
        raf = window.requestAnimationFrame(loop);
      },
      destroy: stop
    };
  }

  CVRender.register('ambient', ambientWidget);
})();
