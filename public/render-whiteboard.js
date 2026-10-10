/* Whiteboard widgets for the CoreView renderer: a marker calendar for a grandparent's frame,
 * the sticky note, the drawing board and its preview tile, plus the
 * press-and-hold helper and the Grandkids-mode PIN pad. Ported from a standalone
 * whiteboard app; render.css carries its
 * sizes as the app's 1024x768 pixels / 16, in em (size 2.08 = 1em 16px).
 *
 * ES5 only, like render.js; tests/es5.test.js applies. Touch screens use
 * touch events: Firefox 68 on the original frame has pointer events off, and
 * turning them on wedged touch after drawing.
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear, pad = U.pad, DAYS = U.DAYS, MONTHS = U.MONTHS;
  var TOUCH = typeof window !== 'undefined' && 'ontouchstart' in window;

  // ---------- helpers ----------
  function text(parent, cls, value) { var e = el('div', cls, parent); e.textContent = value; return e; }
  function button(parent, cls, label, fn) {
    var b = el('button', cls, parent);
    if (label !== null) b.textContent = label;
    if (fn) b.onclick = function (e) { e.stopPropagation(); fn(e); };
    return b;
  }
  function size(box, props, stage) { box.style.fontSize = (props.size || 2.08) * stage.height / 100 + 'px'; }
  function hasClass(node, cls) { return (' ' + node.className + ' ').indexOf(' ' + cls + ' ') >= 0; }
  function setClass(node, cls, on) {
    if (on && !hasClass(node, cls)) node.className += ' ' + cls;
    if (!on && hasClass(node, cls)) node.className = (' ' + node.className + ' ').replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }
  function parts(stage, ms) { return CVRender.localParts(ms, stage.tzOffsetMin); }
  function keyOf(p) { return p.y + '-' + pad(p.mo + 1) + '-' + pad(p.d); }
  function todayKey(stage) { return keyOf(parts(stage, stage.now())); }
  function keyDate(key) { return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))); }
  function shiftKey(key, n) { var d = keyDate(key); d.setUTCDate(d.getUTCDate() + n); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function shortTime(m) { return m === null ? '' : m === 720 ? 'noon' : ((Math.floor(m / 60) + 11) % 12 + 1) + (m % 60 ? ':' + pad(m % 60) : '') + (m < 720 ? 'a' : 'p'); }
  function longTime(m) { return ((Math.floor(m / 60) + 11) % 12 + 1) + ':' + pad(m % 60) + ' ' + (m < 720 ? 'AM' : 'PM'); }
  function stop(e) { e.stopPropagation(); }

  // Events from the markers' calendars: [{e, c (marker), ci, min}] by day.
  function markerEvents(stage, cals) {
    var out = {}, ok = true;
    for (var i = 0; i < (cals || []).length; i++) {
      var d = stage.data['cal:' + cals[i].entity];
      if (!d) continue;
      if (d.ok === false) ok = false;
      for (var j = 0; j < d.events.length; j++) {
        var e = d.events[j], p = parts(stage, Date.parse(e.start));
        var x = { e: e, c: cals[i], ci: i, min: e.allDay ? null : p.h * 60 + p.mi };
        var last = e.lastDay || e.day;
        for (var k = e.day, n = 0; k <= last && n < 40; k = shiftKey(k, 1), n++) (out[k] = out[k] || []).push(x);
      }
    }
    for (var key in out) out[key].sort(function (a, b) { return (a.min === null ? -1 : a.min) - (b.min === null ? -1 : b.min); });
    return { on: function (k) { return out[k] || []; }, ok: ok };
  }

  // ---------- press and hold: a tap does nothing, a one-second hold acts ----------
  var HOLD_MS = 1000;
  function holdButton(parent, cls, label, small, onHold) {
    var b = el('button', 'wb-hold' + (cls ? ' ' + cls : ''), parent);
    b.appendChild(document.createTextNode(label));
    var hint = small ? el('small', '', b) : null;
    if (hint) hint.textContent = small;
    var t = null, fired = false, x0 = 0, y0 = 0;
    function cancel() { if (t) clearTimeout(t); t = null; setClass(b, 'wb-holding', false); }
    function start(e) {
      e.preventDefault(); e.stopPropagation(); fired = false; setClass(b, 'wb-holding', true);
      t = setTimeout(function () {
        fired = true; t = null; setClass(b, 'wb-holding', false); setClass(b, 'wb-done', true);
        setTimeout(function () { setClass(b, 'wb-done', false); }, 400);
        onHold(b);
      }, HOLD_MS);
    }
    function nudge() { if (hint) { hint.textContent = 'keep holding…'; setTimeout(function () { hint.textContent = small; }, 1500); } }
    if (TOUCH) {
      // preventDefault on touchstart stops the long-press menu and the click,
      // so a short tap nudges from touchend instead.
      b.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; start(e); }, false);
      b.addEventListener('touchmove', function (e) { var p = e.touches[0]; if (t && Math.abs(p.clientX - x0) + Math.abs(p.clientY - y0) > 40) cancel(); }, false);
      b.addEventListener('touchend', function (e) { e.stopPropagation(); var early = t !== null; cancel(); if (early && !fired) nudge(); }, false);
      b.addEventListener('touchcancel', cancel, false);
    } else {
      b.addEventListener('mousedown', start, false);
      b.addEventListener('mouseup', cancel, false);
      b.addEventListener('mouseleave', cancel, false);
    }
    b.onclick = function (e) { e.stopPropagation(); if (!fired) nudge(); };
    return b;
  }

  // A dark pill at the bottom, with an optional Undo: one per screen.
  function wbToast(stage) {
    if (!stage.wbToast || !stage.wbToast.el.parentNode) stage.wbToast = toaster(stage.el);
    stage.wbToast.el.style.fontSize = stage.height / 768 * 20 + 'px';
    return stage.wbToast;
  }
  function toaster(host) {
    var box = el('div', 'wb-toast', host), msg = el('span', '', box), undo = el('button', '', box), timer = null, fn = null;
    undo.textContent = 'Undo';
    box.onclick = stop;
    undo.onclick = function (e) { e.stopPropagation(); var f = fn; fn = null; setClass(box, 'wb-on', false); if (f) f(); };
    return {
      show: function (text, onUndo) {
        msg.textContent = text; fn = onUndo || null; undo.style.display = onUndo ? '' : 'none';
        setClass(box, 'wb-on', true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { setClass(box, 'wb-on', false); }, 5000);
      },
      el: box
    };
  }

  // ---------- Grandkids-mode PIN pad (used by the button widget) ----------
  // submit(pin, cb) asks the server; cb(err, status).
  // owner: whose PIN it is ("Grandma"); blank reads "Grown-ups only".
  function pinPad(stage, length, submit, owner) {
    var wrap = el('div', 'wb-pin', stage.el), card = el('div', 'wb-pin-card', wrap), val = '';
    wrap.style.fontSize = stage.height / 768 * 16 + 'px';
    wrap.onclick = stop;
    text(card, 'wb-pin-h', owner ? owner + ' only' : 'Grown-ups only');
    text(card, 'wb-pin-p', owner ? 'Enter ' + owner + '\'s PIN to turn off Grandkids mode' : 'Enter the PIN to turn off Grandkids mode');
    var dots = el('div', 'wb-dots', card), keys = el('div', 'wb-keys', card), dd = [];
    for (var i = 0; i < length; i++) dd.push(el('i', '', dots));
    function draw() { for (var i = 0; i < dd.length; i++) dd[i].className = i < val.length ? 'wb-f' : ''; }
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    var labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Cancel', '0', '⌫'];
    for (var k = 0; k < labels.length; k++) (function (n) {
      button(keys, n === 'Cancel' || n === '⌫' ? 'wb-k-no' : '', n, function () {
        if (n === 'Cancel') return close();
        if (n === '⌫') { val = val.slice(0, -1); return draw(); }
        if (val.length >= length) return;
        val += n; draw();
        if (val.length === length) submit(val, function (err, status, message) {
          if (!err) return close();
          setClass(dots, 'wb-bad', true);
          if (status === 429 && stage.toast) stage.toast(message || 'Too many tries. Wait a minute.');
          setTimeout(function () { setClass(dots, 'wb-bad', false); val = ''; draw(); }, 450);
        });
      });
    })(labels[k]);
    return { close: close };
  }
  U.pinPad = pinPad;
  U.wbToast = wbToast;
  U.holdButton = holdButton;

  // ---------- whiteboard calendar ----------
  var CIRCLE = '<svg viewBox="0 0 60 40" preserveAspectRatio="none"><path d="M8 22 C 6 8, 50 2, 55 17 C 60 33, 16 40, 7 27 C 3 19, 14 9, 30 7" fill="none" stroke="#c8282b" stroke-width="2.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
  var TIMES = [['All day', null], ['Morning', 540], ['Noon', 720], ['Afternoon', 840], ['Evening', 1080]];

  function wbcalWidget(box, stage, id) {
    var head = el('div', 'wb-bhead', box), grid = el('div', 'wb-grid', box), offline = el('div', 'wb-offline', box);
    offline.textContent = 'Can\'t reach the calendar right now. Showing what I last saw.';
    var prev = button(head, 'wb-rnd', '‹', function () { shift(-1); });
    var next = button(head, 'wb-rnd', '›', function () { shift(1); });
    var title = el('div', 'wb-mtitle', head);
    button(head, 'wb-today', 'Today', function () { shift(0); });
    var props = {}, weekOff = 0, lastMinute = -1, justAdded = {};
    // The day sheet slides in over the whole screen.
    var veil = el('div', 'wb-veil', stage.el), sheet = el('div', 'wb-sheet', stage.el);
    var shead = el('div', 'wb-shead', sheet), shTitle = el('h2', '', shead);
    button(shead, 'wb-x', '×', closeSheet);
    var sbody = el('div', 'wb-sbody', sheet), sfoot = el('div', 'wb-sfoot', sheet);
    var toast = { show: function (m, u) { wbToast(stage).show(m, u); } };
    veil.onclick = function (e) { e.stopPropagation(); closeSheet(); };
    sheet.onclick = stop;
    var day = null, form = null, erased = [], showErased = false, busy = false;

    function events() { return markerEvents(stage, props.calendars); }
    function shift(n) { weekOff = n === 0 ? 0 : weekOff + n; render(); }
    function canWrite() { return props.allowAdd && !stage.kids; }
    function canErase() { return props.allowErase && !stage.kids; }

    function render() {
      var ev = events(), today = todayKey(stage), tp = parts(stage, stage.now());
      var start = shiftKey(today, -tp.wd + weekOff * 7), end = shiftKey(start, 34);
      var sd = keyDate(start), ed = keyDate(end);
      title.textContent = (sd.getUTCMonth() === ed.getUTCMonth() ? MONTHS[sd.getUTCMonth()] : MONTHS[sd.getUTCMonth()].slice(0, 3) + ' – ' + MONTHS[ed.getUTCMonth()].slice(0, 3)) + ' ' + ed.getUTCFullYear();
      setClass(offline, 'wb-on', !ev.ok);
      clear(grid);
      var i;
      for (i = 0; i < 7; i++) text(grid, 'wb-dow', DAYS[i].slice(0, 3));
      for (i = 0; i < 35; i++) (function (i) {
        var k = shiftKey(start, i), d = keyDate(k), list = ev.on(k);
        var cell = el('div', 'wb-cell' + (i % 7 === 0 ? ' wb-c0' : '') + (i < 7 ? ' wb-r0' : '') + (k < today ? ' wb-past' : '') + (k === today ? ' wb-todaycell' : ''), grid);
        cell.style.left = (i % 7) * 100 / 7 + '%';
        cell.style.top = 'calc(1.875em + ' + Math.floor(i / 7) + ' * (100% - 1.875em) / 5)';
        var num = el('span', 'wb-num' + (d.getUTCDate() === 1 ? ' wb-m1' : ''), cell);
        num.textContent = d.getUTCDate() === 1 ? MONTHS[d.getUTCMonth()].slice(0, 3) + ' 1' : d.getUTCDate();
        if (k === today) num.innerHTML += CIRCLE;
        var cap = 3, shown = list.length > cap ? list.slice(0, cap - 1) : list;
        for (var j = 0; j < shown.length; j++) {
          var line = el('div', 'wb-ev' + (justAdded[shown[j].e.uid] ? ' wb-new' : ''), cell);
          line.style.color = shown[j].c.color;
          if (shown[j].min !== null) el('b', '', line).textContent = shortTime(shown[j].min);
          line.appendChild(document.createTextNode(shown[j].e.title));
        }
        if (list.length > shown.length) text(cell, 'wb-more', '+' + (list.length - shown.length) + ' more…');
        cell.onclick = function (e) { if (stage.editing) return; e.stopPropagation(); openDay(k); };
      })(i);
      justAdded = {};
      if (day) renderSheet();
    }

    // ---------- day sheet ----------
    function openDay(k) {
      day = k; form = null; showErased = false; erased = [];
      renderSheet();
      setClass(veil, 'wb-on', true); setClass(sheet, 'wb-on', true);
      if (canErase()) stage.api('GET', 'api/erased?widget=' + encodeURIComponent(id) + '&day=' + k, null, function (err, d) {
        if (!err && day === k) { erased = d.erased || []; renderSheet(); }
      });
    }
    function closeSheet() { setClass(veil, 'wb-on', false); setClass(sheet, 'wb-on', false); day = null; form = null; }
    function act(args, cb) {
      args.widget = id;
      stage.api('POST', 'api/act', args, function (err, d) {
        if (err) toast.show('Couldn\'t do that: ' + ((d && d.error) || err.message));
        cb(err, d || {});
      });
    }
    function renderSheet() {
      if (!day) return;
      var d = keyDate(day), today = todayKey(stage);
      var rel = day === today ? 'Today' : day === shiftKey(today, 1) ? 'Tomorrow' : day === shiftKey(today, -1) ? 'Yesterday' : '';
      clear(shTitle);
      shTitle.appendChild(document.createTextNode(DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate()));
      if (rel) el('small', '', shTitle).textContent = rel;
      clear(sbody); clear(sfoot);
      sfoot.style.display = form ? '' : 'none';
      if (form) return renderForm();
      var list = events().on(day);
      if (!list.length) text(sbody, 'wb-empty', 'Nothing written here yet.');
      for (var i = 0; i < list.length; i++) (function (x) {
        var item = el('div', 'wb-item', sbody);
        el('div', 'wb-bar', item).style.backgroundColor = x.c.color;
        text(item, 'wb-tm', x.min === null ? 'All day' : longTime(x.min));
        var ti = el('div', 'wb-ti', item);
        ti.style.color = x.c.color;
        ti.appendChild(document.createTextNode(x.e.title));
        el('span', '', ti).textContent = (x.c.name || 'Family') + '\'s marker' + (x.e.rec ? ' · every week' : '');
        if (canErase() && x.e.uid) holdButton(item, 'wb-er', 'Hold to erase', null, function () { erase(x, item); });
      })(list[i]);
      if (stage.kids) text(sbody, 'wb-look', '✏️ Grandkids mode is on, so the calendar is look-only. Ask ' + (props.owner || 'a grown-up') + ' to change this.');
      else {
        if (canWrite()) button(sbody, 'wb-big', '+ Add something to this day', function () {
          var first = 0;
          form = { title: '', cal: first, min: 600, allDay: false, weekly: false };
          renderSheet();
        });
        if (canErase() && erased.length) {
          if (!showErased) button(sbody, 'wb-oops', 'Bring back something erased (' + erased.length + ')', function () { showErased = true; renderSheet(); });
          else for (var j = 0; j < erased.length; j++) (function (x) {
            var item = el('div', 'wb-item wb-gone-item', sbody), cal = markerFor(x.calendar);
            el('div', 'wb-bar', item).style.backgroundColor = cal ? cal.color : '#888888';
            text(item, 'wb-tm', x.event.time ? longTime(Number(x.event.time.slice(0, 2)) * 60 + Number(x.event.time.slice(3))) : 'All day');
            var ti = el('div', 'wb-ti wb-struck', item);
            ti.style.color = cal ? cal.color : '#555555';
            ti.appendChild(document.createTextNode(x.event.title));
            el('span', '', ti).textContent = 'erased';
            button(item, 'wb-chip', 'Bring back', function () { restore(x.id, 'Back on the board.'); });
          })(erased[j]);
        }
      }
    }
    function markerFor(entity) {
      for (var i = 0; i < (props.calendars || []).length; i++) if (props.calendars[i].entity === entity) return props.calendars[i];
      return null;
    }
    function erase(x, item) {
      if (busy) return;
      busy = true;
      setClass(item, 'wb-gone', true);
      act({ action: 'erase', calendar: x.c.entity, uid: x.e.uid, rid: x.e.rid }, function (err, d) {
        busy = false;
        if (err) return renderSheet();
        if (d.erased) erased.push(d.erased);
        toast.show('Erased.', d.erased ? function () { restore(d.erased.id, 'Back on the board.'); } : null);
      });
    }
    function restore(entryId, msg) {
      act({ action: 'restore', id: entryId }, function (err, d) {
        if (err) return;
        if (d.event && d.event.uid) justAdded[d.event.uid] = true;
        var keep = [];
        for (var i = 0; i < erased.length; i++) if (erased[i].id !== entryId) keep.push(erased[i]);
        erased = keep;
        toast.show(msg);
        renderSheet();
      });
    }

    // ---------- the add form (fits one screen: Fennec 68 won't scroll the panel) ----------
    function renderForm() {
      var cals = props.calendars || [];
      text(sbody, 'wb-lab', 'What is it?');
      var trow = el('div', 'wb-trow', sbody), input = el('input', 'wb-txt', trow);
      input.setAttribute('maxlength', '40');
      input.setAttribute('placeholder', 'Write it here…');
      input.value = form.title;
      var done = button(trow, 'wb-donebtn', '✓ Done', function () { input.blur(); });
      input.oninput = function () { form.title = input.value; setClass(input, 'wb-txt-bad', false); };
      // No Back button on the frame: give the keyboard visible ways to close.
      var hideT = null;
      input.onfocus = function () { if (hideT) clearTimeout(hideT); setClass(trow, 'wb-typing', true); };
      input.onblur = function () { hideT = setTimeout(function () { setClass(trow, 'wb-typing', false); }, 300); };
      input.onkeydown = function (e) { if (e.keyCode === 13) { e.preventDefault(); input.blur(); } };
      input.onclick = stop;
      var quick = String(props.quickPicks || '').split(',');
      var qs = el('div', 'wb-chips wb-quick', sbody);
      for (var q = 0; q < quick.length; q++) (function (label) {
        label = label.replace(/^\s+|\s+$/g, '');
        if (!label) return;
        button(qs, 'wb-chip', label, function () {
          form.title = label.replace('…', ' ');
          renderSheet();
          // Only "Lunch with…" and "Call…" need more words: open the keyboard for those.
          if (label.indexOf('…') >= 0) { var f = sbody.getElementsByTagName('input')[0]; if (f) { f.focus(); f.setSelectionRange(99, 99); } }
        });
      })(quick[q]);
      text(sbody, 'wb-lab', 'When?');
      var ws = el('div', 'wb-chips', sbody);
      for (var t = 0; t < TIMES.length; t++) (function (tt) {
        var on = form.allDay ? tt[1] === null : tt[1] === form.min;
        button(ws, 'wb-chip' + (on ? ' wb-on' : ''), tt[0], function () {
          if (tt[1] === null) form.allDay = true; else { form.allDay = false; form.min = tt[1]; }
          renderSheet();
        });
      })(TIMES[t]);
      if (!form.allDay) {
        var step = el('div', 'wb-step', ws);
        button(step, 'wb-rnd', '–', function () { form.min = Math.max(300, form.min - 15); renderSheet(); });
        text(step, 'wb-val', longTime(form.min));
        button(step, 'wb-rnd', '+', function () { form.min = Math.min(1380, form.min + 15); renderSheet(); });
      }
      var duo = el('div', 'wb-duo', sbody), left = el('div', '', duo), right = el('div', '', duo);
      text(left, 'wb-lab', 'Whose marker?');
      var whos = el('div', 'wb-whos', left);
      for (var c = 0; c < cals.length; c++) (function (ci) {
        var b = button(whos, 'wb-who' + (form.cal === ci ? ' wb-on' : ''), null, function () {
          form.cal = ci;
          if (cals[ci].birthdays) { form.allDay = true; }
          renderSheet();
        });
        var dot = el('i', '', b);
        dot.style.backgroundColor = cals[ci].color;
        if (form.cal === ci) dot.style.boxShadow = '0 0 0 0.25em #ffffff, 0 0 0 0.44em ' + cals[ci].color;
        b.appendChild(document.createTextNode(cals[ci].name || 'Family'));
      })(c);
      text(right, 'wb-lab', 'Repeat?');
      var rs = el('div', 'wb-chips', right);
      button(rs, 'wb-chip' + (form.weekly ? '' : ' wb-on'), 'Just this day', function () { form.weekly = false; renderSheet(); });
      button(rs, 'wb-chip' + (form.weekly ? ' wb-on' : ''), 'Every week', function () { form.weekly = true; renderSheet(); });

      button(sfoot, 'wb-cancel', 'Never mind', function () { form = null; renderSheet(); });
      holdButton(sfoot, 'wb-save', 'Hold to write it', 'press and hold', function () {
        input.blur();
        var title2 = form.title.replace(/^\s+|\s+$/g, '');
        if (!title2) { setClass(input, 'wb-txt-bad', true); input.focus(); return; }
        if (busy) return;
        busy = true;
        var body = { action: 'add', cal: form.cal, title: title2, day: day, min: form.allDay ? null : form.min, weekly: form.weekly };
        act(body, function (err, d) {
          busy = false;
          if (err) return;
          closeSheet();
          if (d.event && d.event.uid) justAdded[d.event.uid] = true;
          toast.show(body.weekly ? 'Written on every week.' : 'Written on the board.', d.event ? function () {
            act({ action: 'erase', calendar: d.event.calendar, uid: d.event.uid, rid: d.event.rid }, function () {});
          } : null);
        });
      });
      done.onmousedown = function (e) { e.preventDefault(); };
    }

    return {
      update: function (pr) {
        props = pr; size(box, props, stage);
        veil.style.fontSize = sheet.style.fontSize = box.style.fontSize;
        render();
      },
      data: render,
      kids: function () { if (day) { form = null; renderSheet(); } },
      tick: function () { var m = parts(stage, stage.now()).h; if (m !== lastMinute) { lastMinute = m; render(); } },
      destroy: function () {
        var list = [veil, sheet];
        for (var i = 0; i < list.length; i++) if (list[i].parentNode) list[i].parentNode.removeChild(list[i]);
      }
    };
  }

  // ---------- sticky note ----------
  function stickyWidget(box, stage) {
    var note = el('div', 'wb-sticky', box), props = {}, lastMinute = -1;
    function render() {
      clear(note);
      var ev = markerEvents(stage, props.calendars), today = todayKey(stage);
      text(note, 'wb-sticky-h', props.title || 'Today');
      var list = ev.on(today);
      if (!list.length) text(note, 'wb-row', props.emptyText || '');
      for (var i = 0; i < list.length && i < 4; i++) {
        var row = el('div', 'wb-row', note);
        el('i', '', row).textContent = list[i].min === null ? 'all day' : shortTime(list[i].min);
        el('span', '', row).textContent = list[i].e.title;
        row.lastChild.style.color = list[i].c.color;
      }
      var tm = ev.on(shiftKey(today, 1));
      if (tm.length) text(note, 'wb-row wb-tomorrow', 'Tomorrow: ' + tm[0].e.title + (tm.length > 1 ? ' +' + (tm.length - 1) : ''));
      for (var n = 1; n <= (props.birthdayDays || 0); n++) {
        var b = null, on = ev.on(shiftKey(today, n));
        for (var j = 0; j < on.length; j++) if (on[j].c.birthdays) { b = on[j]; break; }
        if (b) { text(note, 'wb-soon', '🎂 ' + b.e.title.replace(/!$/, '') + ' in ' + n + ' day' + (n > 1 ? 's' : '')); break; }
      }
      if (!(props.calendars || []).length && stage.editing) text(note, 'wb-row', 'Add calendars in the panel on the right');
    }
    return {
      update: function (pr) { props = pr; size(box, props, stage); render(); },
      data: render,
      tick: function () { var m = parts(stage, stage.now()).mi; if (m !== lastMinute) { lastMinute = m; render(); } }
    };
  }

  // ---------- drawing board ----------
  var PLAY_COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ec407a', '#6d4c41', '#22262b'];
  var STAMPS = {
    star: 'M20 3l5 11 12 1-9 8 3 12-11-7-11 7 3-12-9-8 12-1z',
    heart: 'M20 35C4 24 2 15 7 9c4-5 10-4 13 1 3-5 9-6 13-1 5 6 3 15-13 26z',
    smile: 'M20 3a17 17 0 1 0 .01 0zM14 14v4M26 14v4M11 23q9 9 18 0',
    flower: 'M20 2a6 6 0 1 1 0 12 6 6 0 1 1 0-12zM20 26a6 6 0 1 1 0 12 6 6 0 1 1 0-12zM8 14a6 6 0 1 1 0 12 6 6 0 1 1 0-12zM32 14a6 6 0 1 1 0 12 6 6 0 1 1 0-12zM20 15a5 5 0 1 1 0 10 5 5 0 1 1 0-10z'
  };
  function drawingWidget(box, stage) {
    var surf = el('div', 'wb-wsurf', box), canvas = el('canvas', 'wb-canvas', surf), wtitle = el('div', 'wb-wtitle', surf);
    var top = el('div', 'wb-wtop', surf), tray = el('div', 'wb-wtray', box);
    var cx = canvas.getContext('2d'), toast = { show: function (m, u) { wbToast(stage).show(m, u); } };
    var props = {}, page = 'notes', tool = { kind: 'color' }, lastColor = PLAY_COLORS[0], hue = 0, stamp = {};
    var dirty = false, saveT = null, pts = {}, loadedFor = null;
    function notesColors() {
      var out = [], list = String(props.notesColors || '').split(',');
      for (var i = 0; i < list.length; i++) { var c = list[i].replace(/\s/g, ''); if (/^#[0-9a-fA-F]{6}$/.test(c)) out.push(c); }
      return out.length ? out : ['#22262b'];
    }
    function url(pg) { return stage.boardUrl(props.board, pg + '.png') + '?t=' + (stamp[pg] || 0); }
    function sizeCanvas() {
      var w = surf.clientWidth, h = surf.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * 1.5)) { canvas.width = Math.round(w * 1.5); canvas.height = Math.round(h * 1.5); loadPage(); }
    }
    function loadPage() {
      cx.clearRect(0, 0, canvas.width, canvas.height);
      if (!props.board) return;
      var want = page, im = new Image();
      im.onload = function () { if (page === want) cx.drawImage(im, 0, 0, canvas.width, canvas.height); };
      im.src = url(page);
      wtitle.textContent = page === 'play' ? (props.playTitle || 'Play') + '!' : props.notesTitle || '';
      renderTop();
      tool = { kind: 'color', color: page === 'play' ? PLAY_COLORS[0] : notesColors()[0] };
      lastColor = tool.color;
      renderTray();
    }
    function store(blank, cb) {
      if (saveT) clearTimeout(saveT);
      saveT = null;
      if ((!dirty && !blank) || stage.editing) { if (cb) cb(); return; }
      dirty = false;
      var which = page;
      stage.api('PUT', stage.boardUrl(props.board, which), { img: blank ? null : canvas.toDataURL('image/png') }, function (err, d) {
        if (err) toast.show('Couldn\'t save the drawing: ' + ((d && d.error) || err.message));
        else stamp[which] = new Date().getTime();
        if (cb) cb();
      });
    }
    function queueSave() { dirty = true; if (saveT) clearTimeout(saveT); saveT = setTimeout(function () { store(); }, 1500); }
    function setPage(pg) { if (pg === page) return; store(); page = pg; loadPage(); }
    function renderTop() {
      clear(top);
      if (props.backView) button(top, 'wb-pill wb-back', props.backLabel || '‹ Back', function () { store(); stage.goView(props.backView); });
      if (!stage.kids) {
        var tabs = el('div', 'wb-tabs', top);
        button(tabs, page === 'notes' ? 'wb-on' : '', props.notesTitle || 'Notes', function () { setPage('notes'); });
        button(tabs, page === 'play' ? 'wb-on' : '', props.playTitle || 'Play', function () { setPage('play'); });
      }
      el('div', 'wb-spacer', top);
      if (page === 'play' && props.allowFridge) button(top, 'wb-pill wb-fridge', '★ Put it on the fridge', fridge);
      holdButton(top, '', 'Hold to wipe', null, wipe);
    }
    function renderTray() {
      clear(tray);
      var cols = page === 'play' ? PLAY_COLORS : notesColors(), i;
      for (i = 0; i < cols.length; i++) (function (c) {
        var b = button(tray, 'wb-sw' + (tool.kind === 'color' && tool.color === c ? ' wb-sel' : ''), null, function () { tool = { kind: 'color', color: c }; lastColor = c; renderTray(); });
        b.style.backgroundColor = c;
      })(cols[i]);
      if (page === 'play') button(tray, 'wb-sw wb-rainbow' + (tool.kind === 'rainbow' ? ' wb-sel' : ''), null, function () { tool = { kind: 'rainbow' }; renderTray(); });
      button(tray, 'wb-sw wb-erase' + (tool.kind === 'eraser' ? ' wb-sel' : ''), null, function () { tool = { kind: 'eraser' }; renderTray(); });
      if (page === 'play') {
        el('div', 'wb-tsep', tray);
        for (var n in STAMPS) (function (name) {
          var b = button(tray, 'wb-sw wb-stamp' + (tool.kind === 'stamp' && tool.stamp === name ? ' wb-sel' : ''), null, function () { tool = { kind: 'stamp', stamp: name }; renderTray(); });
          b.innerHTML = '<svg viewBox="0 0 40 40"><path d="' + STAMPS[name] + '" fill="' + (name === 'smile' ? 'none' : lastColor) + '" stroke="' + lastColor + '" stroke-width="' + (name === 'smile' ? 3 : 0) + '" stroke-linecap="round" fill-rule="evenodd"/></svg>';
        })(n);
      }
    }
    // ---------- drawing: each finger draws its own line ----------
    function at(pt) { var r = canvas.getBoundingClientRect(); return [(pt.clientX - r.left) * canvas.width / r.width, (pt.clientY - r.top) * canvas.height / r.height]; }
    function penW() { return tool.kind === 'eraser' ? 60 : page === 'play' ? 18 : 8; }
    function penC() { return tool.kind === 'rainbow' ? 'hsl(' + hue + ',85%,52%)' : tool.color || '#000000'; }
    function stampAt(p) {
      var s = 2.6;
      cx.save(); cx.globalCompositeOperation = 'source-over'; cx.translate(p[0] - 20 * s, p[1] - 20 * s); cx.scale(s, s);
      var path = new window.Path2D(STAMPS[tool.stamp]);
      if (tool.stamp === 'smile') { cx.strokeStyle = lastColor; cx.lineWidth = 3; cx.lineCap = 'round'; cx.stroke(path); }
      else { cx.fillStyle = lastColor; cx.fill(path, 'evenodd'); }
      cx.restore();
    }
    function down(id, pt) {
      if (stage.editing || (page === 'notes' && stage.kids)) return;
      var p = at(pt);
      if (tool.kind === 'stamp') { stampAt(p); queueSave(); return; }
      pts[id] = p;
      cx.globalCompositeOperation = tool.kind === 'eraser' ? 'destination-out' : 'source-over';
      cx.fillStyle = penC(); cx.beginPath(); cx.arc(p[0], p[1], penW() / 2, 0, 7); cx.fill();
    }
    function move(id, pt) {
      var last = pts[id];
      if (!last) return;
      var p = at(pt);
      cx.globalCompositeOperation = tool.kind === 'eraser' ? 'destination-out' : 'source-over';
      if (tool.kind === 'rainbow') hue = (hue + 4) % 360;
      cx.strokeStyle = penC(); cx.lineWidth = penW(); cx.lineCap = 'round'; cx.lineJoin = 'round';
      cx.beginPath(); cx.moveTo(last[0], last[1]); cx.lineTo(p[0], p[1]); cx.stroke();
      pts[id] = p;
    }
    function end(id) { if (pts[id]) { delete pts[id]; queueSave(); } }
    function each(fn) {
      return function (e) {
        e.preventDefault(); e.stopPropagation();
        for (var i = 0; i < e.changedTouches.length; i++) fn('t' + e.changedTouches[i].identifier, e.changedTouches[i]);
      };
    }
    if (TOUCH) {
      canvas.addEventListener('touchstart', each(down), false);
      canvas.addEventListener('touchmove', each(move), false);
      canvas.addEventListener('touchend', each(end), false);
      canvas.addEventListener('touchcancel', each(end), false);
    } else {
      var mouseDown = false;
      canvas.addEventListener('mousedown', function (e) { mouseDown = true; down('m', e); }, false);
      canvas.addEventListener('mousemove', function (e) { if (mouseDown) move('m', e); }, false);
      document.addEventListener('mouseup', function () { if (mouseDown) { mouseDown = false; end('m'); } }, false);
    }
    canvas.onclick = stop;
    box.onclick = stop;
    function wipe() {
      var snapshot = canvas.toDataURL('image/png');
      cx.clearRect(0, 0, canvas.width, canvas.height);
      store(true, function () {
        toast.show('Wiped clean.', function () {
          var im = new Image();
          im.onload = function () { cx.drawImage(im, 0, 0, canvas.width, canvas.height); dirty = true; store(); };
          im.src = snapshot;
        });
      });
    }
    function fridge() {
      var w = 800, h = Math.round(w * canvas.height / canvas.width), c = document.createElement('canvas');
      c.width = w; c.height = h;
      var x = c.getContext('2d');
      x.fillStyle = '#fbfbf8'; x.fillRect(0, 0, w, h); x.drawImage(canvas, 0, 0, w, h);
      stage.api('POST', stage.boardUrl(props.board, 'fridge'), { img: c.toDataURL('image/jpeg', 0.8) }, function (err, d) {
        toast.show(err ? 'Couldn\'t put it on the fridge: ' + ((d && d.error) || err.message) : 'On the fridge! It will show up with the photos.');
      });
    }
    return {
      update: function (pr) {
        var boardChanged = pr.board !== props.board;
        props = pr; size(box, props, stage);
        if (stage.kids) page = 'play';
        if (boardChanged || loadedFor !== page) { loadedFor = page; canvas.width = 0; }
        setTimeout(sizeCanvas, 0);
        renderTop(); renderTray();
      },
      kids: function () { if (stage.kids && page !== 'play') { store(); page = 'play'; loadPage(); } else renderTop(); },
      destroy: function () { store(); }
    };
  }

  // ---------- drawing preview tile ----------
  var SQUIG = '<svg class="wb-squig" viewBox="0 0 150 120" preserveAspectRatio="xMidYMid meet">' +
    '<path d="M20 80 C 35 30, 55 30, 60 70 S 90 110, 100 60 S 125 30, 135 50" fill="none" stroke="#e53935" stroke-width="5" stroke-linecap="round"/>' +
    '<path d="M30 100 l12 -10 l12 10 l12 -10 l12 10" fill="none" stroke="#1e88e5" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="115" cy="95" r="10" fill="none" stroke="#43a047" stroke-width="5"/></svg>';
  function drawtileWidget(box, stage) {
    var tile = el('div', 'wb-tile', box), props = {}, shown = null;
    var tl = el('div', 'wb-tile-t', tile), squig = el('div', 'wb-squig-box', tile), go = el('div', 'wb-go', tile);
    squig.innerHTML = SQUIG;
    function refresh() {
      if (!props.board) return;
      var pg = stage.kids ? 'play' : 'notes', u = stage.boardUrl(props.board, pg + '.png') + '?t=' + new Date().getTime(), probe = new Image();
      probe.onload = function () { tile.style.backgroundImage = 'url("' + u + '")'; squig.style.display = 'none'; };
      probe.onerror = function () { tile.style.backgroundImage = 'none'; squig.style.display = ''; };
      probe.src = u;
      shown = pg;
    }
    function render() {
      tl.textContent = props.title || '';
      go.textContent = stage.kids ? 'Tap to draw!' : 'Tap to open';
      setClass(tile, 'wb-kids', stage.kids);
    }
    tile.onclick = function (e) { if (stage.editing || !props.view) return; e.stopPropagation(); stage.goView(props.view); };
    var timer = setInterval(refresh, 60000);
    return {
      update: function (pr) { props = pr; size(box, props, stage); render(); refresh(); },
      kids: function () { render(); refresh(); },
      destroy: function () { clearInterval(timer); }
    };
  }

  CVRender.register('wbcal', wbcalWidget);
  CVRender.register('sticky', stickyWidget);
  CVRender.register('drawing', drawingWidget);
  CVRender.register('drawtile', drawtileWidget);
})();
