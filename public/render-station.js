/* The Station: four routes, one small world. ES5 / Chrome 44.
 * Host -> a stop on Hosts; hot or busy = amber, down = red closure.
 * Store (tank fallback) -> Storage stop; nearly full = amber, degraded/down = red.
 * Service overflow -> at most four labelled stops per Services track. Keep
 * every down/unknown service (down first), then healthy core services if
 * there is room; summarise the other healthy probes as "+N more, all running".
 * Up to four services fit without summarising. Extra problems get continuation
 * tracks, never hidden in a healthy count. Many tracks scroll vertically.
 * Firewall + internet -> Outside stops; hot/slow = amber, gateway down = red.
 * Healthy -> soft coloured stops, trains make short visits (2 seconds).
 * Warning/closure -> named problem, train waits longer (10 seconds).
 * Unknown source -> grey stop, still train; missing/failed/stale lab -> grey,
 * still map and "Can't hear the lab". No previous healthy picture is retained.
 * Sun below horizon -> dim night station. No sun answer -> neutral lighting.
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util;
  function text(parent, cls, value) {
    var e = U.el('div', cls, parent); e.textContent = value; return e;
  }
  function stop(name, level, why) { return { name: name, level: level, why: why || '' }; }
  function serviceRoutes(services) {
    var selected = [], healthy = [], core = [], i, s, room, chunks = [];
    for (i = 0; i < services.length; i++) {
      s = services[i];
      if (s.level === 'bad') selected.push(s);
      else if (s.level === 'ok') { healthy.push(s); if (s.core) core.push(s); }
    }
    for (i = 0; i < services.length; i++) if (services[i].level === 'unknown') selected.push(services[i]);
    if (services.length <= 4) selected = services;
    else {
      room = Math.max(0, 3 - selected.length);
      for (i = 0; i < Math.min(room, core.length); i++) selected.push(core[i]);
      var hidden = healthy.length - Math.min(room, core.length);
      if (hidden) selected.push(stop('+' + hidden + ' more', 'ok', 'all running'));
    }
    for (i = 0; i < selected.length; i += 4) {
      var stops = selected.slice(i, i + 4), j;
      for (j = 0; j < stops.length; j++) stops[j].x = (j + 0.5) * 100 / stops.length;
      chunks.push({ name: i ? 'Services (cont.)' : 'Services', kind: 'services', stops: stops });
    }
    return chunks.length ? chunks : [{ name: 'Services', kind: 'services', stops: [] }];
  }
  function position(stops, index) {
    return typeof stops[index].x === 'number' ? stops[index].x : stops.length === 1 ? 50 : 8 + index * 84 / (stops.length - 1);
  }
  function storage(s, name) {
    if (s.up === false || (s.poolsDegraded || []).length) return stop(name, 'bad', s.up === false ? 'offline' : 'storage needs repair');
    if (s.used >= 0.95) return stop(name, 'bad', 'storage full');
    if (s.used >= 0.85) return stop(name, 'warn', 'nearly full');
    return stop(name, typeof s.used === 'number' ? 'ok' : 'unknown', '');
  }
  function routes(d) {
    var hosts = [], stores = [], services = [], outside = [], i, h, level, why;
    for (i = 0; i < (d.hosts || []).length; i++) {
      h = d.hosts[i]; level = h.up === true ? 'ok' : h.up === false ? 'bad' : 'unknown';
      why = level === 'bad' ? 'offline' : '';
      if (level === 'ok' && (h.temp >= 85 || h.cpu >= 0.75)) { level = 'warn'; why = h.temp >= 85 ? 'running hot' : 'busy'; }
      hosts.push(stop(h.label || h.name || 'Host', level, why));
    }
    for (i = 0; i < (d.stores || []).length; i++) stores.push(storage(d.stores[i], d.stores[i].label || d.stores[i].name || 'Storage'));
    if (!stores.length && d.tank) stores.push(storage(d.tank, 'Tank'));
    for (i = 0; i < (d.services || []).length; i++) {
      h = d.services[i];
      services.push(stop(h.label || String(h.name || 'Service').replace(/[-_]/g, ' '), h.up === true ? 'ok' : h.up === false ? 'bad' : 'unknown', h.up === false ? 'unavailable' : ''));
      services[services.length - 1].core = h.core === true;
    }
    h = d.firewall;
    if (h) {
      level = h.up === true ? 'ok' : h.up === false ? 'bad' : 'unknown'; why = level === 'bad' ? 'offline' : '';
      if (level === 'ok' && (h.temp >= 80 || h.disk >= 0.8)) { level = 'warn'; why = h.temp >= 80 ? 'running hot' : 'nearly full'; }
      outside.push(stop('Gateway', level, why));
    } else outside.push(stop('Gateway', 'unknown'));
    h = d.internet;
    outside.push(!h || typeof h.ping !== 'number' ? stop('Internet', 'unknown') : h.ping >= 100 ? stop('Internet', 'warn', 'slow connection') : stop('Internet', 'ok'));
    return [{ name: 'Hosts', stops: hosts }, { name: 'Storage', stops: stores }].concat(serviceRoutes(services), [{ name: 'Outside', kind: 'outside', stops: outside }]);
  }
  // Each leg waits at its origin, then travels for 3 seconds. CSS owns motion;
  // the shared clock selects the leg, so feed redraws keep the same phase.
  function timetable(stops, now) {
    var visits = [], total = 0, i, index, dwell, phase, start, next, x, end;
    for (i = 0; i < stops.length * 2; i++) {
      index = i < stops.length ? i : stops.length * 2 - i - 1;
      dwell = stops[index].level === 'ok' ? 2 : 10;
      visits.push({ index: index, dwell: dwell }); total += dwell + 3;
    }
    phase = (now / 1000) % total;
    start = now / 1000 - phase;
    for (i = 0; i < visits.length; i++) {
      dwell = visits[i].dwell;
      if (phase < dwell + 3) break;
      phase -= dwell + 3; start += dwell + 3;
    }
    index = visits[i].index;
    next = visits[(i + 1) % visits.length].index;
    x = position(stops, index);
    end = position(stops, next);
    return { start: start, left: Math.min(x, end), width: Math.abs(end - x),
      reverse: end < x, dwell: dwell, duration: dwell + 3, phase: phase };
  }
  function stationWidget(box, stage) {
    var root = U.el('div', 'st-root', box), props = {}, sig = null;
    function render() {
      var d = (stage.data || {}).lab, now = stage.now();
      var silent = !d || d.ok === false || d.stale || (typeof d.at === 'number' && now - d.at >= 180000);
      var lines = routes(silent ? {} : d), sun = U.stateOf(stage, props.sun), night = sun && sun.state === 'below_horizon';
      var schedules = [], k;
      for (k = 0; k < lines.length; k++) {
        schedules.push(lines[k].stops.length ? timetable(lines[k].stops, now) : null);
      }
      var signature = JSON.stringify([lines, silent, night, props, stage.height,
        schedules.map(function (s) { return silent || !s ? null : s.start; })]);
      if (signature === sig) return;
      sig = signature;
      box.style.fontSize = (props.size || 2) * stage.height / 100 + 'px';
      U.clear(root);
      var bad = [], warn = [], unknown = false, i, j, s;
      for (i = 0; i < lines.length; i++) {
        if (!lines[i].stops.length) lines[i].stops.push(stop('No answer', 'unknown'));
        for (j = 0; j < lines[i].stops.length; j++) {
          s = lines[i].stops[j];
          if (s.level === 'bad') bad.push(s.name + ' ' + s.why);
          if (s.level === 'warn') warn.push(s.name + ' ' + s.why);
          if (s.level === 'unknown') unknown = true;
        }
      }
      root.className = 'st-root' + (night ? ' st-night' : '') + (silent ? ' st-silent' : '');
      text(root, 'st-title', props.title || 'The Station');
      text(root, 'st-status st-' + (silent ? 'unknown' : bad.length ? 'bad' : warn.length ? 'warn' : unknown ? 'unknown' : 'ok'),
        silent ? "Can't hear the lab" : bad.length ? bad[0] : warn.length ? warn[0] : unknown ? 'Some stops have no answer' : 'All lines running');
      var map = U.el('div', 'st-map', root);
      for (i = 0; i < lines.length; i++) {
        var line = lines[i], row = U.el('div', 'st-route st-route-' + i + (line.kind ? ' st-route-' + line.kind : ''), map);
        row.style.height = 100 / lines.length + '%';
        text(row, 'st-line-name', line.name);
        var track = U.el('div', 'st-track', row), still = silent;
        U.el('div', 'st-rail', track);
        for (j = 0; j < line.stops.length; j++) {
          s = line.stops[j];
          var node = U.el('div', 'st-stop st-' + s.level, track);
          node.style.left = position(line.stops, j) + '%';
          if (line.kind === 'services') {
            var width = 100 / line.stops.length - 2;
            node.style.width = width + '%'; node.style.marginLeft = -width / 2 + '%';
          }
          U.el('i', 'st-dot', node);
          text(node, 'st-stop-name', s.name);
          text(node, 'st-stop-state', silent ? 'No answer' : s.why || (s.level === 'unknown' ? 'No answer' : ''));
          if (s.level === 'unknown') still = true;
        }
        var leg = U.el('div', 'st-leg', track), schedule = schedules[i];
        leg.style.left = (still ? 8 : schedule.left) + '%';
        leg.style.width = (still ? 0 : schedule.width) + '%';
        var train = U.el('div', 'st-train', leg);
        train.innerHTML = '<svg viewBox="0 0 40 22"><rect x="1" y="1" width="38" height="16" rx="5" fill="currentColor"/><path d="M8 6h8m6 0h8" stroke="#20252b" stroke-width="4"/><circle cx="10" cy="19" r="3" fill="currentColor"/><circle cx="30" cy="19" r="3" fill="currentColor"/></svg>';
        if (!still) {
          train.className += ' st-visit' + (schedule.dwell === 10 ? ' st-linger' : '') + (schedule.reverse ? ' st-return' : '');
          var duration = schedule.duration + 's';
          var delay = '-' + schedule.phase.toFixed(3) + 's';
          train.style.animationDuration = duration; train.style.webkitAnimationDuration = duration;
          train.style.animationDelay = delay; train.style.webkitAnimationDelay = delay;
        }
      }
      text(root, 'st-note', silent ? 'Waiting for a fresh signal' : bad.length + warn.length > 1 ? 'Several stops need a look' : 'Trains linger where something needs a look');
    }
    return { update: function (p) { props = p || {}; sig = null; render(); }, data: render, states: render, tick: render };
  }
  CVRender.register('station', stationWidget);
})();
