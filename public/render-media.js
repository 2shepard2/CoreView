/* "Now showing": a movie-theatre poster for Jellyfin. Rotates through what
 * was added lately (movies, and new episodes grouped by show) and switches
 * to what someone is watching while it plays, with a progress line that
 * moves on its own between server updates.
 * Data: stage.data.jellyfin from lib/jellyfin.js.
 *
 * ES5 only, like render.js; tests/es5.test.js applies. Sizes are in em of
 * the widget (size 2.8 on an 841-high screen = 1em 23.5px).
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear, DAYS = U.DAYS, MONTHS = U.MONTHS;

  function text(parent, cls, value) { var e = el('div', cls, parent); e.textContent = value; return e; }
  function runtime(min) {
    if (!min) return '';
    return min >= 60 ? Math.floor(min / 60) + 'h ' + (min % 60 ? (min % 60) + 'm' : '') : min + 'm';
  }
  function epCode(e) {
    if (!e) return '';
    return (e.season !== null && e.season !== undefined ? 'S' + e.season : '') + (e.episode !== null && e.episode !== undefined ? ' · E' + e.episode : '');
  }
  // "3 new episodes" or "New episode · S2 · E5 “Name”"
  function episodesLine(eps) {
    if (!eps || !eps.length) return '';
    if (eps.length === 1) return 'New episode · ' + epCode(eps[0]) + (eps[0].name ? ' “' + eps[0].name + '”' : '');
    var seasons = {}, n = 0;
    for (var i = 0; i < eps.length; i++) if (eps[i].season !== null && eps[i].season !== undefined && !seasons[eps[i].season]) { seasons[eps[i].season] = 1; n++; }
    var only = n === 1 ? ' · Season ' + eps[0].season : '';
    return eps.length + (eps.length >= 20 ? '+' : '') + ' new episodes' + only;
  }
  function dayIndex(ms, tz) { return Math.floor((ms + tz * 60000) / 864e5); }
  function addedLine(ms, stage) {
    if (!ms) return '';
    var days = dayIndex(stage.now(), stage.tzOffsetMin) - dayIndex(ms, stage.tzOffsetMin);
    if (days <= 0) return 'Added today';
    if (days === 1) return 'Added yesterday';
    var p = CVRender.localParts(ms, stage.tzOffsetMin);
    return days < 7 ? 'Added ' + DAYS[p.wd] : 'Added ' + MONTHS[p.mo].slice(0, 3) + ' ' + p.d;
  }
  function clockLen(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min';
  }

  function nowShowingWidget(box, stage) {
    var props = {}, list = [], listKey = '', idx = 0, shownAt = 0, current = null, slide = null, liveBits = null;

    // What to show right now: { kind: 'playing'|'recent'|'empty'|'off', items }
    function pick() {
      var d = stage.data.jellyfin;
      if (!d) return { kind: 'off', note: stage.editing ? 'Now showing · waiting for Jellyfin' : '' };
      var mode = props.mode || 'both';
      if (mode !== 'recent' && d.playing && d.playing.length) return { kind: 'playing', items: d.playing };
      if (mode === 'playing') return { kind: 'empty', note: 'Nothing playing' };
      var out = [], cut = props.days ? stage.now() - props.days * 864e5 : 0, inc = props.include || 'all';
      for (var i = 0; i < (d.recent || []).length && out.length < (props.count || 12); i++) {
        var x = d.recent[i];
        if (inc === 'movies' && x.kind !== 'movie') continue;
        if (inc === 'shows' && x.kind !== 'show') continue;
        if (cut && x.added && x.added < cut) continue;
        out.push(x);
      }
      if (!out.length) return { kind: 'empty', note: d.ok === false && !(d.recent || []).length ? (d.error || 'Jellyfin isn’t answering') : 'Nothing new lately' };
      return { kind: 'recent', items: out };
    }

    function preload(url, cb) {
      if (!url) return cb(false);
      var img = new Image();
      img.onload = function () { cb(true); };
      img.onerror = function () { cb(false); };
      img.src = url;
    }

    function build(item, kind) {
      var landscape = box.clientWidth >= box.clientHeight * 1.1;
      var s = el('div', 'ns-slide ' + (landscape ? 'ns-wide' : 'ns-tall'));
      var bd = el('div', 'ns-backdrop', s);
      if (props.backdrop !== false && item.backdrop) {
        var bu = stage.jellyfinUrl(item.backdrop, 'backdrop');
        preload(bu, function (ok) { if (ok) { bd.style.backgroundImage = 'url("' + bu + '")'; bd.className = 'ns-backdrop ns-in'; } });
      }
      el('div', 'ns-scrim', s);
      var poster = el('div', 'ns-poster', s);
      var pu = item.poster ? stage.jellyfinUrl(item.poster, 'poster') : '';
      text(poster, 'ns-poster-name', item.title);
      preload(pu, function (ok) { if (ok) { poster.style.backgroundImage = 'url("' + pu + '")'; clear(poster); } });
      // Poster keeps 2:3 inside its column.
      var bh = box.clientHeight, bw = box.clientWidth;
      if (landscape) {
        var ph = Math.round(bh * 0.84), pw = Math.round(ph * 2 / 3);
        if (pw > bw * 0.42) { pw = Math.round(bw * 0.42); ph = Math.round(pw * 3 / 2); }
        poster.style.width = pw + 'px'; poster.style.height = ph + 'px';
        poster.style.left = Math.round(bw * 0.05) + 'px'; poster.style.top = Math.round((bh - ph) / 2) + 'px';
      } else {
        var th = Math.round(bh * 0.42), tw = Math.round(th * 2 / 3);
        if (tw > bw * 0.7) { tw = Math.round(bw * 0.7); th = Math.round(tw * 3 / 2); }
        poster.style.width = tw + 'px'; poster.style.height = th + 'px';
        poster.style.left = Math.round((bw - tw) / 2) + 'px'; poster.style.top = Math.round(bh * 0.05) + 'px';
      }
      var info = el('div', 'ns-info', s);
      if (landscape) { info.style.left = Math.round(bw * 0.05 + parseInt(poster.style.width, 10) + bw * 0.045) + 'px'; }
      else info.style.top = Math.round(bh * 0.05 + parseInt(poster.style.height, 10) + bh * 0.03) + 'px';

      var kick = el('div', 'ns-kicker', info);
      if (kind === 'playing') { el('span', 'ns-live', kick); el('span', '', kick).textContent = item.paused ? 'Paused' : 'Now playing'; }
      else el('span', '', kick).textContent = item.kind === 'show' ? 'New episodes' : 'Recently added';
      text(info, 'ns-title cv-acc', item.title);
      var sub = kind === 'playing' ? (item.episode ? epCode(item.episode) + (item.episode.name ? ' “' + item.episode.name + '”' : '') : '') : (item.kind === 'show' ? episodesLine(item.episodes) : '');
      if (sub) text(info, 'ns-sub', sub);
      var meta = el('div', 'ns-meta', info);
      if (item.year) el('span', '', meta).textContent = item.year;
      if (item.rating) el('span', 'ns-rating', meta).textContent = item.rating;
      var len = kind === 'playing' ? runtime(item.duration ? Math.round(item.duration / 60000) : null) : runtime(item.minutes);
      if (len) el('span', '', meta).textContent = len;
      if (item.score) el('span', 'ns-score', meta).textContent = '★ ' + item.score;
      if (item.genres && item.genres.length) text(info, 'ns-genres', item.genres.join(' · '));
      if (props.plot !== false && item.overview) text(info, 'ns-plot', item.overview);

      var foot = el('div', 'ns-foot', info);
      liveBits = null;
      if (kind === 'playing') {
        var bar = el('div', 'ns-bar', foot), fill = el('div', 'ns-fill', bar);
        var line = text(foot, 'ns-who', '');
        liveBits = { item: item, fill: fill, line: line };
        live();
      } else {
        text(foot, 'ns-added', addedLine(item.added, stage));
        if (list.length > 1) {
          var dots = el('div', 'ns-dots', s);
          for (var i = 0; i < list.length; i++) el('span', i === idx ? 'ns-dot ns-on' : 'ns-dot', dots);
        }
      }
      return s;
    }

    // Playback position moves on between server updates (every few minutes or on pause).
    function live() {
      if (!liveBits) return;
      var it = liveBits.item, pos = it.position + (it.paused ? 0 : Math.max(0, stage.now() - it.at));
      if (it.duration) pos = Math.min(pos, it.duration);
      liveBits.fill.style.width = it.duration ? (pos / it.duration * 100).toFixed(2) + '%' : '0%';
      var where = it.who && it.where ? it.who + ' on ' + it.where : it.who || it.where || '';
      liveBits.line.textContent = (it.duration ? clockLen(it.duration - pos) + ' left' : '') + (where ? (it.duration ? ' · ' : '') + where : '');
    }

    function show(item, kind) {
      var next = build(item, kind), old = slide;
      box.appendChild(next);
      slide = next;
      current = item;
      shownAt = stage.now();
      // Fade in over the old slide, then drop it.
      setTimeout(function () { next.className += ' ns-shown'; }, 30);
      if (old) setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 1400);
    }

    function note(msg) {
      clear(box); slide = null; current = null; liveBits = null;
      if (msg) text(box, 'ns-note', msg);
    }

    function render(force) {
      var p = pick(), key = p.kind + '|' + (p.items ? p.items.map(function (x) { return x.id + (x.paused ? 'p' : ''); }).join(',') : p.note);
      if (!p.items) { list = []; listKey = key; return note(p.note); }
      if (key === listKey && !force && slide) {
        // Same list (e.g. a playback update): refresh the live line only.
        if (p.kind === 'playing' && liveBits) for (var i = 0; i < p.items.length; i++) if (p.items[i].id === current.id) liveBits.item = p.items[i];
        return;
      }
      var sameKind = listKey.split('|')[0] === p.kind;
      list = p.items; listKey = key;
      if (!sameKind || !current) idx = 0;
      else { idx = 0; for (var j = 0; j < list.length; j++) if (list[j].id === current.id) idx = j; }
      if (!slide || !sameKind || force || !current || list[idx].id !== current.id || p.kind === 'playing') show(list[idx], p.kind);
    }

    function tick() {
      live();
      if (!list.length || stage.editing) return;
      if (stage.now() - shownAt >= (props.interval || 20) * 1000 && list.length > 1) {
        idx = (idx + 1) % list.length;
        show(list[idx], listKey.split('|')[0]);
      }
    }

    return {
      update: function (pr) {
        props = pr;
        box.style.fontSize = (props.size || 2.8) * stage.height / 100 + 'px';
        listKey = '';
        render(true);
      },
      data: function () { render(false); },
      tick: tick
    };
  }

  CVRender.register('nowshowing', nowShowingWidget);
})();
