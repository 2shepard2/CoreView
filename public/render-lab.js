/* The Terrarium: the lab at a glance as a living glass tank. One plant per
 * Proxmox host (leaves = running guests; it scorches when hot, sways faster
 * when busy, wilts when down, drops a leaf per stopped guest), a firefly per
 * service probe (down ones fall to the soil as red embers), the tank pool as
 * a water vial, and a bloom for the one service that matters (Immich).
 * Storage: a rack of vials (tank, the NAS, the backup SSD) and, under each
 * plant, roots for the host's own disks: they spread as its pool fills and
 * turn amber (worn, filling) or red (failing, degraded, full).
 * Data: stage.data.lab from lib/lab.js (Prometheus).
 *
 * ES5 only, like render.js; tests/es5.test.js applies. Sizes are in em of
 * the widget (size 2.03 on a 492-high screen = 1em 10px).
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear, pad = U.pad, DAYS = U.DAYS, MONTHS = U.MONTHS;

  function text(parent, cls, value) { var e = el('div', cls, parent); e.textContent = value; return e; }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h; }
  function rnd(seed) { var x = seed % 2147483647 || 1; return function () { x = (x * 16807) % 2147483647; return x / 2147483647; }; }
  function pct(n) { return n === null || n === undefined ? '—' : Math.round(n * 100) + '%'; }
  function nice(name) { return String(name || '').replace(/_/g, ' '); }

  // A host's own storage: ok | warn | bad, with the reason.
  function diskState(st) {
    if (!st) return { level: 'ok', why: '' };
    var bad = [], warn = [], i;
    if (st.poolsDegraded && st.poolsDegraded.length) bad.push('pool ' + st.poolsDegraded.join(', '));
    for (i = 0; i < (st.disks || []).length; i++) {
      var d = st.disks[i];
      if (d.healthy === false) bad.push(d.device + ' failing SMART');
      if (d.critical > 0) bad.push(d.device + ' critical warning');
      if (d.mediaErrors > 0) bad.push(d.device + ' media errors');
      if (d.wear !== null && d.wear >= 0.7) warn.push(d.device + ' ' + Math.round(d.wear * 100) + '% worn');
    }
    if (st.localUsed !== null && st.localUsed >= 0.95) bad.push('disk ' + Math.round(st.localUsed * 100) + '% full');
    else if (st.localUsed !== null && st.localUsed >= 0.85) warn.push('disk ' + Math.round(st.localUsed * 100) + '% full');
    return bad.length ? { level: 'bad', why: bad.join(', ') } : warn.length ? { level: 'warn', why: warn.join(', ') } : { level: 'ok', why: '' };
  }
  // Roots in the soil (viewBox 0 0 100 60): they spread with the pool's fill.
  function rootsSvg(used, level, seed) {
    var r = rnd(seed), n = 3 + Math.round(Math.max(0.05, used || 0) * 9), out = [];
    var col = level === 'bad' ? '#ff6b5a' : level === 'warn' ? '#e7a93c' : '#d8b98a';
    for (var i = 0; i < n; i++) {
      var dir = (i / Math.max(1, n - 1) - 0.5) * 2, len = 18 + (used || 0) * 34 + r() * 8;
      var x2 = 50 + dir * len * 0.9, y2 = 4 + len * (0.55 + r() * 0.35);
      out.push('<path d="M50,0 C' + (50 + dir * 4).toFixed(1) + ',' + (y2 * 0.4).toFixed(1) + ' ' + (50 + dir * len * 0.5).toFixed(1) + ',' + (y2 * 0.6).toFixed(1) + ' ' + x2.toFixed(1) + ',' + y2.toFixed(1) +
        '" stroke="' + col + '" stroke-width="' + (1.8 - i % 3 * 0.4).toFixed(1) + '" fill="none" stroke-linecap="round" opacity="0.75"/>');
    }
    return '<svg viewBox="0 0 100 60" preserveAspectRatio="none">' + out.join('') + '</svg>';
  }
  function size(bytes) { return bytes === null || bytes === undefined ? '' : bytes >= 1e12 ? (bytes / 1e12).toFixed(1) + ' TB' : Math.round(bytes / 1e9) + ' GB'; }

  // ---------- one plant as SVG (viewBox 0 0 120 220, soil at y=220) ----------
  function plantSvg(p, seed) {
    var r = rnd(seed), leaves = p.leaves, h = 70 + leaves * 9.5, top = 220 - h, out = [];
    var stem = p.dead ? '#6b5236' : '#3f8f55', leafA = p.dead ? '#8a6a44' : '#58c477', leafB = p.dead ? '#6b5236' : '#2f8a4e';
    var tip = p.hot ? '#e7a93c' : leafA;
    var bend = (r() - 0.5) * 24;
    out.push('<path d="M60,220 C60,' + (220 - h * 0.4) + ' ' + (60 + bend) + ',' + (220 - h * 0.7) + ' ' + (60 + bend * 0.6) + ',' + top +
      '" fill="none" stroke="' + stem + '" stroke-width="3.2" stroke-linecap="round"/>');
    for (var i = 0; i < leaves; i++) {
      var t = 0.18 + 0.8 * i / Math.max(1, leaves - 1), y = 220 - h * t;
      var x = 60 + bend * Math.min(1, t * 1.2) * (t > 0.7 ? 0.6 / t * 0.9 : 1) * 0.9;
      var side = i % 2 ? 1 : -1, len = 42 - 20 * t + r() * 8, ang = side * (34 + r() * 22) + (p.dead ? side * 70 : 0);
      var c = i > leaves - 3 && p.hot ? tip : (i % 3 === 0 ? leafB : leafA);
      out.push('<g transform="translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ') rotate(' + (side > 0 ? ang - 90 : ang + 270) + ')">' +
        '<path d="M0,0 C' + (len * 0.25) + ',-' + (len * 0.32) + ' ' + (len * 0.75) + ',-' + (len * 0.3) + ' ' + len + ',0 C' + (len * 0.75) + ',' + (len * 0.22) + ' ' + (len * 0.25) + ',' + (len * 0.24) + ' 0,0Z" fill="' + c + '"/>' +
        '<path d="M2,0 L' + (len * 0.85) + ',0" stroke="rgba(0,0,0,0.18)" stroke-width="0.8"/></g>');
    }
    // The bloom: open when the precious service is up, a drooping bud when not.
    if (p.bloom !== null) {
      var bx = 60 + bend * 0.6, by = top;
      if (p.bloom) {
        for (var k = 0; k < 6; k++) out.push('<ellipse cx="' + bx + '" cy="' + (by - 7) + '" rx="4.5" ry="9" fill="#ff8fc0" transform="rotate(' + k * 60 + ' ' + bx + ' ' + by + ')"/>');
        out.push('<circle cx="' + bx + '" cy="' + by + '" r="4.2" fill="#ffd36b"/>');
      } else out.push('<ellipse cx="' + (bx + 5) + '" cy="' + (by + 6) + '" rx="4" ry="7" fill="#8f5a6e" transform="rotate(140 ' + (bx + 5) + ' ' + (by + 6) + ')"/>');
    }
    return '<svg viewBox="0 0 120 220" preserveAspectRatio="xMidYMax meet">' + out.join('') + '</svg>';
  }

  function terrariumWidget(box, stage, id) {
    var root = el('div', 'tr-root', box);
    var head = el('div', 'tr-head', root), tank = el('div', 'tr-tank', root), plinth = el('div', 'tr-plinth', root);
    el('div', 'tr-glass', tank);
    el('div', 'tr-lamp', tank);
    // Fireflies live in their own layer, rebuilt only when a service changes,
    // so they keep flying through data refreshes.
    var dyn = el('div', 'tr-dyn', tank), sky = el('div', 'tr-sky', tank);
    // Moss tufts and pebbles along the soil line (decoration, built once).
    var ground = el('div', 'tr-ground', tank), gr = rnd(7), gsvg = [];
    for (var gi = 0; gi < 26; gi++) {
      var gx = (gr() * 1000).toFixed(0), gh = 10 + gr() * 16, gc = gr() > 0.5 ? '#4f9b5a' : '#3d8550';
      gsvg.push('<path d="M' + gx + ',40 q-4,-' + gh + ' -9,-' + (gh + 4) + ' M' + gx + ',40 q1,-' + (gh + 6) + ' 2,-' + (gh + 9) + ' M' + gx + ',40 q5,-' + gh + ' 10,-' + (gh + 2) +
        '" stroke="' + gc + '" stroke-width="2.4" fill="none" stroke-linecap="round"/>');
    }
    for (gi = 0; gi < 14; gi++) {
      var px = (gr() * 1000).toFixed(0), pr = 5 + gr() * 9, shade = 90 + Math.round(gr() * 50);
      gsvg.push('<ellipse cx="' + px + '" cy="' + (42 - pr * 0.25).toFixed(1) + '" rx="' + pr.toFixed(1) + '" ry="' + (pr * 0.62).toFixed(1) + '" fill="rgb(' + shade + ',' + (shade + 6) + ',' + (shade + 2) + ')"/>');
    }
    ground.innerHTML = '<svg viewBox="0 0 1000 48" preserveAspectRatio="none">' + gsvg.join('') + '</svg>';
    var props = {}, lastMinute = -1, skySig = null, timeEl = null, dateEl = null;
    function clock() {
      var now = CVRender.localParts(stage.now(), stage.tzOffsetMin), h = now.h % 12 || 12;
      if (timeEl) timeEl.textContent = h + ':' + pad(now.mi) + (now.h < 12 ? ' AM' : ' PM');
      if (dateEl) dateEl.textContent = DAYS[now.wd] + ', ' + MONTHS[now.mo] + ' ' + now.d;
    }
    // Animation delays from the wall clock, so a redraw doesn't restart a sway.
    function phase(dur, offset) { return -(((stage.now() / 1000) + offset) % dur).toFixed(2) + 's'; }
    tank.onclick = function (e) { if (stage.editing) return; e.stopPropagation(); servicesSheet(); };

    function lab() { return stage.data.lab || null; }
    function hostOf(svc, d) {
      // Which Proxmox host runs the service's guest (its host label is the guest name).
      for (var i = 0; i < d.hosts.length; i++) for (var j = 0; j < d.hosts[i].guests.length; j++) if (d.hosts[i].guests[j].name === svc.host) return d.hosts[i].name;
      return null;
    }
    function status(d) {
      var down = [], i;
      for (i = 0; i < d.hosts.length; i++) if (!d.hosts[i].up) down.push(d.hosts[i].name);
      for (i = 0; i < d.services.length; i++) if (!d.services[i].up) down.push(nice(d.services[i].name));
      for (i = 0; i < d.hosts.length; i++) if (d.hosts[i].up && diskState(d.hosts[i].storage).level === 'bad') down.push(d.hosts[i].name + ' disk');
      for (i = 0; i < (d.stores || []).length; i++) if (d.stores[i].up === false || d.stores[i].used >= 0.95) down.push(d.stores[i].label + (d.stores[i].up === false ? ' not answering' : ' full'));
      var guests = 0, run = 0;
      for (i = 0; i < d.hosts.length; i++) { guests += d.hosts[i].guests.length; run += d.hosts[i].running; }
      return { down: down, guests: guests, running: run };
    }

    function render() {
      clear(head); clear(dyn); clear(plinth);
      var d = lab(), now = CVRender.localParts(stage.now(), stage.tzOffsetMin);
      // ---------- header ----------
      var left = el('div', 'tr-head-l', head);
      text(left, 'tr-title cv-acc', props.title || 'Terrarium');
      var line = el('div', 'tr-status', left);
      var right = el('div', 'tr-head-r', head);
      timeEl = el('div', 'tr-time', right); dateEl = el('div', 'tr-date', right);
      clock();
      var soil = el('div', 'tr-soil', dyn);
      if (!d || !d.hosts) {
        clear(sky); skySig = null;
        line.textContent = d && d.error ? 'Can\'t reach Prometheus: ' + d.error : stage.editing ? 'The lab appears here once Prometheus answers' : 'Waking up…';
        return;
      }
      var st = status(d);
      if (st.down.length) { line.className = 'tr-status tr-bad'; line.textContent = 'Needs a look: ' + st.down.slice(0, 4).join(', ') + (st.down.length > 4 ? ' +' + (st.down.length - 4) : ''); }
      else line.textContent = 'All quiet · ' + d.services.length + ' services up · ' + st.running + ' of ' + st.guests + ' guests running';
      if (d.stale) line.textContent += ' · last seen a while ago';
      line.onclick = function (e) { if (stage.editing) return; e.stopPropagation(); servicesSheet(); };
      line.className += ' tr-tappable';
      var net = d.internet || {};
      if (net.down !== null && net.down !== undefined) text(right, 'tr-net', '↓ ' + Math.round(net.down) + '  ↑ ' + Math.round(net.up) + ' Mbps · ' + net.ping + ' ms');

      // ---------- plants ----------
      var precious = String(props.precious || '').toLowerCase(), bloomHost = null, bloomUp = null, i;
      for (i = 0; i < d.services.length; i++) if (d.services[i].name.toLowerCase() === precious) { bloomHost = hostOf(d.services[i], d); bloomUp = d.services[i].up; }
      var n = d.hosts.length, bed = el('div', 'tr-bed', dyn);
      var labels = el('div', 'tr-labels', plinth);
      for (i = 0; i < n; i++) (function (hst, i) {
        var hot = hst.temp !== null && hst.temp >= (props.hotTemp || 85), busy = hst.cpu !== null && hst.cpu * 100 >= (props.busyCpu || 75);
        var slot = el('div', 'tr-slot', bed);
        slot.style.left = (i + 0.5) * 100 / n + '%';
        var sway = el('div', 'tr-sway' + (hst.up ? (busy ? ' tr-busy' : '') : ' tr-still'), slot);
        sway.style.webkitAnimationDelay = sway.style.animationDelay = phase(busy ? 2.4 : 6, hash(hst.name) % 60 / 10);
        sway.innerHTML = plantSvg({ leaves: Math.max(3, Math.min(15, Math.round((hst.up ? hst.running : hst.guests.length) * 1.3))), dead: !hst.up, hot: hot, bloom: hst.name === bloomHost ? bloomUp : null }, hash(hst.name));
        if (hot && hst.up) for (var k = 0; k < 3; k++) { var w = el('div', 'tr-heat', slot); w.style.left = 35 + k * 15 + '%'; w.style.webkitAnimationDelay = w.style.animationDelay = phase(2.1, k * 0.7); }
        // The plant's spot on the soil (the bed spans 2%..79% of the tank).
        var soilX = 2 + (i + 0.5) * 77 / n;
        // Roots: the host's own pool and disks.
        var ds = diskState(hst.storage), roots = el('div', 'tr-roots tr-roots-' + ds.level, soil);
        roots.style.left = soilX + '%';
        roots.innerHTML = rootsSvg(hst.storage ? hst.storage.localUsed : 0, ds.level, hash(hst.name + 'root'));
        // A fallen leaf per stopped guest (up to six).
        var stopped = hst.guests.length - hst.running, rr = rnd(hash(hst.name + 'leaf'));
        for (var f = 0; f < Math.min(6, stopped); f++) {
          var leaf = el('div', 'tr-fallen', soil);
          leaf.style.left = 'calc(' + soilX + '% + ' + ((rr() - 0.5) * 9).toFixed(1) + 'em)';
          leaf.style.top = (15 + rr() * 45) + '%';
          leaf.style.webkitTransform = leaf.style.transform = 'rotate(' + Math.round(rr() * 360) + 'deg)';
        }
        // Label on the plinth.
        var lab2 = el('div', 'tr-label' + (hst.up ? '' : ' tr-label-down'), labels);
        lab2.style.left = (i + 0.5) * 100 / n + '%';
        text(lab2, 'tr-hname', (hst.label || hst.name));
        var facts = el('div', 'tr-facts', lab2);
        if (!hst.up) facts.textContent = 'not answering';
        else {
          facts.appendChild(document.createTextNode(hst.running + ' guests · ' + pct(hst.cpu) + ' · '));
          var t = el('span', hot ? 'tr-hot' : '', facts);
          t.textContent = hst.temp === null ? '—' : hst.temp + '°';
        }
        var used = hst.storage && hst.storage.localUsed !== undefined ? hst.storage.localUsed : null, wear = null;
        for (var dk = 0; hst.storage && dk < hst.storage.disks.length; dk++) if (hst.storage.disks[dk].wear !== null) wear = Math.max(wear || 0, hst.storage.disks[dk].wear);
        if (hst.up && (used !== null || wear !== null)) {
          var disk = text(lab2, 'tr-disk tr-disk-' + ds.level, ds.level === 'bad' ? '⚠ ' + ds.why.split(', ')[0] :
            'disk ' + (used === null ? '—' : Math.round(used * 100) + '%') + (wear === null ? '' : ' · ' + Math.round(wear * 100) + '% worn'));
          disk.title = ds.why;
        }
        if (hst.name === bloomHost) text(lab2, 'tr-bloomtag' + (bloomUp ? '' : ' tr-bad'), (bloomUp ? '✿ ' : '✕ ') + nice(precious) + (bloomUp ? '' : ' is down'));
        var tapHost = function (e) { if (stage.editing) return; e.stopPropagation(); hostSheet(hst.name); };
        slot.onclick = tapHost; lab2.onclick = tapHost;
      })(d.hosts[i], i);

      // ---------- fireflies (up) and embers (down) ----------
      var sig = '', embers = 0;
      for (i = 0; i < d.services.length; i++) sig += d.services[i].name + (d.services[i].up ? '+' : '-');
      var rebuild = sig !== skySig;
      if (rebuild) { clear(sky); skySig = sig; }
      for (i = 0; i < d.services.length; i++) {
        var s = d.services[i], r2 = rnd(hash(s.name));
        if (s.up && rebuild) {
          var fly = el('div', 'tr-fly' + (s.core ? ' tr-core' : ''), sky);
          fly.style.left = (4 + r2() * 88) + '%'; fly.style.top = (6 + r2() * 46) + '%';
          var dur = (7 + r2() * 9).toFixed(1) + 's', del = (-r2() * 12).toFixed(1) + 's', path = 'tr-drift' + (1 + Math.floor(r2() * 3));
          fly.style.webkitAnimation = fly.style.animation = path + ' ' + dur + ' ease-in-out ' + del + ' infinite, tr-glow ' + (2 + r2() * 3).toFixed(1) + 's ease-in-out ' + del + ' infinite';
        } else if (!s.up) {
          var ember = el('div', 'tr-ember', soil);
          ember.style.left = (8 + (embers * 19) % 80) + '%';
          ember.style.top = (embers % 2 ? 50 : 22) + '%';
          text(ember, 'tr-ember-n', nice(s.name));
          embers++;
        }
      }

      // ---------- storage: a rack of vials ----------
      var rack = el('div', 'tr-rack', dyn), stores = d.stores || [{ name: 'tank', label: 'tank', up: true, used: (d.tank || {}).used }];
      var tankBad = ((d.tank || {}).poolsDegraded || []).length > 0;
      for (i = 0; i < stores.length; i++) (function (sto) {
        var u = sto.used, lvl = sto.up === false || (sto.name === 'tank' && tankBad) || u >= 0.95 ? 'bad' : u >= 0.85 ? 'warn' : 'ok';
        var vial = el('div', 'tr-vial tr-vial-' + sto.name + (lvl === 'ok' ? '' : ' tr-vial-' + lvl) + (sto.up === false ? ' tr-vial-gone' : ''), rack);
        var water = el('div', 'tr-water', vial);
        water.style.height = u === null || u === undefined || sto.up === false ? '0' : Math.round(u * 100) + '%';
        text(vial, 'tr-vial-l', sto.label);
        text(vial, 'tr-vial-v', sto.up === false ? '?' : u === null || u === undefined ? '—' : Math.round(u * 100) + '%');
        vial.onclick = function (e) { if (stage.editing) return; e.stopPropagation(); storageSheet(); };
      })(stores[i]);
      if (tankBad) text(dyn, 'tr-tag tr-bad-tag', 'pool ' + d.tank.poolsDegraded.join(', '));

      // ---------- firing alerts: a paper tag on the glass ----------
      if ((d.alerts || []).length) {
        var tag = text(dyn, 'tr-tag', '⚠ ' + d.alerts.length + ' alert' + (d.alerts.length > 1 ? 's' : ''));
        tag.onclick = function (e) { if (stage.editing) return; e.stopPropagation(); alertsSheet(); };
      }
    }

    // ---------- sheets ----------
    function row(body, dotCls, label, value) {
      var r = el('div', 'tr-row', body);
      el('i', 'tr-dot ' + dotCls, r);
      text(r, 'tr-row-l', label);
      if (value) text(r, 'tr-row-v', value);
    }
    function hostSheet(name) {
      var d = lab(), hst = null, i;
      for (i = 0; i < d.hosts.length; i++) if (d.hosts[i].name === name) hst = d.hosts[i];
      if (!hst) return;
      var owner = { widget: id };
      var body = stage.openSheet(hst.name, owner);
      owner.redraw = function () {
        clear(body);
        text(body, 'hh-p', hst.up ? 'CPU ' + pct(hst.cpu) + ' · memory ' + pct(hst.mem) + ' · hottest sensor ' + (hst.temp === null ? '—' : hst.temp + '°C') +
          (hst.uptimeDays !== null ? ' · up ' + hst.uptimeDays + ' day' + (hst.uptimeDays === 1 ? '' : 's') : '') : 'Not answering Prometheus.');
        var st = hst.storage, ds = diskState(st);
        if (st) {
          text(body, 'tr-group', 'Storage');
          row(body, ds.level === 'bad' ? 'tr-down' : ds.level === 'warn' ? 'tr-warn' : 'tr-ok', 'local ZFS pool', st.localUsed === null ? '—' : Math.round(st.localUsed * 100) + '% full');
          for (var q = 0; q < st.disks.length; q++) {
            var dd = st.disks[q], dstate = diskState({ disks: [dd], localUsed: null, poolsDegraded: [] });
            row(body, dstate.level === 'bad' ? 'tr-down' : dstate.level === 'warn' ? 'tr-warn' : 'tr-ok', dd.device + (dd.model ? ' · ' + dd.model : ''),
              dstate.level === 'bad' ? dstate.why : (dd.wear !== null ? Math.round(dd.wear * 100) + '% worn' : dd.healthy ? 'SMART ok' : ''));
          }
          text(body, 'tr-group', 'Guests');
        }
        var list = el('div', 'tr-list', body);
        for (var j = 0; j < hst.guests.length; j++) {
          var g = hst.guests[j];
          row(list, g.up ? 'tr-ok' : 'tr-off', g.id + ' ' + g.name, (g.type === 'qemu' ? 'VM' : 'CT') + (g.up ? '' : ' · stopped'));
        }
      };
      owner.redraw();
    }
    function servicesSheet() {
      var d = lab();
      if (!d || !d.services) return;
      var body = stage.openSheet('Services');
      var groups = {}, order = [], i;
      for (i = 0; i < d.services.length; i++) {
        var s = d.services[i];
        if (!groups[s.category]) { groups[s.category] = []; order.push(s.category); }
        groups[s.category].push(s);
      }
      order.sort();
      var list = el('div', 'tr-list tr-cols', body);
      for (i = 0; i < order.length; i++) {
        text(list, 'tr-group', order[i]);
        var g = groups[order[i]].sort(function (a, b) { return a.up === b.up ? (a.name < b.name ? -1 : 1) : a.up ? 1 : -1; });
        for (var j = 0; j < g.length; j++) row(list, g[j].up ? 'tr-ok' : 'tr-down', nice(g[j].name) + (g[j].core ? ' ★' : ''), g[j].up ? '' : 'down');
      }
    }
    function storageSheet() {
      var d = lab(), body = stage.openSheet('Storage');
      var stores = d.stores || [];
      for (var i = 0; i < stores.length; i++) {
        var s2 = stores[i], u = s2.used;
        row(body, s2.up === false || u >= 0.95 ? 'tr-down' : u >= 0.85 ? 'tr-warn' : 'tr-ok', s2.label + ' · ' + s2.note,
          s2.up === false ? 'not answering' : (u === null ? '—' : Math.round(u * 100) + '% of ' + size(s2.size)));
      }
      text(body, 'tr-group', 'Hosts');
      for (i = 0; i < d.hosts.length; i++) {
        var h = d.hosts[i], ds = diskState(h.storage);
        row(body, ds.level === 'bad' ? 'tr-down' : ds.level === 'warn' ? 'tr-warn' : 'tr-ok', h.name, ds.why || (h.storage && h.storage.localUsed !== null ? 'disk ' + Math.round(h.storage.localUsed * 100) + '% · healthy' : ''));
      }
    }
    function alertsSheet() {
      var d = lab(), body = stage.openSheet('Alerts');
      for (var i = 0; i < d.alerts.length; i++) {
        var a = d.alerts[i];
        row(body, a.severity === 'critical' ? 'tr-down' : 'tr-warn', a.name + (a.instance ? ' · ' + a.instance : ''), a.severity);
        if (a.summary) text(body, 'tr-summary', a.summary);
      }
    }

    return {
      update: function (pr) { props = pr; box.style.fontSize = (props.size || 2.03) * stage.height / 100 + 'px'; render(); },
      data: render,
      tick: function () { var m = CVRender.localParts(stage.now(), stage.tzOffsetMin).mi; if (m !== lastMinute) { lastMinute = m; clock(); } }
    };
  }

  CVRender.register('terrarium', terrariumWidget);
})();
