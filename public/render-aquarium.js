/* The Aquarium: the house at a glance as a living fish tank.
 *
 *   people      a fish each while home (their colour, their name); out = a
 *               little boat on the surface, flagged with the zone they're in
 *   openings    doors, windows, the garage, locks: a clam each on the sand.
 *               Open (on / open / unlocked) = the clam opens, glows amber and
 *               streams bubbles, so it reads from across the room
 *   inside      a temperature sensor tints the water: cool blue, comfortable
 *               teal, warm green
 *   weather     the sky above the surface: sun and light shafts, clouds, rain
 *               with ripples, snow, fog, a moon and stars at night (sun.sun)
 *   alarms      leak / smoke / CO sensors: when one is on, the water turns
 *               murky and a red banner names it. Nothing else is that loud.
 *
 * No answer from Home Assistant for anything configured = grey, still water
 * and "Can't hear Home Assistant", never a calm tank that might be lying.
 *
 * ES5 only, like render.js; tests/es5.test.js applies. Drawn with inline SVG,
 * no emoji, so it looks the same on every screen.
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear;
  function text(parent, cls, value) { var e = el('div', cls, parent); e.textContent = value; return e; }

  var OPEN = { on: 1, open: 1, opening: 1, unlocked: 1, unlocking: 1 };
  var WET = { rainy: 1, pouring: 1, lightning: 1, 'lightning-rainy': 1, hail: 1, 'snowy-rainy': 1 };
  var CLOUDY = { cloudy: 1, partlycloudy: 1, fog: 1, windy: 1, 'windy-variant': 1, exceptional: 1 };

  function hex(c) { c = String(c || '#4f8cff').replace('#', ''); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
  function mix(a, b, t) { var x = hex(a), y = hex(b), o = []; for (var i = 0; i < 3; i++) o.push(Math.round(x[i] + (y[i] - x[i]) * t)); return 'rgb(' + o.join(',') + ')'; }
  function ago(stage, iso) {
    var m = Math.floor((stage.now() - Date.parse(iso)) / 60000);
    if (!isFinite(m) || m < 1) return 'just now';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h < 24 ? h + ' h' : Math.floor(h / 24) + ' d';
  }
  function hash(s) { var h = 7; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973; return h; }

  function fishSvg(color) {
    var dark = mix(color, '#000000', 0.35), light = mix(color, '#ffffff', 0.45);
    return '<svg viewBox="0 0 120 70" class="aq-fish-svg">' +
      '<path d="M22 35 L2 14 Q8 35 2 56 Z" fill="' + dark + '"/>' +
      '<path d="M50 14 Q62 0 78 12 Z" fill="' + dark + '"/>' +
      '<ellipse cx="62" cy="35" rx="44" ry="22" fill="' + color + '"/>' +
      '<path d="M40 22 Q62 30 92 22 Q70 16 40 22 Z" fill="' + light + '" opacity="0.55"/>' +
      '<path d="M54 44 Q62 56 70 44 Z" fill="' + dark + '"/>' +
      '<path d="M78 16 Q72 35 78 54" stroke="' + dark + '" stroke-width="3" fill="none" opacity="0.6"/>' +
      '<circle cx="92" cy="30" r="6.5" fill="#fff"/><circle cx="94" cy="30" r="3.6" fill="#0b1620"/>' +
      '</svg>';
  }
  function boatSvg(color) {
    return '<svg viewBox="0 0 80 60" class="aq-boat-svg">' +
      '<path d="M40 4 L40 40" stroke="#e8e2d0" stroke-width="2.5"/>' +
      '<path d="M42 6 L70 38 L42 38 Z" fill="' + color + '"/>' +
      '<path d="M38 12 L18 38 L38 38 Z" fill="#f4efe2"/>' +
      '<path d="M8 42 L72 42 L62 56 L18 56 Z" fill="#7a4b2e"/>' +
      '<path d="M8 42 L72 42" stroke="#a8714a" stroke-width="3"/>' +
      '</svg>';
  }
  function clamSvg(open) {
    // The lid hinges at the back (left) and swings up into the extra headroom.
    var top = open ? 'rotate(-34 10 40)' : 'rotate(0 10 40)';
    return '<svg viewBox="0 -34 100 94" class="aq-clam-svg">' +
      (open ? '<ellipse cx="52" cy="38" rx="34" ry="12" fill="#ffd27a" opacity="0.55" class="aq-pearl"/>' +
        '<circle cx="54" cy="38" r="10" fill="#fff4d8"/>' : '') +
      '<path d="M8 40 Q50 66 92 40 Q50 52 8 40 Z" fill="#c9b8d9"/>' +
      '<path d="M20 44 L28 52 M38 47 L42 56 M58 47 L56 56 M76 44 L70 52" stroke="#9c88b1" stroke-width="2"/>' +
      '<g transform="' + top + '"><path d="M8 40 Q50 6 92 40 Q50 30 8 40 Z" fill="#e3d6ee"/>' +
      '<path d="M22 34 L30 22 M40 31 L44 16 M60 31 L58 16 M78 34 L70 22" stroke="#b9a6cc" stroke-width="2"/></g>' +
      '</svg>';
  }
  function weedSvg(h) {
    return '<svg viewBox="0 0 40 ' + h + '" preserveAspectRatio="none" class="aq-weed-svg">' +
      '<path d="M20 ' + h + ' Q4 ' + (h * 0.7) + ' 18 ' + (h * 0.45) + ' Q32 ' + (h * 0.2) + ' 16 0" stroke="#2f7d4f" stroke-width="7" fill="none" stroke-linecap="round"/>' +
      '<path d="M22 ' + h + ' Q36 ' + (h * 0.75) + ' 26 ' + (h * 0.5) + '" stroke="#3f9a62" stroke-width="5" fill="none" stroke-linecap="round"/>' +
      '</svg>';
  }

  function aquariumWidget(box, stage) {
    var props = {}, lastMinute = -1, sig = null;
    var root = el('div', 'aq-root', box);

    function state(id) { return id ? U.stateOf(stage, id) : null; }
    function nameOf(row) {
      var s = state(row.entity);
      return row.name || (s && s.attributes && s.attributes.friendly_name) || row.entity || '';
    }
    function night() {
      var sun = state(props.sun || 'sun.sun');
      if (sun) return sun.state === 'below_horizon';
      var w = state(props.weather);
      if (w && w.state === 'clear-night') return true;
      var h = CVRender.localParts(stage.now(), stage.tzOffsetMin).h;
      return h < 6 || h >= 19;
    }

    // Everything the picture depends on, so a re-render only happens on change.
    function read() {
      var d = { people: [], openings: [], alarms: [], configured: 0, answered: 0 }, i, s, r;
      var rows = props.people || [];
      for (i = 0; i < rows.length; i++) {
        r = rows[i]; if (!r.entity) continue;
        s = state(r.entity); d.configured++; if (s) d.answered++;
        // A fish wears a first name ("Alex", not "Alex Morgan") unless one is set.
        d.people.push({ name: r.name || String(nameOf(r)).split(' ')[0], color: r.color || '#4f8cff', home: s ? s.state === 'home' : null,
          where: s && s.state !== 'home' && s.state !== 'not_home' && s.state !== 'unknown' && s.state !== 'unavailable' ? s.state : '' });
      }
      rows = props.openings || [];
      for (i = 0; i < rows.length; i++) {
        r = rows[i]; if (!r.entity) continue;
        s = state(r.entity); d.configured++; if (s) d.answered++;
        d.openings.push({ name: nameOf(r), open: !!(s && OPEN[s.state]), unknown: !s || s.state === 'unavailable' || s.state === 'unknown',
          since: s && OPEN[s.state] ? ago(stage, s.last_changed) : '' });
      }
      rows = props.alarms || [];
      for (i = 0; i < rows.length; i++) {
        r = rows[i]; if (!r.entity) continue;
        s = state(r.entity); d.configured++; if (s) d.answered++;
        if (s && s.state === 'on') d.alarms.push(nameOf(r));
      }
      if (props.inside) {
        s = state(props.inside); d.configured++;
        var t = s ? parseFloat(s.state) : NaN;
        if (s) d.answered++;
        if (isFinite(t)) { d.temp = t; d.unit = (s.attributes && s.attributes.unit_of_measurement) || '°'; }
      }
      var w = state(props.weather);
      d.weather = w ? w.state : '';
      d.outTemp = w && w.attributes && isFinite(w.attributes.temperature) ? Math.round(w.attributes.temperature) : null;
      d.night = night();
      d.deaf = d.configured > 0 && d.answered === 0;
      return d;
    }

    function waterColors(d) {
      var top, bottom, feel = '';
      var cool = props.coolBelow === undefined ? 68 : props.coolBelow, warm = props.warmAbove === undefined ? 77 : props.warmAbove;
      if (d.deaf) { top = '#56646b'; bottom = '#1d2529'; }
      else if (d.temp === undefined) { top = '#137a8a'; bottom = '#06303d'; }
      else if (d.temp < cool) { top = '#2a6fb0'; bottom = '#0a2346'; feel = 'cool'; }
      else if (d.temp > warm) { top = '#4c9a6c'; bottom = '#173d2a'; feel = 'warm'; }
      else { top = '#13868f'; bottom = '#06343f'; feel = 'comfortable'; }
      if (d.night && !d.deaf) { top = mix(top, '#03070f', 0.45); bottom = mix(bottom, '#010309', 0.5); }
      return { top: top, bottom: bottom, feel: feel };
    }

    function sky(layer, d) {
      var w = d.weather, wet = WET[w], snow = w === 'snowy' || w === 'snowy-rainy', cloudy = CLOUDY[w] || wet || snow;
      var bg = d.night ? (cloudy ? ['#1b2433', '#2e3a4c'] : ['#060d24', '#17244a'])
        : wet ? ['#56687a', '#8797a5'] : cloudy ? ['#8ea4b6', '#c6d3dd'] : snow ? ['#b8c8d6', '#e2eaf0'] : ['#5eb3ea', '#bfe5fa'];
      var skyEl = el('div', 'aq-sky', layer);
      skyEl.style.background = 'linear-gradient(to bottom, ' + bg[0] + ', ' + bg[1] + ')';
      if (d.night && !cloudy) {
        for (var i = 0; i < 14; i++) {
          var st = el('i', 'aq-star', skyEl);
          st.style.left = (5 + (i * 37) % 90) + '%'; st.style.top = (10 + (i * 23) % 60) + '%';
          st.style.animationDelay = (-(i % 5) * 0.9) + 's';
        }
      }
      if (!cloudy || w === 'partlycloudy') el('div', d.night ? 'aq-moon' : 'aq-sun', skyEl);
      if (cloudy) for (var c = 0; c < 3; c++) {
        var cl = el('div', 'aq-cloud' + (wet ? ' aq-cloud-wet' : ''), skyEl);
        cl.style.left = (8 + c * 31) + '%'; cl.style.top = (12 + (c % 2) * 22) + '%';
        cl.style.animationDelay = (-c * 7) + 's';
      }
      if (wet || snow) for (var k = 0; k < 22; k++) {
        var drop = el('i', snow && !wet ? 'aq-flake' : 'aq-drop', skyEl);
        drop.style.left = ((k * 47) % 100) + '%';
        drop.style.animationDelay = (-(k % 7) * 0.17) + 's';
      }
      if (w === 'lightning' || w === 'lightning-rainy') el('div', 'aq-flash', skyEl);
      var surf = el('div', 'aq-surface', layer);
      surf.innerHTML = '<svg viewBox="0 0 400 20" preserveAspectRatio="none"><path d="M0 10 Q25 2 50 10 T100 10 T150 10 T200 10 T250 10 T300 10 T350 10 T400 10 V20 H0 Z" fill="rgba(255,255,255,0.18)"/></svg>';
      if (wet) for (var p = 0; p < 4; p++) { var rip = el('i', 'aq-ripple', layer); rip.style.left = (12 + p * 23) + '%'; rip.style.animationDelay = (-p * 0.6) + 's'; }
      if (!d.night && !cloudy && !d.deaf) for (var r = 0; r < 3; r++) { var ray = el('div', 'aq-ray', layer); ray.style.left = (18 + r * 26) + '%'; ray.style.animationDelay = (-r * 3) + 's'; }
    }

    function render() {
      var d = read(), s = JSON.stringify([d, props, Math.floor(stage.now() / 60000)]);
      if (s === sig) return;
      sig = s;
      clear(root);
      box.style.fontSize = (props.size || 2) * stage.height / 100 + 'px';
      var col = waterColors(d);
      root.style.background = 'linear-gradient(to bottom, ' + col.top + ' 12%, ' + col.bottom + ')';
      root.className = 'aq-root' + (d.deaf ? ' aq-deaf' : '') + (d.alarms.length ? ' aq-alarm' : '') + (d.night && !d.deaf ? ' aq-night' : '');
      sky(root, d);

      // Seaweed and sand.
      var weeds = [[3, 34], [9, 24], [88, 30], [94, 40]];
      for (var w = 0; w < weeds.length; w++) {
        var wd = el('div', 'aq-weed', root);
        wd.style.left = weeds[w][0] + '%'; wd.style.height = weeds[w][1] + '%';
        wd.style.animationDelay = (-w * 1.3) + 's';
        wd.innerHTML = weedSvg(100);
      }
      el('div', 'aq-sand', root);

      // Header: what you'd want to know if you only glance once.
      var head = el('div', 'aq-head', root);
      text(head, 'aq-title cv-acc', props.title || 'Aquarium');
      var open = [], i;
      for (i = 0; i < d.openings.length; i++) if (d.openings[i].open) open.push(d.openings[i].name);
      var home = 0;
      for (i = 0; i < d.people.length; i++) if (d.people[i].home) home++;
      var line;
      if (d.deaf) line = 'Can\'t hear Home Assistant';
      else if (d.alarms.length) line = 'Needs a look now';
      else if (open.length === 1) line = open[0] + ' is open';
      else if (open.length) line = open.length + ' open: ' + open.join(', ');
      else if (!d.configured) line = stage.editing ? 'Add people, doors and windows in the widget settings' : '';
      else line = 'All calm' + (d.people.length ? home ? ' · ' + home + ' home' : ' · everyone\'s out' : '');
      text(head, 'aq-status' + (open.length && !d.alarms.length ? ' aq-status-open' : ''), line);

      if (d.temp !== undefined && !d.deaf) {
        var th = el('div', 'aq-temp', root);
        text(th, 'aq-temp-v cv-acc', Math.round(d.temp) + '°');
        text(th, 'aq-temp-k', 'inside' + (col.feel ? ' · ' + col.feel : '') + (d.outTemp !== null ? ' · ' + d.outTemp + '° out' : ''));
      }

      // Fish (home) and boats (out).
      var fish = [], boats = [];
      for (i = 0; i < d.people.length; i++) (d.people[i].home === false ? boats : fish).push(d.people[i]);
      for (i = 0; i < fish.length; i++) {
        var f = fish[i], hsh = hash(f.name), dur = 26 + (hsh % 14);
        var lane = el('div', 'aq-lane' + (f.home === null ? ' aq-fish-unknown' : ''), root);
        lane.style.top = (27 + (fish.length > 1 ? i * 42 / (fish.length - 1) : 18)) + '%';
        if (fish.length > 4) lane.style.fontSize = '0.8em';
        lane.style.animationDuration = dur + 's';
        // Phase from the wall clock: a re-render (state change, the minute
        // tick) carries on mid-swim instead of snapping back to the start.
        lane.style.animationDelay = (-((stage.now() / 1000 + hsh) % dur)).toFixed(2) + 's';
        var bob = el('div', 'aq-bob', lane);
        bob.style.animationDelay = (-(hsh % 5)) + 's';
        var body = el('div', 'aq-fish', bob);
        body.style.animationDuration = dur + 's';
        body.style.animationDelay = lane.style.animationDelay;
        body.innerHTML = fishSvg(f.color);
        text(bob, 'aq-name', f.name);
      }
      for (i = 0; i < boats.length; i++) {
        var b = boats[i], bt = el('div', 'aq-boat', root);
        bt.style.left = (14 + i * 70 / Math.max(1, boats.length)) + '%';
        bt.style.animationDelay = (-i * 1.1) + 's';
        bt.innerHTML = boatSvg(b.color);
        text(bt, 'aq-name aq-boat-name', b.name + (b.where ? ' · ' + b.where : ' · out'));
      }

      // Clams on the sand.
      var n = d.openings.length;
      for (i = 0; i < n; i++) {
        var o = d.openings[i], clam = el('div', 'aq-clam' + (o.open ? ' aq-clam-open' : '') + (o.unknown ? ' aq-clam-unknown' : ''), root);
        clam.style.left = (12 + (n > 1 ? i * 70 / (n - 1) : 35)) + '%';
        clam.innerHTML = clamSvg(o.open);
        if (o.open) for (var q = 0; q < 9; q++) {
          var bub = el('i', 'aq-bubble', clam);
          bub.style.left = (30 + (q * 17) % 40) + '%';
          bub.style.animationDelay = (-q * 0.37) + 's';
          bub.style.width = bub.style.height = (0.8 + (q % 3) * 0.45) + 'em';
        }
        text(clam, 'aq-name aq-clam-name', o.name + (o.open ? ' · ' + o.since : o.unknown ? ' · ?' : ''));
      }

      if (d.alarms.length) {
        el('div', 'aq-murk', root);
        text(root, 'aq-banner', (d.alarms.length === 1 ? d.alarms[0] : d.alarms.join(' · ')) + ' — check it now');
      }
    }

    return {
      update: function (pr) { props = pr; sig = null; render(); },
      states: render,
      tick: function () { var m = CVRender.localParts(stage.now(), stage.tzOffsetMin).mi; if (m !== lastMinute) { lastMinute = m; render(); } }
    };
  }

  CVRender.register('aquarium', aquariumWidget);
})();
