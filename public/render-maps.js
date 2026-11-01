/* Map and Drive times widgets.
 *
 * Map: a dark grey street map (Esri) around a Home Assistant zone (zone.home by default)
 * with a weather-radar loop (the last 50 minutes, NWS NEXRAD) or live traffic
 * (TomTom). Tiles come through Studio (stage.tileUrl), which caches them and
 * keeps the TomTom key off the screens. Plain <img> tiles, no map library:
 * it runs on Chrome 44.
 *
 * Drive times: minutes from home to each place with live traffic, coloured by
 * how much traffic adds. Data: stage.data.drives from lib/drives.js.
 *
 * ES5 only, like render.js; tests/es5.test.js applies.
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear, pad = U.pad;

  function text(parent, cls, value) { var e = el('div', cls, parent); e.textContent = value; return e; }
  function clockText(ms, stage) {
    var p = CVRender.localParts(ms, stage.tzOffsetMin), h = p.h % 12 || 12;
    return h + ':' + pad(p.mi) + (p.h < 12 ? ' AM' : ' PM');
  }
  function zoneCenter(stage, id) {
    var s = U.stateOf(stage, id || 'zone.home'), a = s && s.attributes;
    return a && typeof a.latitude === 'number' && typeof a.longitude === 'number' ? { lat: a.latitude, lon: a.longitude } : null;
  }
  // Web Mercator in tile units at zoom z.
  function project(lat, lon, z) {
    var n = Math.pow(2, z), s = Math.sin(lat * Math.PI / 180);
    return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }

  var RADAR_AGO = [50, 40, 30, 20, 10, 0];
  var FRAME_MS = 650, HOLD_MS = 2600, REFRESH_MS = 5 * 60000;

  function mapWidget(box, stage) {
    var props = {}, key = '', frames = [], frameIdx = 0, animTimer = null, refreshTimer = null, period = 0;
    var wrap = el('div', 'cv-map-wrap', box);
    var note = null, caption = null;

    function stop() {
      if (animTimer) { clearTimeout(animTimer); animTimer = null; }
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    }
    // One layer of tiles covering the box. url(z, x, y) gives each tile.
    function tileLayer(g, cls, url) {
      var layer = el('div', 'cv-map-layer ' + cls, wrap), n = Math.pow(2, g.z);
      for (var ty = g.ty0; ty <= g.ty1; ty++) {
        if (ty < 0 || ty >= n) continue;
        for (var tx = g.tx0; tx <= g.tx1; tx++) {
          var img = el('img', 'cv-map-tile', layer);
          img.onerror = function () { this.style.visibility = 'hidden'; };
          img.style.left = Math.round(tx * g.t - g.left) + 'px';
          img.style.top = Math.round(ty * g.t - g.top) + 'px';
          img.style.width = img.style.height = Math.ceil(g.t) + 1 + 'px';
          img.src = url(g.z, ((tx % n) + n) % n, ty);
        }
      }
      return layer;
    }
    function showFrame(i) {
      for (var k = 0; k < frames.length; k++) frames[k].style.opacity = k === i ? '' : '0';
      if (caption) caption.textContent = 'Radar · ' + (RADAR_AGO[i] ? RADAR_AGO[i] + ' min ago' : 'now');
    }
    function animate() {
      frameIdx = (frameIdx + 1) % frames.length;
      showFrame(frameIdx);
      animTimer = setTimeout(animate, frameIdx === frames.length - 1 ? HOLD_MS : FRAME_MS);
    }

    function build() {
      stop();
      clear(wrap);
      frames = []; note = null; caption = null;
      var W = box.clientWidth, H = box.clientHeight, c = zoneCenter(stage, props.center);
      if (!W || !H) return;
      if (!c) { note = text(wrap, 'cv-map-note', 'Map · waiting for ' + (props.center || 'zone.home')); return; }
      var z = props.zoom || 8, t = Math.max(96, 256 * stage.height / 1080);
      var p = project(c.lat, c.lon, z), cx = p.x * t, cy = p.y * t;
      var g = { z: z, t: t, left: cx - W / 2, top: cy - H / 2 };
      g.tx0 = Math.floor(g.left / t); g.tx1 = Math.floor((g.left + W - 1) / t);
      g.ty0 = Math.floor(g.top / t); g.ty1 = Math.floor((g.top + H - 1) / t);
      period = Math.floor(stage.now() / REFRESH_MS);
      tileLayer(g, 'cv-map-base', function (zz, x, y) { return stage.tileUrl('base', zz, x, y, 0, 0); });
      var radar = props.layer !== 'traffic';
      if (radar) {
        for (var i = 0; i < RADAR_AGO.length; i++) {
          (function (fi) {
            var l = tileLayer(g, 'cv-map-radar', function (zz, x, y) { return stage.tileUrl('radar', zz, x, y, fi, period); });
            l.style.opacity = '0';
            frames.push(l);
          })(i);
        }
      } else {
        tileLayer(g, 'cv-map-traffic', function (zz, x, y) { return stage.tileUrl('traffic', zz, x, y, 0, period); });
      }
      tileLayer(g, 'cv-map-labels', function (zz, x, y) { return stage.tileUrl('labels', zz, x, y, 0, 0); });
      if (props.homeDot !== false) {
        var dot = el('div', 'cv-map-dot', wrap);
        dot.style.left = Math.round(W / 2) + 'px'; dot.style.top = Math.round(H / 2) + 'px';
      }
      if (props.title) text(wrap, 'cv-map-title', props.title);
      caption = text(wrap, 'cv-map-caption', radar ? '' : 'Traffic · ' + clockText(stage.now(), stage));
      text(wrap, 'cv-map-credit', radar ? 'Esri, HERE, Garmin, © OpenStreetMap · NWS radar via Iowa State' : 'Esri, HERE, Garmin, © OpenStreetMap · TomTom traffic');
      if (radar) {
        frameIdx = frames.length - 1;
        showFrame(frameIdx);
        if (!stage.editing && props.loop !== false) animTimer = setTimeout(animate, HOLD_MS);
      }
      if (!stage.editing) refreshTimer = setTimeout(build, REFRESH_MS - (stage.now() % REFRESH_MS) + 20000);
    }

    return {
      update: function (pr) {
        props = pr;
        box.style.fontSize = (props.size || 1.6) * stage.height / 100 + 'px';
        box.style.borderRadius = (props.radius || 0) * stage.height / 100 + 'px';
        key = '';
        this.states();
      },
      // Rebuild only when something that moves the map changed.
      states: function () {
        var c = zoneCenter(stage, props.center);
        var k = [box.clientWidth, box.clientHeight, props.layer, props.zoom, props.center, props.homeDot, props.loop, props.title,
          c ? c.lat.toFixed(4) + ',' + c.lon.toFixed(4) : ''].join('|');
        if (k === key) return;
        key = k;
        build();
      },
      destroy: stop
    };
  }

  // ---------- Drive times ----------
  function drivesWidget(box, stage) {
    var props = {};
    function render() {
      clear(box);
      U.styleBox(box, props, stage);
      box.style.fontSize = (props.size || 1.6) * stage.height / 100 + 'px';
      box.className = 'cv-widget cv-drives' + (props.outline ? ' cv-outline' : '');
      var d = stage.data.drives, routes = (d && d.routes) || {}, rows = props.rows || [];
      if (props.title) text(box, 'cv-drives-title cv-acc', props.title);
      if (!rows.length) { text(box, 'cv-drives-note', stage.editing ? 'Add places in the widget settings' : ''); return; }
      var list = el('div', 'cv-drives-list', box), lastWho = null, newest = 0, anyLive = false;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], x = routes[r.to] || null;
        var row = el('div', 'cv-drives-row', list);
        var left = el('div', 'cv-drives-left', row);
        if (r.who && r.who !== lastWho) text(left, 'cv-drives-who', r.who);
        else if (r.who) el('div', 'cv-drives-who cv-drives-same', left).textContent = r.who;
        lastWho = r.who;
        text(left, 'cv-drives-place', r.label || r.to);
        var right = el('div', 'cv-drives-right', row);
        if (x && typeof x.minutes === 'number') {
          anyLive = true;
          if (x.at > newest) newest = x.at;
          var extra = Math.max(0, x.minutes - x.free), level = extra >= 10 ? 'heavy' : extra >= 4 ? 'slow' : 'clear';
          var mins = el('div', 'cv-drives-min cv-acc cv-drives-' + level, right);
          mins.textContent = x.minutes >= 60 ? Math.floor(x.minutes / 60) + 'h ' + (x.minutes % 60) + 'm' : x.minutes + ' min';
          text(right, 'cv-drives-sub', (level === 'clear' ? 'Clear' : '+' + extra + ' traffic') + ' · ' + x.miles + ' mi' + (x.stale ? ' · old' : ''));
        } else {
          text(right, 'cv-drives-min cv-acc cv-drives-none', '—');
          text(right, 'cv-drives-sub', x && x.error ? 'Unavailable' : 'Checking…');
        }
      }
      var foot = anyLive ? 'Live traffic · ' + clockText(newest, stage) : d && d.error ? d.error : '';
      if (foot) text(box, 'cv-drives-foot', foot);
    }
    return {
      update: function (pr) { props = pr; render(); },
      data: render
    };
  }

  // ---------- Gas prices ----------
  // Rows of Home Assistant price sensors (GasBuddy): the cheapest price in
  // each column is highlighted; rows sort by the regular price.
  function gasWidget(box, stage) {
    var props = {};
    function price(id) {
      var s = id ? U.stateOf(stage, id) : null, n = s ? parseFloat(s.state) : NaN;
      return isFinite(n) && n > 0 ? { n: n, s: s } : null;
    }
    function render() {
      clear(box);
      U.styleBox(box, props, stage);
      box.style.fontSize = (props.size || 1.6) * stage.height / 100 + 'px';
      box.className = 'cv-widget cv-gas' + (props.outline ? ' cv-outline' : '');
      if (props.title) text(box, 'cv-gas-title cv-acc', props.title);
      var rows = [], src = props.rows || [], hasPremium = false, best = { r: Infinity, p: Infinity }, newest = 0, i;
      for (i = 0; i < src.length; i++) {
        var r = { label: src[i].label, reg: price(src[i].regular), prem: price(src[i].premium), at: 0 };
        if (src[i].premium) hasPremium = true;
        if (r.reg && r.reg.n < best.r) best.r = r.reg.n;
        if (r.prem && r.prem.n < best.p) best.p = r.prem.n;
        var any = r.reg || r.prem, addr = any && any.s.attributes && any.s.attributes.address;
        r.addr = addr ? String(addr).split(',')[0] : '';
        if (any && any.s.last_changed) newest = Math.max(newest, Date.parse(any.s.last_changed) || 0);
        rows.push(r);
      }
      if (!rows.length) { text(box, 'cv-gas-note', stage.editing ? 'Add stations in the widget settings' : ''); return; }
      if (props.sort !== false) rows.sort(function (a, b) { return (a.reg ? a.reg.n : 99) - (b.reg ? b.reg.n : 99); });
      var head = el('div', 'cv-gas-row cv-gas-head', box);
      el('div', 'cv-gas-name', head);
      text(head, 'cv-gas-col', props.regularLabel || 'Regular');
      if (hasPremium) text(head, 'cv-gas-col', props.premiumLabel || 'Premium');
      for (i = 0; i < rows.length; i++) {
        var row = el('div', 'cv-gas-row', box), name = el('div', 'cv-gas-name', row);
        text(name, 'cv-gas-label', rows[i].label || 'Station');
        if (rows[i].addr) text(name, 'cv-gas-addr', rows[i].addr);
        cell(row, rows[i].reg, best.r);
        if (hasPremium) cell(row, rows[i].prem, best.p);
      }
      if (newest) text(box, 'cv-gas-foot', 'GasBuddy · ' + clockText(newest, stage));
    }
    function cell(row, v, best) {
      var c = text(row, 'cv-gas-col cv-gas-price', v ? '$' + v.n.toFixed(2) : '—');
      if (v && v.n === best) c.className += ' cv-gas-best cv-acc';
      if (!v) c.className += ' cv-gas-none';
    }
    return {
      update: function (pr) { props = pr; render(); },
      states: render
    };
  }

  CVRender.register('gas', gasWidget);
  CVRender.register('map', mapWidget);
  CVRender.register('drives', drivesWidget);
})();
