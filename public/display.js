/* CoreView display client. ES5 only (the bedroom frame runs Chrome 44).
 *
 * 1. POST /api/hello: the server recognises this browser by its cookie or
 *    registers it and hands back a pairing code.
 * 2. Listen on /api/stream (Server-Sent Events): init (screen + view),
 *    states (Home Assistant changes), data (calendars, lists, forecasts,
 *    camera events), overlay (camera pop-up), timers (timer pop-up), kids (Grandkids mode), reload,
 *    unpaired. init carries the screen's view and the views it links to.
 *    Interactive widgets POST to /api/act; the server checks each request
 *    against the widget it came from.
 * 3. If the stream goes quiet or fails, reconnect; after a long outage,
 *    reload the page so a new version of this file is picked up.
 */
(function () {
  'use strict';

  var screenEl = document.getElementById('screen');
  var pairingEl = document.getElementById('pairing');
  var statusEl = document.getElementById('status');
  pairingEl.style.display = 'none';
  statusEl.style.display = 'none';
  var skew = 0, tzOffsetMin = 0, stage = null, source = null, lastMessage = 0, downSince = 0, deviceId = null;
  var nightDim = null, lastTouch = new Date().getTime(), dimmed = null;
  // An optional Android wrapper app can give
  // the page window.HouseBoard: setBrightness(level | -1), openSettings().
  var app = window.HouseBoard && window.HouseBoard.setBrightness ? window.HouseBoard : null;
  var dimEl = document.createElement('div');
  dimEl.className = 'night-dim';
  document.body.appendChild(dimEl);

  function xhr(method, url, body, cb) {
    var r = new XMLHttpRequest();
    r.open(method, url, true);
    r.setRequestHeader('Content-Type', 'application/json');
    r.timeout = 20000;
    r.onload = function () {
      var data = null;
      try { data = JSON.parse(r.responseText); } catch (e) { data = null; }
      if (r.status >= 200 && r.status < 300) cb(null, data); else cb(new Error('HTTP ' + r.status), data, r.status);
    };
    r.onerror = r.ontimeout = function () { cb(new Error('network')); };
    r.send(body ? JSON.stringify(body) : null);
  }

  // Script errors go to Studio's log (old frames have no reachable devtools).
  var errorsSent = 0;
  window.onerror = function (msg, src, line, col) {
    if (errorsSent >= 5) return;
    errorsSent++;
    try { xhr('POST', 'api/client-error', { msg: String(msg).slice(0, 300), src: String(src || '').replace(/^.*\//, '').slice(0, 80), line: line || 0, col: col || 0 }, function () {}); } catch (e) { /* ignore */ }
  };

  function showStatus(text) {
    statusEl.textContent = text || '';
    statusEl.style.display = text ? '' : 'none';
  }

  function ensureStage() {
    if (stage) return stage;
    stage = CVRender.create(screenEl, {
      now: function () { return new Date().getTime() + skew; },
      tzOffsetMin: tzOffsetMin,
      photoUrl: function (id) { return 'api/photo/' + id; },
      cameraUrl: function (cam) { return 'api/camera/' + cam; },
      personUrl: function (entity) { return 'api/person/' + entity; },
      frigateUrl: function (id, kind) { return 'api/frigate/' + encodeURIComponent(id) + '/' + kind; },
      jellyfinUrl: function (id, kind) { return 'api/jellyfin/' + id + '/' + kind; },
      // A view with a widget this page doesn't know: the page is older than the
      // server (a deploy since it loaded). Reload, at most once in 10 minutes.
      unknownWidget: function () {
        var last = 0;
        try { last = Number(window.sessionStorage.getItem('cvReloadedFor')) || 0; } catch (e) { last = 0; }
        if (new Date().getTime() - last < 600000) return;
        try { window.sessionStorage.setItem('cvReloadedFor', String(new Date().getTime())); } catch (e) { return; }
        setTimeout(function () { window.location.reload(); }, 500);
      },
      boardUrl: function (name, part) { return 'api/board/' + name + '/' + part; },
      api: function (method, path, body, cb) { xhr(method, path, body, function (err, data) { cb(err, data || {}); }); },
      act: function (args, cb) {
        xhr('POST', 'api/act', args, function (err, data) { cb(err, data && data.error); });
      },
      album: function (albumId, cb) {
        xhr('GET', 'api/album/' + albumId, null, function (err, data) { cb(err, data && data.photos); });
      }
    });
    return stage;
  }

  var codeVersion = null;
  function apply(payload) {
    // Studio was updated since this page loaded: load the new code.
    if (payload.codeVersion) {
      if (codeVersion && payload.codeVersion !== codeVersion) { window.location.reload(); return; }
      codeVersion = payload.codeVersion;
    }
    skew = payload.serverTime - new Date().getTime();
    tzOffsetMin = payload.tzOffsetMin || 0;
    deviceId = payload.deviceId;
    nightDim = payload.screen && payload.screen.nightDim && payload.screen.nightDim.on ? payload.screen.nightDim : null;
    dimCheck();
    if (!payload.paired || !payload.view) {
      if (stage) { stage.destroy(); stage = null; }
      pairingEl.style.display = '';
      document.getElementById('pairCode').textContent = payload.paired ? '✓' : payload.code || '—';
      document.getElementById('pairInfo').textContent = payload.paired
        ? 'Paired as ' + payload.screen.name + '. Waiting for a view…'
        : 'Waiting to be paired…';
      return;
    }
    pairingEl.style.display = 'none';
    var s = ensureStage();
    s.tzOffsetMin = tzOffsetMin;
    s.setStates(payload.states || {});
    s.data = {};
    s.setData(payload.data || {});
    s.kids = !!(payload.screen && payload.screen.kids);
    s.pinLength = (payload.screen && payload.screen.pinLength) || 0;
    if (payload.views && payload.viewId) s.setViews(payload.views, payload.viewId);
    else s.setView(payload.view);
    s.setTimers(payload.timers || []);
  }

  function on(es, name, fn) {
    es.addEventListener(name, function (e) {
      lastMessage = new Date().getTime();
      var data = null;
      try { data = JSON.parse(e.data); } catch (err) { data = null; }
      fn(data);
    }, false);
  }

  function connect() {
    if (source) { try { source.close(); } catch (e) { /* ignore */ } }
    lastMessage = new Date().getTime();
    var es = source = new EventSource('api/stream');
    on(es, 'init', function (d) { downSince = 0; showStatus(''); if (d) apply(d); });
    on(es, 'states', function (d) { if (stage && d) stage.setStates(d); });
    on(es, 'data', function (d) { if (stage && d) stage.setData(d); });
    on(es, 'overlay', function (d) { if (stage && d) stage.showOverlay(d); });
    on(es, 'timers', function (d) {
      if (!stage || !d) return;
      if (d.serverTime) skew = d.serverTime - new Date().getTime();
      stage.setTimers(d.timers || []);
    });
    on(es, 'kids', function (d) { if (stage && d) stage.setKids(d.kids); });
    on(es, 'ping', function () { downSince = 0; showStatus(''); });
    on(es, 'reload', function () { window.location.reload(); });
    on(es, 'unpaired', function () { es.close(); setTimeout(hello, 1000); });
    es.onerror = function () {
      if (!downSince) downSince = new Date().getTime();
      // A closed EventSource will not retry by itself (e.g. 401 after unpairing).
      if (es.readyState === 2) { setTimeout(hello, 10000); }
    };
  }

  function hello() {
    var w = window.innerWidth, h = window.innerHeight;
    xhr('POST', 'api/hello', { w: w, h: h }, function (err, data) {
      if (err || !data) {
        if (!downSince) downSince = new Date().getTime();
        setTimeout(hello, 10000);
        return;
      }
      downSince = 0;
      apply(data);
      connect();
    });
  }

  // Watchdog: the server sends a ping every 25 s. Silence for 70 s means the
  // stream is stuck (half-open connection); reconnect. Down for 10 minutes:
  // reload the whole page.
  setInterval(function () {
    var now = new Date().getTime();
    if (source && now - lastMessage > 70000) {
      if (!downSince) downSince = now;
      connect();
    }
    if (downSince && now - downSince > 30000) showStatus('Reconnecting…');
    if (downSince && now - downSince > 600000) window.location.reload();
  }, 5000);

  // ---------- night dim ----------
  function dimCheck() {
    var h = CVRender.localParts(new Date().getTime() + skew, tzOffsetMin).h, nd = nightDim;
    var night = !!nd && (nd.from > nd.to ? h >= nd.from || h < nd.to : h >= nd.from && h < nd.to);
    var want = night && new Date().getTime() - lastTouch > 120000;
    if (want === dimmed) return;
    dimmed = want;
    if (app) { app.setBrightness(want ? nd.brightness : -1); dimEl.style.opacity = want ? 0.35 : 0; }
    else dimEl.style.opacity = want ? 1 - Math.max(0.2, nd.brightness * 3) : 0;
  }
  setInterval(dimCheck, 5000);
  // Seven quick taps in the top-left corner open Android Settings (the kiosk's way out).
  var corner = [];
  function touched(x, y) {
    lastTouch = new Date().getTime();
    if (dimmed) dimCheck();
    if (!app || !app.openSettings) return;
    var k = Math.max(window.innerWidth, window.innerHeight) / 1920;
    if (x > 140 * k || y > 140 * k) { corner = []; return; }
    var now = new Date().getTime(), keep = [];
    for (var i = 0; i < corner.length; i++) if (now - corner[i] < 4000) keep.push(corner[i]);
    keep.push(now);
    corner = keep;
    if (corner.length >= 7) { corner = []; app.openSettings(); }
  }
  document.addEventListener('touchstart', function (e) { var t = e.touches && e.touches[0]; touched(t ? t.clientX : 9999, t ? t.clientY : 9999); }, true);
  document.addEventListener('mousedown', function (e) { touched(e.clientX, e.clientY); }, true);
  // A tablet that runs for weeks: reload once a night to shed any leaks.
  if (app) setInterval(function () { var d = new Date(); if (d.getHours() === 3 && d.getMinutes() === 30) window.location.reload(); }, 60000);

  window.addEventListener('resize', function () { if (stage) stage.resize(); }, false);
  hello();
})();
