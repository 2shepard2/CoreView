/* CoreView Studio renderer: draws a view into a box.
 *
 * Shared by the Studio editor (WYSIWYG canvas, previews) and every display.
 * Written in ES5 with no dependencies because the oldest display, the master
 * bedroom frame, runs Chrome 44. tests/es5.test.js enforces that.
 *
 *   var stage = CVRender.create(containerEl, {
 *     photoUrl: function (assetId) {...},      // URL of a preview image
 *     album: function (albumId, cb) {...},     // cb(err, photos)
 *     cameraUrl: function (camera) {...},      // latest frame; + '/live' = MJPEG
 *     now: function () { return ms; },         // UTC ms (server-corrected)
 *     tzOffsetMin: -420,                       // the house's offset from UTC
 *     editing: false,                          // placeholders, no slideshow timers, no taps
 *     act: function (widgetId, action, args, cb) {...},  // interactive widgets (cb(err))
 *     personUrl: function (entity) {...},      // a person's picture
 *     frigateUrl: function (eventId, kind) {...} // snap | thumb | clip
 *     jellyfinUrl: function (itemId, kind) {...} // poster | backdrop
 *     unknownWidget: function (type) {...}     // a widget this page's code doesn't have (older page)
 *   });
 *   stage.setView(view); stage.setStates(states); stage.setData(data); stage.showOverlay(info);
 *   stage.setViews({id: view}, mainId)  // linked views: tap / idle switching, buttons
 *   stage.setKids(on)                   // Grandkids mode (opts.kids(on, pin, cb) asks the server)
 *   stage.setTimers(list)               // timer pop-up: [{label, state, endsAt|remaining, duration, until}]
 *
 * More widgets register themselves with CVRender.register(type, factory)
 * (render-household.js).
 */
var CVRender = (function () {
  'use strict';

  var FONTS = {
    sans: 'Roboto, "Helvetica Neue", Arial, sans-serif',
    manrope: 'Manrope, Roboto, "Helvetica Neue", Arial, sans-serif',
    nunito: 'Nunito, Roboto, "Helvetica Neue", Arial, sans-serif',
    fraunces: 'Fraunces, Georgia, "Noto Serif", serif',
    serif: 'Georgia, "Noto Serif", "Droid Serif", serif',
    mono: '"Roboto Mono", "Droid Sans Mono", monospace',
    condensed: '"Roboto Condensed", "Arial Narrow", sans-serif-condensed, sans-serif'
  };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEATHER = {
    'clear-night': ['🌙', 'Clear'], 'cloudy': ['☁️', 'Cloudy'], 'fog': ['🌫️', 'Fog'],
    'hail': ['🌨️', 'Hail'], 'lightning': ['⛈️', 'Lightning'], 'lightning-rainy': ['⛈️', 'Storms'],
    'partlycloudy': ['⛅', 'Partly cloudy'], 'pouring': ['🌧️', 'Pouring'], 'rainy': ['🌧️', 'Rain'],
    'snowy': ['❄️', 'Snow'], 'snowy-rainy': ['🌨️', 'Sleet'], 'sunny': ['☀️', 'Sunny'],
    'windy': ['💨', 'Windy'], 'windy-variant': ['💨', 'Windy'], 'exceptional': ['⚠️', 'Alert']
  };

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hexToRgba(hex, alpha) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return 'transparent';
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + alpha + ')';
  }

  // Wall-clock parts for the house's time zone, read with UTC getters.
  function localParts(ms, offsetMin) {
    var d = new Date(ms + offsetMin * 60000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(),
      h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  function formatDate(p, style) {
    if (style === 'short') return DAYS[p.wd].slice(0, 3) + ', ' + MONTHS[p.mo].slice(0, 3) + ' ' + p.d;
    return DAYS[p.wd] + ', ' + MONTHS[p.mo] + ' ' + p.d;
  }
  function photoDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : '';
  }

  // Slideshows run on the server-corrected clock, so every screen showing an
  // album and Studio's live thumbnail of it show the same photo at the same
  // time. "Shuffle" is a seeded permutation: the same on every renderer, and a
  // new one for each pass through the album.
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seededRandom(seed) { // mulberry32
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, seed) {
    var a = list.slice(), rnd = seededRandom(seed), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // By id first, so every renderer starts from the same list.
  function ordered(photos, order) {
    var a = photos.slice();
    a.sort(function (x, y) {
      var dx = order === 'shuffle' ? '' : x.date || '', dy = order === 'shuffle' ? '' : y.date || '';
      var c = order === 'oldest' ? (dx < dy ? -1 : dx > dy ? 1 : 0) : (dx < dy ? 1 : dx > dy ? -1 : 0);
      return c || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    });
    return a;
  }

  // ---------- widgets ----------
  // Each factory returns { update(props), states(map), tick(), destroy() }.

  function styleBox(box, props, stage) {
    var h = stage.height;
    box.style.color = props.textColor || '';
    box.style.backgroundColor = props.bgOpacity ? hexToRgba(props.bg, props.bgOpacity / 100) : 'transparent';
    box.style.borderRadius = (props.radius || 0) * h / 100 + 'px';
    box.style.padding = (props.padding || 0) * h / 100 + 'px';
    box.style.textShadow = props.shadow ? '0 0.05em 0.25em rgba(0,0,0,0.85), 0 0 0.6em rgba(0,0,0,0.35)' : 'none';
    box.style.textAlign = props.align || 'left';
    box.style.webkitJustifyContent = box.style.justifyContent =
      props.align === 'center' ? 'center' : props.align === 'right' ? 'flex-end' : 'flex-start';
  }

  function textWidget(box, stage) {
    var inner = el('div', 'cv-text', box);
    var self = {
      update: function (props) {
        styleBox(box, props, stage);
        inner.style.fontSize = props.size * stage.height / 100 + 'px';
        inner.style.fontWeight = props.weight || '600';
        inner.textContent = props.text || '';
        box.className = 'cv-widget cv-text' + (props.breathe && !stage.editing ? ' cv-breathe' : '');
      }
    };
    return self;
  }

  // look "elegant": the house board's light serif numerals, small AM/PM, bold weekday.
  function clockWidget(box, stage) {
    var inner = el('div', 'cv-clock', box);
    var time = el('div', 'cv-clock-time', inner);
    var date = el('div', 'cv-clock-date', inner);
    var props = {};
    function render() {
      var p = localParts(stage.now(), stage.tzOffsetMin);
      var h = p.h, suffix = '';
      if (props.format !== '24') { suffix = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; }
      var text = (props.format === '24' ? pad(h) : '' + h) + ':' + pad(p.mi) + (props.showSeconds ? ':' + pad(p.s) : '');
      var ampm = props.format !== '24' && props.showAmPm;
      if (props.look === 'elegant' || props.look === 'bold') {
        clear(time);
        time.appendChild(document.createTextNode(text));
        if (ampm) el('small', 'cv-clock-ampm', time).textContent = suffix;
        clear(date);
        if (props.showDate) {
          if (props.look === 'bold') date.textContent = formatDate(p, props.dateStyle);
          else {
            el('b', '', date).textContent = DAYS[p.wd];
            el('span', 'cv-soft', date).textContent = ', ' + MONTHS[p.mo] + ' ' + p.d;
          }
        }
      } else {
        time.textContent = text + (ampm ? ' ' + suffix : '');
        date.textContent = props.showDate ? formatDate(p, props.dateStyle) : '';
      }
      date.style.display = props.showDate ? '' : 'none';
    }
    return {
      update: function (pr) {
        props = pr;
        styleBox(box, props, stage);
        inner.className = 'cv-clock' + (props.look === 'elegant' ? ' cv-clock-elegant cv-acc' : props.look === 'bold' ? ' cv-clock-bold' : '');
        time.style.fontSize = props.size * stage.height / 100 + 'px';
        date.style.fontSize = props.size * (props.look === 'elegant' ? 0.161 : props.look === 'bold' ? 0.268 : 0.36) * stage.height / 100 + 'px';
        render();
      },
      tick: render
    };
  }

  function stateOf(stage, id) { return id && stage.states ? stage.states[id] : null; }

  function weatherWidget(box, stage) {
    var inner = el('div', 'cv-weather', box);
    var temp = el('div', 'cv-weather-temp', inner);
    var cond = el('div', 'cv-weather-cond', inner);
    var props = {};
    function render() {
      var s = stateOf(stage, props.entity);
      if (!props.entity) { temp.textContent = stage.editing ? 'Choose a weather entity' : ''; cond.textContent = ''; return; }
      if (!s) { temp.textContent = '—'; cond.textContent = stage.editing ? props.entity : ''; return; }
      var a = s.attributes || {};
      var w = WEATHER[s.state] || ['', s.state];
      var t = a.temperature !== undefined ? Math.round(a.temperature) + '°' : '—';
      temp.textContent = props.show === 'temp' || props.show === 'temp_text' ? t : (w[0] ? w[0] + ' ' : '') + t;
      cond.textContent = props.show === 'temp' ? '' : w[1];
      cond.style.display = props.show === 'temp' ? 'none' : '';
    }
    return {
      update: function (pr) {
        props = pr;
        styleBox(box, props, stage);
        temp.style.fontSize = props.size * stage.height / 100 + 'px';
        cond.style.fontSize = props.size * (props.show === 'temp_text' ? 0.386 : 0.38) * stage.height / 100 + 'px';
        inner.className = 'cv-weather' + (props.show === 'temp_text' ? ' cv-weather-text' : '');
        render();
      },
      states: render
    };
  }

  var WORDS = { door: ['Open', 'Closed'], lock: ['Unlocked', 'Locked'], presence: ['Home', 'Away'], onoff: ['On', 'Off'] };
  function entityValue(s, showUnit, attribute, words) {
    if (!s) return '—';
    var a = s.attributes || {}, v = s.state;
    if (words && WORDS[words] && (v === 'on' || v === 'off')) return v === 'on' ? WORDS[words][0] : WORDS[words][1];
    if (attribute) {
      v = a[attribute];
      if (v === undefined || v === null) return '—';
      var na = Number(v);
      if (isFinite(na)) v = Math.abs(na) >= 100 ? Math.round(na) : Math.round(na * 10) / 10;
      return v + (/temperature/.test(attribute) ? '°' : '');
    }
    if (v === 'unavailable' || v === 'unknown') return '—';
    if (v === 'on' || v === 'off') {
      var dc = a.device_class;
      var words = { door: ['Open', 'Closed'], window: ['Open', 'Closed'], garage_door: ['Open', 'Closed'], opening: ['Open', 'Closed'],
        lock: ['Unlocked', 'Locked'], motion: ['Motion', 'Clear'], occupancy: ['Occupied', 'Clear'], presence: ['Home', 'Away'],
        moisture: ['Wet', 'Dry'], running: ['Running', 'Idle'], plug: ['Plugged in', 'Unplugged'] };
      var pair = words[dc] || ['On', 'Off'];
      return v === 'on' ? pair[0] : pair[1];
    }
    if (v === 'home') return 'Home';
    if (v === 'not_home') return 'Away';
    var n = Number(v);
    if (v !== '' && isFinite(n)) v = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
    return v + (showUnit && a.unit_of_measurement ? ' ' + a.unit_of_measurement : '');
  }

  function entityWidget(box, stage) {
    var inner = el('div', 'cv-entity', box);
    var label = el('div', 'cv-entity-label', inner);
    var value = el('div', 'cv-entity-value', inner);
    var props = {};
    function render() {
      var s = stateOf(stage, props.entity);
      var name = props.label || (s && s.attributes && s.attributes.friendly_name) || props.entity || '';
      label.textContent = props.entity ? name : stage.editing ? 'Choose an entity' : '';
      var old = props.staleHours && s && s.last_changed && stage.now() - Date.parse(s.last_changed) > props.staleHours * 3600000;
      value.textContent = !props.entity ? '' : old || (props.staleText && s && s.state === '') ? props.staleText || '—' : entityValue(s, props.showUnit, props.attribute, props.words);
    }
    return {
      update: function (pr) {
        props = pr;
        styleBox(box, props, stage);
        label.style.fontSize = props.size * 0.5 * stage.height / 100 + 'px';
        value.style.fontSize = props.size * stage.height / 100 + 'px';
        render();
      },
      states: render
    };
  }

  // Photos from an album; optionally every third slide is a drawing from a
  // drawing board's fridge (props.fridgeBoard), a polaroid frame, a corner
  // caption like a family photo frame, and a tap that opens another view.
  function photosWidget(box, stage) {
    box.className += ' cv-photos-box';
    var holder = el('div', 'cv-photo-holder', box);
    var layers = [el('div', 'cv-photo', holder), el('div', 'cv-photo', holder)];
    var shade = el('div', 'cv-shade', box);
    var caption = el('div', 'cv-caption', box);
    var note = el('div', 'cv-note', box);
    var props = {}, list = [], current = null, front = 0, timer = null, loadedAlbum = null, order = null, gen = 0;
    var fridge = [], fridgeBoard = null, perm = null, permPass = -1;

    function setNote(text) { note.textContent = text || ''; note.style.display = text ? '' : 'none'; }
    function fitFor(photo) {
      if (props.fit === 'smart') return photo && photo.portrait ? 'contain' : 'cover';
      return props.fit === 'contain' ? 'contain' : 'cover';
    }
    function monthYear(iso) {
      var m = /^(\d{4})-(\d{2})/.exec(iso || '');
      return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
    }
    // Corner caption: the place (or month), then a small line with the label.
    function cornerText(photo) {
      if (photo.art) return [photo.title, photo.when];
      var when = monthYear(photo.date), label = props.captionLabel || '';
      var small = [];
      if (photo.place && when) small.push(when);
      if (label) small.push(label);
      return [photo.place || when || label, small.join(' · ')];
    }
    function showCaption(photo) {
      clear(caption);
      var text = '';
      if (photo && props.caption === 'corner') {
        var c = cornerText(photo);
        caption.appendChild(document.createTextNode(c[0]));
        if (c[1]) el('small', '', caption).textContent = c[1];
        text = c[0] || c[1];
      } else if (photo && props.caption !== 'none' && !photo.art) {
        text = photoDate(photo.date);
        if (props.caption === 'date_place' && photo.place) text += (text ? ' · ' : '') + photo.place;
        caption.textContent = text;
      }
      if (props.frame === 'polaroid' && photo && !photo.art) { caption.textContent = cornerText(photo)[0]; text = 'x'; }
      caption.style.display = text ? '' : 'none';
    }
    function intervalMs() { return Math.max(5, props.interval || 20) * 1000; }
    // The slide for this moment: slot n of the clock, every third one a
    // fridge drawing when there are any.
    function next() {
      var slot = Math.floor(stage.now() / intervalMs());
      var art = fridge.length && props.frame !== 'polaroid';
      if (art && (slot % 3 === 0 || !list.length)) {
        var f = fridge[Math.floor(slot / 3) % fridge.length], d = new Date(f.at);
        return { art: true, url: stage.boardUrl(props.fridgeBoard, 'fridge/' + f.id + '.jpg'), title: 'On the fridge',
          when: 'Drawn by the grandkids · ' + MONTHS[d.getMonth()] + ' ' + d.getDate() };
      }
      if (!list.length) return null;
      var k = art ? slot - Math.floor((slot + 2) / 3) : slot; // photo slots only
      var n = list.length, p;
      if (props.order === 'shuffle') {
        var pass = Math.floor(k / n);
        if (pass !== permPass) { perm = shuffle(list, (hashStr(String(props.albumId)) ^ pass) >>> 0); permPass = pass; }
        p = perm[k % n];
      } else p = list[k % n];
      current = p;
      return { id: p.id, url: stage.photoUrl(p.id), date: p.date, place: p.place, portrait: p.portrait };
    }
    function show() {
      var photo = next(), my = gen;
      if (!photo) return;
      var img = new Image();
      img.onload = function () {
        if (my !== gen) return;
        var back = layers[1 - front];
        back.style.backgroundImage = 'url("' + photo.url + '")';
        back.style.backgroundSize = photo.art ? 'contain' : fitFor(photo);
        back.className = 'cv-photo' + (photo.art ? ' cv-art' : '');
        back.style.opacity = '1';
        layers[front].style.opacity = '0';
        front = 1 - front;
        showCaption(photo);
        setNote('');
      };
      img.onerror = function () { if (my === gen && !stage.editing) setTimeout(function () { if (my === gen) show(); }, 3000); };
      img.src = photo.url;
    }
    // Change at the next clock boundary (a little after it, so every
    // renderer is past it).
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (stage.editing || list.length + fridge.length < 2) return;
      var ms = intervalMs();
      timer = setTimeout(function () { show(); schedule(); }, ms - (stage.now() % ms) + 50);
    }
    function loadFridge() {
      fridgeBoard = props.fridgeBoard || null;
      fridge = [];
      if (!fridgeBoard || stage.editing) return;
      stage.api('GET', stage.boardUrl(fridgeBoard, 'fridge'), null, function (err, data) {
        if (!err && fridgeBoard === props.fridgeBoard) { fridge = data.fridge || []; schedule(); }
      });
    }
    function load() {
      var my = ++gen;
      loadedAlbum = props.albumId;
      order = props.order;
      list = []; current = null; perm = null; permPass = -1;
      if (!props.albumId) { setNote(stage.editing ? 'Choose an album in the panel on the right' : ''); return; }
      setNote(stage.editing ? 'Loading photos…' : '');
      stage.album(props.albumId, function (err, photos) {
        if (my !== gen) return;
        if (err) { setNote(stage.editing ? 'Could not load the album' : ''); setTimeout(function () { if (my === gen) load(); }, 60000); return; }
        list = ordered(photos || [], props.order);
        if (!list.length && !fridge.length) { setNote(stage.editing ? 'This album has no photos' : ''); return; }
        show();
        schedule();
      });
    }
    box.onclick = function (e) {
      if (stage.editing || !props.tapView) return;
      e.stopPropagation();
      stage.goView(props.tapView);
    };
    // Fridge drawings come and go; look again every 10 minutes.
    var fridgeTimer = setInterval(function () { if (props.fridgeBoard) loadFridge(); }, 600000);
    return {
      update: function (pr) {
        var reload = pr.albumId !== loadedAlbum || pr.order !== order;
        var oldInterval = props.interval, oldBoard = props.fridgeBoard;
        props = pr;
        var polaroid = props.frame === 'polaroid';
        box.className = 'cv-widget cv-photos cv-photos-box' + (polaroid ? ' cv-polaroid' : '') + (props.shade ? ' cv-shaded' : '') + (props.caption === 'corner' ? ' cv-corner-cap' : '');
        box.style.fontSize = stage.height / 768 * 16 + 'px';
        if (props.fridgeBoard !== oldBoard) loadFridge();
        if (reload) load();
        else {
          if (current) layers[front].style.backgroundSize = fitFor(current);
          if (oldInterval !== props.interval) { show(); schedule(); }
        }
        caption.style.fontSize = polaroid ? '' : (props.captionSize || 2.6) * stage.height / 100 + 'px';
        note.style.fontSize = 3 * stage.height / 100 + 'px';
      },
      destroy: function () { gen++; if (timer) clearTimeout(timer); clearInterval(fridgeTimer); }
    };
  }

  var FACTORIES = { text: textWidget, clock: clockWidget, weather: weatherWidget, entity: entityWidget, photos: photosWidget };

  // ---------- stage ----------
  function create(container, opts) {
    opts = opts || {};
    var root = el('div', 'cv-root', container);
    var stageEl = el('div', 'cv-stage', root);
    var overlayEl = el('div', 'cv-overlay', root);
    overlayEl.style.display = 'none';
    var timersEl = el('div', 'cv-timers', root);
    timersEl.style.display = 'none';
    var stage = {
      el: stageEl, root: root, width: 0, height: 0, view: null, states: {}, widgets: {}, order: [],
      editing: !!opts.editing, tzOffsetMin: opts.tzOffsetMin || 0,
      now: opts.now || function () { return new Date().getTime(); },
      photoUrl: opts.photoUrl || function () { return ''; },
      album: opts.album || function (id, cb) { cb(new Error('no album source')); },
      cameraUrl: opts.cameraUrl || function () { return ''; },
      personUrl: opts.personUrl || function () { return ''; },
      frigateUrl: opts.frigateUrl || function () { return ''; },
      jellyfinUrl: opts.jellyfinUrl || function () { return ''; },
      boardUrl: opts.boardUrl || function () { return ''; },
      api: opts.api || function (method, path, body, cb) { cb(new Error('offline')); },
      data: {}, views: {}, viewId: null, kids: false, pinLength: 0
    };
    var sheetEl = el('div', 'cv-sheet-wrap', root);
    var toastEl = el('div', 'cv-toast', root);
    sheetEl.style.display = 'none';
    toastEl.style.display = 'none';
    sheetEl.onclick = function (e) { if (e.target === sheetEl) stage.closeSheet(); };
    var ticker = setInterval(function () {
      for (var id in stage.widgets) if (stage.widgets[id].impl.tick) stage.widgets[id].impl.tick();
    }, 1000);

    function measure() {
      var v = stage.view, cw = container.clientWidth, ch = container.clientHeight;
      if (!v || !cw || !ch) return false;
      var scale = Math.min(cw / v.aspect.w, ch / v.aspect.h);
      var w = Math.round(v.aspect.w * scale), h = Math.round(v.aspect.h * scale);
      var changed = w !== stage.width || h !== stage.height;
      stage.width = w; stage.height = h;
      stageEl.style.width = w + 'px'; stageEl.style.height = h + 'px';
      stageEl.style.left = Math.round((cw - w) / 2) + 'px'; stageEl.style.top = Math.round((ch - h) / 2) + 'px';
      overlayEl.style.width = stageEl.style.width; overlayEl.style.height = stageEl.style.height;
      overlayEl.style.left = stageEl.style.left; overlayEl.style.top = stageEl.style.top;
      timersEl.style.width = stageEl.style.width; timersEl.style.height = stageEl.style.height;
      timersEl.style.left = stageEl.style.left; timersEl.style.top = stageEl.style.top;
      if (changed && timerCards.length) buildTimers();
      return changed;
    }

    function place(entry, w) {
      var s = entry.box.style;
      s.left = w.x + '%'; s.top = w.y + '%'; s.width = w.w + '%'; s.height = w.h + '%';
    }

    stage.setView = function (view) {
      stage.view = view;
      if (!view) { for (var k in stage.widgets) remove(k); return; }
      measure();
      stageEl.style.backgroundColor = view.background || '#000000';
      stageEl.style.color = view.textColor || '#ffffff';
      // On the root so pop-up sheets and toasts share the view's fonts.
      root.style.fontFamily = FONTS[view.font] || FONTS.sans;
      // Headline numerals and titles (class cv-acc) can use a second font.
      root.className = 'cv-root' + (view.accentFont ? ' cv-accent-' + view.accentFont : '');
      var keep = {}, i, w, entry;
      for (i = 0; i < view.widgets.length; i++) {
        w = view.widgets[i];
        keep[w.id] = true;
        entry = stage.widgets[w.id];
        if (entry && entry.type !== w.type) { remove(w.id); entry = null; }
        if (!entry) {
          var box = el('div', 'cv-widget cv-' + w.type);
          box.setAttribute('data-id', w.id);
          entry = { type: w.type, box: box, impl: null };
          stage.widgets[w.id] = entry;
          if (!FACTORIES[w.type] && opts.unknownWidget) opts.unknownWidget(w.type);
          entry.impl = FACTORIES[w.type] ? FACTORIES[w.type](box, stage, w.id) : textWidget(box, stage);
        }
        stageEl.appendChild(entry.box); // keeps the z-order of the list
        place(entry, w);
        entry.impl.update(w.props);
      }
      for (var id in stage.widgets) if (!keep[id]) remove(id);
    };
    function remove(id) {
      var entry = stage.widgets[id];
      if (!entry) return;
      if (entry.impl.destroy) entry.impl.destroy();
      if (entry.box.parentNode) entry.box.parentNode.removeChild(entry.box);
      delete stage.widgets[id];
    }

    // ---------- linked views ----------
    // A view can switch to another on a tap anywhere (touchView), drift back
    // after idleSeconds without a touch (idleView), and buttons can open one.
    var lastTouch = new Date().getTime();
    stage.setViews = function (views, mainId) {
      stage.views = views || {};
      var id = stage.viewId && stage.views[stage.viewId] ? stage.viewId : mainId;
      stage.viewId = id;
      stage.setView(stage.views[id] || null);
    };
    stage.goView = function (id) {
      if (stage.editing || !stage.views[id] || id === stage.viewId) return;
      stage.closeSheet();
      stage.viewId = id;
      lastTouch = new Date().getTime();
      stageEl.style.opacity = '0';
      setTimeout(function () {
        if (stage.viewId !== id) return;
        stage.setView(stage.views[id]);
        stageEl.style.opacity = '1';
      }, 180);
    };
    // Share of the idle time left (1 = just touched), or -1 without an idle view.
    stage.idleLeft = function () {
      var v = stage.view;
      if (!v || !v.idleView || !stage.views[v.idleView]) return -1;
      return Math.max(0, 1 - (new Date().getTime() - lastTouch) / ((v.idleSeconds || 60) * 1000));
    };
    function poke() { lastTouch = new Date().getTime(); }
    root.addEventListener('touchstart', poke, true);
    root.addEventListener('mousedown', poke, true);
    root.addEventListener('keydown', poke, true);
    root.addEventListener('click', function () {
      // Widgets that handle a tap stop it from getting here.
      var v = stage.view;
      if (!stage.editing && v && v.touchView && sheetEl.style.display === 'none') stage.goView(v.touchView);
    }, false);
    var idleTimer = setInterval(function () {
      if (stage.editing) return;
      if (stage.idleLeft() === 0) stage.goView(stage.view.idleView);
    }, 1000);
    stage.setKids = function (on) {
      stage.kids = !!on;
      for (var id in stage.widgets) if (stage.widgets[id].impl.kids) stage.widgets[id].impl.kids();
    };

    stage.setData = function (changes) {
      for (var k in changes) stage.data[k] = changes[k];
      for (var id in stage.widgets) if (stage.widgets[id].impl.data) stage.widgets[id].impl.data();
    };

    // Interactive widgets: a pop-up sheet, a toast, and actions sent to the server.
    var toastTimer = null, sheetOwner = null;
    // Sheets are sized like the house board: 1em = its 20px on a 1080-wide screen.
    function sheetEm() { return Math.min(stage.width, stage.height) / 1080 * 20; }
    stage.toast = function (text) {
      toastEl.textContent = text;
      toastEl.style.fontSize = sheetEm() * 1.3 + 'px';
      toastEl.style.display = '';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 2800);
    };
    // Returns the card's body element; owner.redraw() is called when data changes.
    stage.openSheet = function (title, owner) {
      clear(sheetEl);
      sheetOwner = owner || null;
      var card = el('div', 'cv-sheet', sheetEl);
      card.style.fontSize = sheetEm() + 'px';
      var head = el('div', 'cv-sheet-title cv-acc', card);
      head.textContent = title;
      var x = el('button', 'cv-sheet-x', card);
      x.textContent = '✕';
      x.onclick = stage.closeSheet;
      sheetEl.style.display = '';
      return el('div', 'cv-sheet-body', card);
    };
    stage.closeSheet = function () { sheetOwner = null; sheetEl.style.display = 'none'; clear(sheetEl); };
    stage.sheetOwner = function () { return sheetOwner; };
    // done(err), optional, runs after the toast.
    stage.act = function (widgetId, action, args, okText, done) {
      if (stage.editing || !opts.act) return;
      args = args || {};
      args.widget = widgetId; args.action = action;
      opts.act(args, function (err, msg) {
        if (err) stage.toast('Couldn\'t do that: ' + (msg || err.message));
        else if (okText) stage.toast(okText);
        if (done) done(err);
      });
    };

    stage.setStates = function (changes) {
      for (var id in changes) stage.states[id] = changes[id];
      for (var k in stage.widgets) if (stage.widgets[k].impl.states) stage.widgets[k].impl.states();
    };

    // Re-fit after the container changes size (window resize, editor zoom).
    stage.resize = function () {
      if (measure() && stage.view) stage.setView(stage.view);
    };

    var overlayTimer = null, frameTimer = null, fitTimer = null, liveEl = null;
    // Point the live <img> elsewhere first so the browser drops the stream.
    function dropLive() {
      if (fitTimer) { clearInterval(fitTimer); fitTimer = null; }
      if (liveEl) { liveEl.onerror = null; liveEl.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; liveEl = null; }
    }
    stage.showOverlay = function (info) {
      dropLive();
      clear(overlayEl);
      var card = el('div', 'cv-overlay-card', overlayEl);
      var title = el('div', 'cv-overlay-title', card);
      var who = info.label === 'person' ? 'Someone' : info.label.charAt(0).toUpperCase() + info.label.slice(1);
      title.textContent = who + ' at ' + info.camera.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      title.style.fontSize = 4 * stage.height / 100 + 'px';
      var img = el('div', 'cv-overlay-img', card);
      var base = stage.cameraUrl(info.camera);
      // Stills only if live video fails: swap in the next frame once it has
      // loaded (the response is cacheable, so the swap doesn't fetch again).
      function frame() {
        var url = base + '?event=' + encodeURIComponent(info.eventId || '') + '&t=' + new Date().getTime();
        var probe = new Image();
        probe.onload = function () { img.style.backgroundImage = 'url("' + url + '")'; };
        probe.src = url;
      }
      function stills() {
        if (liveEl && liveEl.parentNode) liveEl.parentNode.removeChild(liveEl);
        dropLive();
        frame();
        if (frameTimer) clearInterval(frameTimer);
        frameTimer = setInterval(frame, 2000);
      }
      if (frameTimer) clearInterval(frameTimer);
      frameTimer = null;
      // Live video (Frigate MJPEG, like V1), with the event snapshot behind it
      // until the first frame arrives.
      frame();
      liveEl = el('img', 'cv-overlay-live', img);
      liveEl.onerror = stills;
      liveEl.src = base + '/live?t=' + new Date().getTime();
      // Frigate streams at detect size (~640x360), smaller than the card, and
      // an <img> won't scale up by itself (object-fit is off-limits for
      // Chrome 44). Once the first frame gives its size, fit it to the card.
      fitTimer = setInterval(function () {
        if (!liveEl || !liveEl.naturalWidth) return;
        var k = Math.min(img.clientWidth / liveEl.naturalWidth, img.clientHeight / liveEl.naturalHeight);
        liveEl.style.width = Math.floor(liveEl.naturalWidth * k) + 'px';
        liveEl.style.height = Math.floor(liveEl.naturalHeight * k) + 'px';
        clearInterval(fitTimer);
        fitTimer = null;
      }, 200);
      overlayEl.style.display = '';
      if (overlayTimer) clearTimeout(overlayTimer);
      overlayTimer = setTimeout(stage.hideOverlay, (info.seconds || 60) * 1000);
    };
    stage.hideOverlay = function () {
      if (frameTimer) clearInterval(frameTimer);
      if (overlayTimer) clearTimeout(overlayTimer);
      frameTimer = overlayTimer = null;
      dropLive();
      overlayEl.style.display = 'none';
      clear(overlayEl);
    };

    // ---------- timer pop-up ----------
    // Cards over the bottom of whatever the view shows while a Home Assistant
    // timer runs. The screen counts down by itself from the end time (stage.now()
    // is server-corrected); at zero it shows "Done" until the server's next word
    // or the item's `until`.
    var timerList = [], timerCards = [], timerKey = '', timerTick = null;
    function fmtLeft(ms) {
      var t = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60);
      return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(t % 60);
    }
    function timerLook(t, now) {
      if (t.state === 'paused') return { cls: 'cv-timer-paused', time: fmtLeft(t.remaining), note: 'Paused', frac: t.duration ? t.remaining / t.duration : 0 };
      var left = t.state === 'running' ? t.endsAt - now : 0;
      if (t.state === 'done' || left <= 0) return { cls: 'cv-timer-done', time: 'Done!', note: '', frac: 0 };
      return { cls: '', time: fmtLeft(left), note: '', frac: t.duration ? left / t.duration : 0 };
    }
    function liveTimers(now) {
      var out = [];
      for (var i = 0; i < timerList.length; i++) {
        var t = timerList[i];
        if (t.until && now >= t.until) continue;
        // A finish the server never confirmed (connection lost): give up after 5 minutes.
        if (t.state === 'running' && !t.until && now > t.endsAt + 300000) continue;
        out.push(t);
      }
      return out;
    }
    function buildTimers() {
      clear(timersEl);
      timerCards = [];
      var list = liveTimers(stage.now()), h = stage.height || 400;
      var row = el('div', 'cv-timer-row', timersEl);
      for (var i = 0; i < list.length; i++) {
        var card = el('div', 'cv-timer-card', row);
        card.style.width = Math.round(92 / Math.max(2, list.length) - 2) + '%';
        card.style.borderRadius = Math.round(h * 0.04) + 'px';
        var label = el('div', 'cv-timer-label', card);
        label.textContent = list[i].label || 'Timer';
        label.style.fontSize = Math.round(h * (list.length > 2 ? 0.045 : 0.06)) + 'px';
        var time = el('div', 'cv-timer-time', card);
        time.style.fontSize = Math.round(h * (list.length > 2 ? 0.12 : 0.2)) + 'px';
        var note = el('div', 'cv-timer-note', card);
        note.style.fontSize = Math.round(h * 0.045) + 'px';
        var bar = el('div', 'cv-timer-bar', card);
        bar.style.height = Math.max(4, Math.round(h * 0.018)) + 'px';
        var fill = el('div', 'cv-timer-fill', bar);
        timerCards.push({ t: list[i], card: card, time: time, note: note, fill: fill, cls: null });
      }
      timerKey = keyOf(list);
    }
    function keyOf(list) {
      var k = [];
      for (var i = 0; i < list.length; i++) k.push(list[i].entity + '|' + list[i].state + '|' + (list[i].endsAt || list[i].remaining || list[i].doneAt || ''));
      return k.join(',');
    }
    function drawTimers() {
      var now = stage.now(), list = liveTimers(now);
      if (!list.length) { stopTimers(); return; }
      if (keyOf(list) !== timerKey) buildTimers();
      timersEl.style.display = '';
      for (var i = 0; i < timerCards.length; i++) {
        var c = timerCards[i], look = timerLook(c.t, now);
        if (c.time.textContent !== look.time) c.time.textContent = look.time;
        if (c.note.textContent !== look.note) c.note.textContent = look.note;
        c.note.style.display = look.note ? '' : 'none';
        c.fill.style.width = Math.max(0, Math.min(100, look.frac * 100)).toFixed(1) + '%';
        if (c.cls !== look.cls) { c.cls = look.cls; c.card.className = 'cv-timer-card' + (look.cls ? ' ' + look.cls : ''); }
      }
    }
    function stopTimers() {
      if (timerTick) clearInterval(timerTick);
      timerTick = null;
      timerList = []; timerCards = []; timerKey = '';
      timersEl.style.display = 'none';
      clear(timersEl);
    }
    stage.setTimers = function (list) {
      timerList = list || [];
      if (!timerList.length) { stopTimers(); return; }
      if (!timerTick) timerTick = setInterval(drawTimers, 250);
      drawTimers();
    };

    stage.destroy = function () {
      stopTimers();
      clearInterval(ticker);
      clearInterval(idleTimer);
      stage.closeSheet();
      stage.hideOverlay();
      for (var k in stage.widgets) remove(k);
      if (root.parentNode) root.parentNode.removeChild(root);
    };
    return stage;
  }

  function register(type, factory) { FACTORIES[type] = factory; }

  return { create: create, register: register, entityValue: entityValue, localParts: localParts, FONTS: FONTS,
    util: { el: el, clear: clear, pad: pad, hexToRgba: hexToRgba, styleBox: styleBox, stateOf: stateOf, DAYS: DAYS, MONTHS: MONTHS, WEATHER: WEATHER } };
})();
if (typeof module !== 'undefined') module.exports = CVRender;
