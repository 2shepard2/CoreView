/* Household widgets for the CoreView renderer: calendar, who's home, to-do
 * list, kids' chores, time since, button, sky, "who came by", card, status
 * tile and status icons. Ported from an earlier standalone house board app;
 * render.css carries its sizes in em.
 *
 * ES5 only, like render.js (the bedroom frame runs Chrome 44); the same
 * tests/es5.test.js rules apply. Data arrives as stage.data[key] (see
 * lib/household.js) and Home Assistant states as stage.states.
 */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear, pad = U.pad, DAYS = U.DAYS, MONTHS = U.MONTHS;

  // ---------- time helpers (house time, via the stage's UTC offset) ----------
  function parts(stage, ms) { return CVRender.localParts(ms, stage.tzOffsetMin); }
  function t12(stage, ms) {
    var p = parts(stage, ms), h = p.h % 12 || 12;
    return h + ':' + pad(p.mi) + ' ' + (p.h < 12 ? 'AM' : 'PM');
  }
  function keyOf(p) { return p.y + '-' + pad(p.mo + 1) + '-' + pad(p.d); }
  function todayKey(stage) { return keyOf(parts(stage, stage.now())); }
  function shiftKey(key, n) {
    var d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)) + n));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function keyDate(key) { return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))); }
  function longDay(key) { var d = keyDate(key); return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function daysBetween(a, b) { return Math.round((keyDate(b) - keyDate(a)) / 864e5); }
  function ago(stage, iso) {
    var m = Math.max(0, Math.round((stage.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + (m % 60 && h < 3 ? ' ' + (m % 60) + 'm' : '');
    return Math.floor(h / 24) + 'd';
  }

  // ---------- small DOM helpers ----------
  function text(parent, cls, value) { var e = el('div', cls, parent); e.textContent = value; return e; }
  function btn(parent, label, cls, onclick, base) {
    var b = el('button', (base || 'hh-btn') + (cls ? ' ' + cls : ''), parent);
    b.textContent = label;
    b.onclick = function (e) { e.stopPropagation(); onclick(e); };
    return b;
  }
  function size(box, props, stage) {
    if (props.bg !== undefined) U.styleBox(box, props, stage);
    box.style.fontSize = (props.size || 1.04) * stage.height / 100 + 'px';
    setClass(box, 'hh-outline', !!props.outline);
  }
  function setClass(node, cls, on) {
    var has = (' ' + node.className + ' ').indexOf(' ' + cls + ' ') >= 0;
    if (on && !has) node.className += ' ' + cls;
    if (!on && has) node.className = (' ' + node.className + ' ').replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }
  function tap(node, stage, fn) { node.onclick = function (e) { if (stage.editing) return; e.stopPropagation(); fn(e); }; }
  // A card heading: small spaced capitals, an optional note on the right.
  function heading(parent, title, note, warn) {
    var h = el('div', 'hh-h', parent);
    text(h, 'hh-h-t', title);
    if (note) text(h, 'hh-h-x' + (warn ? ' hh-warn' : ''), note);
    return h;
  }
  // The person's picture over a coloured disc with their initial.
  function avatar(parent, stage, entity, name, color, dot) {
    var a = el('div', 'hh-av', parent);
    a.style.backgroundColor = color || '#555555';
    a.style.backgroundImage = 'radial-gradient(circle at 30% 25%, rgba(255,255,255,0.35), rgba(255,255,255,0) 55%)';
    text(a, 'hh-av-letter cv-acc', (name || '?').charAt(0).toUpperCase());
    var s = U.stateOf(stage, entity);
    if (entity && s && s.attributes && s.attributes.has_picture) {
      var img = el('div', 'hh-av-img', a);
      img.style.backgroundImage = 'url("' + stage.personUrl(entity) + '")';
    }
    if (dot) el('div', 'hh-av-dot', a);
    return a;
  }
  function nameOf(stage, entity, fallback) {
    var s = U.stateOf(stage, entity);
    return fallback || (s && s.attributes && s.attributes.friendly_name) || entity || '';
  }
  // A list of rows with a check box, for sheets (to-do, chores).
  function checklist(body, items, canCheck, onCheck, emptyText) {
    var ul = el('div', 'hh-list', body);
    if (!items.length) { text(ul, 'hh-li hh-muted', emptyText); return ul; }
    for (var i = 0; i < items.length; i++) (function (it) {
      var li = el('div', 'hh-li' + (it.done ? ' hh-done' : ''), ul);
      text(li, 'hh-ck', it.done ? '✓' : '');
      text(li, 'hh-li-text cv-acc', it.text);
      if (canCheck) li.onclick = function () { li.className = 'hh-li' + (it.done ? '' : ' hh-done'); onCheck(it); };
    })(items[i]);
    return ul;
  }
  function addRow(body, placeholder, onAdd) {
    var row = el('div', 'hh-inp', body);
    var input = el('input', 'cv-acc', row);
    input.setAttribute('placeholder', placeholder);
    input.setAttribute('maxlength', '80');
    var go = function () { var v = input.value.replace(/^\s+|\s+$/g, ''); if (!v) return; input.value = ''; input.blur(); onAdd(v); };
    input.onkeydown = function (e) { if (e.keyCode === 13) { e.preventDefault(); go(); } };
    btn(row, 'Add', 'hh-pri', go);
    return input;
  }

  // ---------- calendar ----------
  function calendarWidget(box, stage, id) {
    var root = el('div', 'hh-cal', box);
    var props = {}, lastMinute = -1;
    function merged() {
      var out = [], ok = true, cals = props.calendars || [];
      for (var i = 0; i < cals.length; i++) {
        var d = stage.data['cal:' + cals[i].entity];
        if (!d) continue;
        if (d.ok === false) ok = false;
        for (var j = 0; j < d.events.length; j++) out.push({ e: d.events[j], c: cals[i], ci: i });
      }
      out.sort(function (a, b) {
        if (a.e.day !== b.e.day) return a.e.day < b.e.day ? -1 : 1;
        if (a.e.allDay !== b.e.allDay) return a.e.allDay ? -1 : 1;
        return a.e.start < b.e.start ? -1 : a.e.start > b.e.start ? 1 : 0;
      });
      return { list: out, ok: ok };
    }
    function on(list, key) {
      var out = [];
      for (var i = 0; i < list.length; i++) if (list[i].e.day <= key && (list[i].e.lastDay || list[i].e.day) >= key) out.push(list[i]);
      return out;
    }
    function nextBirthday(list, today) {
      for (var i = 0; i < list.length; i++) if (list[i].c.birthdays && list[i].e.day >= today) return list[i];
      return null;
    }
    function whenText(x) { return x.e.allDay ? 'All day' : t12(stage, Date.parse(x.e.start)); }

    function row(parent, x, cls) {
      var r = el('div', 'hh-ev' + (cls ? ' ' + cls : ''), parent);
      var bar = el('div', 'hh-ev-bar', r);
      bar.style.backgroundColor = x.c.color;
      text(r, 'hh-ev-time', whenText(x));
      text(r, 'hh-ev-title cv-acc', x.e.title);
      tap(r, stage, function () { openEvent(x); });
      return r;
    }

    function agenda(list, ok) {
      var now = stage.now(), today = todayKey(stage), tomorrow = shiftKey(today, 1);
      var head = heading(root, 'Today', ok ? '' : 'Calendar unavailable', true);
      if (props.allowAdd) btn(head, '+ Add', '', function () { if (!stage.editing) openAdd(today); }, 'hh-add');
      var T = on(list, today), N = on(list, tomorrow), budget = props.maxItems || 7;
      var past = [], rest = [], i;
      for (i = 0; i < T.length; i++) {
        var x = T[i], isPast = !x.e.allDay && Date.parse(x.e.end) < now;
        (isPast ? past : rest).push({ x: x, past: isPast, now: !x.e.allDay && Date.parse(x.e.start) <= now && !isPast });
      }
      var room = budget - (N.length ? 2 : 0);
      if (past.length + rest.length > room) past = past.slice(-1);
      var shown = past.concat(rest).slice(0, Math.max(1, room));
      var evs = el('div', 'hh-evs', root);
      if (!shown.length) text(evs, 'hh-empty cv-acc', 'Nothing on the calendar today.');
      for (i = 0; i < shown.length; i++) row(evs, shown[i].x, shown[i].past ? 'hh-past' : shown[i].now ? 'hh-now' : '');
      if (T.length > shown.length) text(evs, 'hh-more', '+' + (T.length - shown.length) + ' more today');
      var left = budget - Math.max(1, shown.length);
      if (N.length && left > 0) {
        text(evs, 'hh-sub', 'Tomorrow');
        var n2 = N.slice(0, Math.max(1, left));
        for (i = 0; i < n2.length; i++) row(evs, n2[i], i === n2.length - 1 ? 'hh-ev-last' : '');
        if (N.length > n2.length) text(evs, 'hh-more', '+' + (N.length - n2.length) + ' more tomorrow');
      }
      birthday(list, today);
    }

    function birthday(list, today) {
      if (!props.showBirthday) return;
      var b = nextBirthday(list, today);
      if (!b) return;
      var days = daysBetween(today, b.e.day);
      var line = el('div', 'hh-bday', root);
      text(line, 'hh-bday-cake', '🎂');
      var mid = el('div', 'hh-bday-mid', line);
      text(mid, 'hh-bday-title', b.e.title);
      text(mid, 'hh-bday-day', longDay(b.e.day));
      text(line, 'hh-bday-when cv-acc', days === 0 ? 'Today!' : days === 1 ? 'Tomorrow' : days + ' days');
    }

    function month(list, ok) {
      var today = todayKey(stage), tp = parts(stage, stage.now());
      var start = shiftKey(today, -tp.wd), weeks = props.weeks || 5;
      var sp = keyDate(start), ep = keyDate(shiftKey(start, weeks * 7 - 1));
      var head = heading(root, MONTHS[sp.getUTCMonth()] + (sp.getUTCMonth() !== ep.getUTCMonth() ? ' – ' + MONTHS[ep.getUTCMonth()] : ''), ok ? '' : 'Calendar unavailable', true);
      if (props.allowAdd) btn(head, '+ Add', '', function () { if (!stage.editing) openAdd(today); }, 'hh-add');
      var grid = el('div', 'hh-grid', root);
      var wk = el('div', 'hh-week hh-wkhead', grid);
      for (var d = 0; d < 7; d++) text(wk, 'hh-wd', DAYS[d].slice(0, 3));
      var fs = (props.size || 1.04) * stage.height / 100;
      var cellH = (box.clientHeight - fs * 4) / weeks;
      var maxChips = Math.max(1, Math.floor((cellH - fs * 1.4) / (fs * 1.3)));
      for (var w = 0; w < weeks; w++) {
        var week = el('div', 'hh-week', grid);
        for (d = 0; d < 7; d++) (function (key) {
          var cell = el('div', 'hh-day' + (key === today ? ' hh-today' : key < today ? ' hh-past' : ''), week);
          var dn = keyDate(key);
          text(cell, 'hh-dn', (dn.getUTCDate() === 1 ? MONTHS[dn.getUTCMonth()].slice(0, 3) + ' ' : '') + dn.getUTCDate());
          var evs = on(list, key);
          for (var i = 0; i < evs.length && i < maxChips; i++) {
            var chip = el('div', 'hh-chip', cell);
            chip.style.borderLeftColor = evs[i].c.color;
            chip.textContent = (evs[i].e.allDay ? '' : t12(stage, Date.parse(evs[i].e.start)).replace(':00', '').replace(' ', '').toLowerCase() + ' ') + evs[i].e.title;
          }
          if (evs.length > maxChips) text(cell, 'hh-chip hh-more', '+' + (evs.length - maxChips));
          tap(cell, stage, function () { openDay(key); });
        })(shiftKey(start, w * 7 + d));
      }
    }

    function render() {
      clear(root);
      if (!(props.calendars || []).length) { text(root, 'hh-empty', stage.editing ? 'Add a calendar in the panel on the right' : ''); return; }
      var m = merged();
      if (props.layout === 'month') month(m.list, m.ok); else agenda(m.list, m.ok);
      var owner = stage.sheetOwner();
      if (owner && owner.widget === id && owner.redraw) owner.redraw();
    }

    function openEvent(x) {
      var body = stage.openSheet(x.e.title);
      var when = x.e.allDay ? 'All day' : t12(stage, Date.parse(x.e.start)) + ' – ' + t12(stage, Date.parse(x.e.end));
      text(body, 'hh-p', longDay(x.e.day) + ' · ' + when);
      text(body, 'hh-p hh-muted', (x.c.name || nameOf(stage, x.c.entity)) + ' calendar' + (x.e.rec ? ' · repeats' : ''));
      var row2 = el('div', 'hh-btns', body);
      btn(row2, 'Close', '', stage.closeSheet);
      if (props.allowErase && x.e.uid) btn(row2, x.e.rec ? 'Erase just this one' : 'Erase', 'hh-danger', function () {
        stage.closeSheet();
        stage.act(id, 'erase', { calendar: x.c.entity, uid: x.e.uid, rid: x.e.rid }, 'Erased.');
      });
    }

    function openDay(key) {
      var owner = { widget: id };
      var body = stage.openSheet(longDay(key), owner);
      owner.redraw = function () {
        clear(body);
        var evs = on(merged().list, key);
        if (!evs.length) text(body, 'hh-empty cv-acc', 'Nothing on this day.');
        for (var i = 0; i < evs.length; i++) row(body, evs[i]);
        var row2 = el('div', 'hh-btns', body);
        btn(row2, 'Close', '', stage.closeSheet);
        if (props.allowAdd) btn(row2, '+ Add on this day', 'hh-pri', function () { openAdd(key); });
      };
      owner.redraw();
    }

    function openAdd(dayKey) {
      var cals = props.calendars || [];
      var pick = 0;
      for (var i = 0; i < cals.length; i++) if (!cals[i].birthdays) { pick = i; break; }
      var f = { title: '', cal: pick, date: dayKey, time: '18:00', allDay: false, repeat: 'none' };
      var body = stage.openSheet('Add to the calendar');
      function draw() {
        clear(body);
        var isBday = cals[f.cal] && cals[f.cal].birthdays;
        var inRow = el('div', 'hh-inp', body);
        var title = el('input', 'cv-acc', inRow);
        title.setAttribute('maxlength', '80');
        title.setAttribute('placeholder', isBday ? 'Whose birthday?' : 'What is it?');
        title.value = f.title;
        title.oninput = function () { f.title = title.value; };
        text(body, 'hh-lab', 'Calendar');
        var cs = el('div', 'hh-chips', body);
        for (var c = 0; c < cals.length; c++) (function (ci) {
          var b = btn(cs, '', ci === f.cal ? 'hh-on' : '', function () {
            f.cal = ci;
            if (cals[ci].birthdays) { f.allDay = true; f.repeat = 'yearly'; }
            draw();
          }, 'hh-chipbtn');
          el('i', 'hh-dot', b).style.backgroundColor = cals[ci].color;
          b.appendChild(document.createTextNode(cals[ci].name || nameOf(stage, cals[ci].entity)));
        })(c);
        text(body, 'hh-lab', 'Day');
        var ds = el('div', 'hh-chips', body), today = todayKey(stage);
        for (var d = 0; d < 7; d++) (function (key, n) {
          btn(ds, n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : DAYS[keyDate(key).getUTCDay()].slice(0, 3), key === f.date ? 'hh-on' : '', function () { f.date = key; draw(); }, 'hh-chipbtn');
        })(shiftKey(today, d), d);
        var date = el('input', '', ds);
        date.setAttribute('type', 'date');
        date.value = f.date;
        date.onchange = function () { if (date.value) { f.date = date.value; draw(); } };
        text(body, 'hh-lab', 'Time');
        var ts = el('div', 'hh-chips', body);
        btn(ts, 'All day', f.allDay ? 'hh-on' : '', function () { f.allDay = !f.allDay; draw(); }, 'hh-chipbtn');
        var time = el('input', '', ts);
        time.setAttribute('type', 'time');
        time.value = f.time;
        time.disabled = f.allDay;
        time.onchange = function () { if (time.value) f.time = time.value; };
        text(body, 'hh-lab', 'Repeat');
        var rs = el('div', 'hh-chips', body);
        var reps = [['none', 'Just once'], ['weekly', 'Every week'], ['yearly', 'Every year']];
        for (var r = 0; r < reps.length; r++) (function (rp) {
          btn(rs, rp[1], f.repeat === rp[0] ? 'hh-on' : '', function () { f.repeat = rp[0]; draw(); }, 'hh-chipbtn');
        })(reps[r]);
        var row2 = el('div', 'hh-btns', body);
        btn(row2, 'Cancel', '', stage.closeSheet);
        btn(row2, 'Save', 'hh-pri', function () {
          f.title = title.value.replace(/^\s+|\s+$/g, '');
          if (!f.title) { title.focus(); stage.toast('Give it a name first'); return; }
          stage.closeSheet();
          stage.act(id, 'add', { cal: f.cal, title: f.title, date: f.date, time: f.allDay ? null : f.time, repeat: f.repeat },
            'Added to the ' + (cals[f.cal].name || 'family') + ' calendar');
        });
      }
      draw();
    }

    return {
      update: function (pr) { props = pr; size(box, props, stage); render(); },
      data: render,
      tick: function () { var m = parts(stage, stage.now()).mi; if (m !== lastMinute) { lastMinute = m; render(); } }
    };
  }

  // ---------- who's home ----------
  function peopleWidget(box, stage) {
    var root = el('div', 'hh-people', box), props = {}, lastMinute = -1;
    function render() {
      clear(root);
      var list = props.people || [];
      if (!list.length) { text(root, 'hh-empty', stage.editing ? 'Add people in the panel on the right' : ''); return; }
      for (var i = 0; i < list.length; i++) {
        var p = list[i], s = U.stateOf(stage, p.entity), name = nameOf(stage, p.entity, p.name);
        var home = s ? s.state === 'home' : null;
        var card = el('div', 'hh-person' + (home === true ? ' hh-home' : home === false ? ' hh-away' : ''), root);
        var av = avatar(card, stage, p.entity, name, p.color, true);
        if (home) av.style.boxShadow = '0 0 0 0.25em ' + p.color + ', 0 0 2em -0.2em ' + p.color;
        text(card, 'hh-pname', name);
        if (props.showStatus) {
          var since = s && s.last_changed, st = '—';
          if (home === true) st = since && stage.now() - Date.parse(since) < 3 * 3600e3 ? 'Home · ' + t12(stage, Date.parse(since)).replace(/ (AM|PM)/, '') : 'Home';
          else if (home === false) st = (s.state !== 'not_home' ? s.state : 'Away') + (since ? ' · ' + ago(stage, since) : '');
          text(card, 'hh-pstat', st);
        }
      }
    }
    return {
      update: function (pr) { props = pr; size(box, props, stage); render(); },
      states: render,
      tick: function () { var m = parts(stage, stage.now()).mi; if (m !== lastMinute) { lastMinute = m; render(); } }
    };
  }

  // ---------- to-do list ----------
  function todoWidget(box, stage, id) {
    var root = el('div', 'hh-tile', box), props = {};
    function items() { var d = stage.data['todo:' + props.entity]; return d ? d.items : []; }
    function open() { return items().filter(function (x) { return !x.done; }); }
    function render() {
      clear(root);
      text(root, 'hh-ic', props.icon || '🛒');
      var mid = el('div', 'hh-tile-mid', root);
      var list = open();
      text(mid, 'hh-k', (props.title || nameOf(stage, props.entity)) + (list.length ? ' · ' + list.length : ''));
      var preview = [];
      for (var i = 0; i < list.length && i < (props.preview || 0); i++) preview.push(list[i].text);
      text(mid, 'hh-v', !props.entity ? (stage.editing ? 'Choose a list' : '') : list.length ? preview.join(' · ') : 'Nothing needed');
      var owner = stage.sheetOwner();
      if (owner && owner.widget === id) owner.redraw();
    }
    function sheet() {
      var owner = { widget: id };
      var body = stage.openSheet((props.icon ? props.icon + ' ' : '') + (props.title || 'List'), owner);
      var input = null;
      owner.redraw = function () {
        var typed = input ? input.value : '', focused = input && document.activeElement === input;
        clear(body);
        text(body, 'hh-p hh-muted', props.allowCheck ? 'Tap an item when it\'s done.' : 'The same list as the Home Assistant app.');
        checklist(body, open(), props.allowCheck, function (it) { stage.act(id, 'check', { uid: it.uid, done: true }); }, 'Nothing on the list.');
        if (props.allowAdd) {
          input = addRow(body, 'Add something…', function (v) { stage.act(id, 'add', { text: v }, 'Added ' + v); });
          input.value = typed;
          if (focused) input.focus();
        }
        btn(el('div', 'hh-btns', body), 'Done', '', stage.closeSheet);
      };
      owner.redraw();
    }
    tap(root, stage, sheet);
    return { update: function (pr) { props = pr; size(box, props, stage); render(); }, data: render };
  }

  // ---------- kids' chores ----------
  function choresWidget(box, stage, id) {
    var root = el('div', 'hh-chores', box), props = {};
    function items(k) { var d = stage.data['todo:' + k.entity]; return d ? d.items : []; }
    function count(list) { var n = 0; for (var i = 0; i < list.length; i++) if (list[i].done) n++; return n; }
    function render() {
      clear(root);
      var kids = props.kids || [], all = 0, done = 0, i;
      for (i = 0; i < kids.length; i++) { var it = items(kids[i]); all += it.length; done += count(it); }
      heading(root, props.title || 'Chores', all ? done + ' of ' + all + ' done' + (done === all ? ' 🎉' : props.footer ? ' · ' + props.footer : '') : '');
      root.className = 'hh-chores' + (props.chipLayout === 'row' ? ' hh-krow' : '');
      var chips = el('div', 'hh-kchips', root);
      if (!kids.length) text(chips, 'hh-empty', stage.editing ? 'Add kids in the panel on the right' : '');
      for (i = 0; i < kids.length; i++) (function (k, ki) {
        var list = items(k), n = count(list);
        var chip = el('div', 'hh-kchip' + (list.length && n === list.length ? ' hh-kdone' : ''), chips);
        if (props.chipLayout === 'row') chip.style.borderColor = k.color;
        avatar(chip, stage, k.person, k.name, k.color).style.boxShadow = '0 0 0 3px ' + k.color;
        text(chip, 'hh-kname', k.name || nameOf(stage, k.entity));
        text(chip, 'hh-kby', list.length ? n + ' of ' + list.length : 'Nothing today');
        tap(chip, stage, function () { sheet(k, ki); });
      })(kids[i], i);
      var owner = stage.sheetOwner();
      if (owner && owner.widget === id) owner.redraw();
    }
    function sheet(k, ki) {
      var owner = { widget: id }, name = k.name || nameOf(stage, k.entity);
      var body = stage.openSheet('🧹 ' + name + '\'s chores', owner);
      var input = null;
      owner.redraw = function () {
        var typed = input ? input.value : '';
        clear(body);
        text(body, 'hh-p hh-muted', 'Tap a chore when it\'s done.' + (props.footer ? ' Done ' + props.footer + ', please.' : ''));
        checklist(body, items(k), props.allowCheck, function (it) {
          stage.act(id, 'check', { kid: ki, uid: it.uid, done: !it.done }, it.done ? null : 'Nice work, ' + name + '!');
        }, 'Nothing on the list.');
        if (props.allowAdd) { input = addRow(body, 'Add a chore for ' + name + '…', function (v) { stage.act(id, 'add', { kid: ki, text: v }, 'Added for ' + name); }); input.value = typed; }
        btn(el('div', 'hh-btns', body), 'Done', '', stage.closeSheet);
      };
      owner.redraw();
    }
    return { update: function (pr) { props = pr; size(box, props, stage); render(); }, data: render, states: render };
  }

  // ---------- time since (dogs out) ----------
  function sinceWidget(box, stage, id) {
    var root = el('div', 'hh-tile', box), props = {}, lastMinute = -1;
    function info() {
      var s = U.stateOf(stage, props.entity);
      if (!s || !s.state || s.state === 'unknown' || s.state === 'unavailable') return null;
      var last = Date.parse(s.state.replace(' ', 'T') + (s.state.length <= 19 ? offsetSuffix() : ''));
      var iv = U.stateOf(stage, props.intervalEntity), mins = iv && isFinite(Number(iv.state)) ? Number(iv.state) : props.interval || 90;
      return { last: last, mins: mins, due: last + mins * 60000 };
    }
    // input_datetime states are house-local without an offset.
    function offsetSuffix() {
      var o = stage.tzOffsetMin, sign = o < 0 ? '-' : '+', a = Math.abs(o);
      return sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
    }
    function ring(parent, frac, color) {
      var ns = 'http://www.w3.org/2000/svg', C = 207;
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 72 72');
      svg.setAttribute('class', 'hh-ring');
      var bg = document.createElementNS(ns, 'circle'), fg = document.createElementNS(ns, 'circle');
      var attrs = { cx: 36, cy: 36, r: 33, fill: 'none', 'stroke-width': 5 };
      for (var k in attrs) { bg.setAttribute(k, attrs[k]); fg.setAttribute(k, attrs[k]); }
      bg.setAttribute('stroke', 'rgba(255,255,255,0.12)');
      fg.setAttribute('stroke', color);
      fg.setAttribute('stroke-linecap', 'round');
      fg.setAttribute('stroke-dasharray', C);
      fg.setAttribute('stroke-dashoffset', C * (1 - frac));
      fg.setAttribute('transform', 'rotate(-90 36 36)');
      svg.appendChild(bg); svg.appendChild(fg);
      parent.appendChild(svg);
    }
    function render() {
      clear(root);
      var x = info(), ic = el('div', 'hh-ic', root);
      text(ic, 'hh-ic-glyph', props.icon || '⏱');
      var mid = el('div', 'hh-tile-mid', root);
      if (!x) { text(mid, 'hh-k', props.label || 'Time since'); text(mid, 'hh-v', props.entity ? 'No record yet' : stage.editing ? 'Choose a date/time helper' : ''); setClass(box, 'hh-box-alert', false); return; }
      var el2 = (stage.now() - x.last) / 60000, frac = Math.min(1, el2 / x.mins), over = el2 >= x.mins;
      ring(ic, frac, over ? '#ffd166' : frac > 0.8 ? '#ffb257' : '#7fe0a1');
      setClass(box, 'hh-box-alert', over);
      text(mid, 'hh-k', over ? props.dueLabel || props.label : props.label);
      var since = ago(stage, new Date(x.last).toISOString());
      text(mid, 'hh-v', over ? 'Due since ' + t12(stage, x.due) : (since === 'just now' ? 'Just now' : since + ' ago') + ' · due ' + t12(stage, x.due));
    }
    tap(root, stage, function () {
      var x = info();
      var body = stage.openSheet((props.icon ? props.icon + ' ' : '') + (props.label || ''));
      var since = x && ago(stage, new Date(x.last).toISOString());
      text(body, 'hh-p', x ? 'Last time ' + t12(stage, x.last) + ' (' + (since === 'just now' ? 'just now' : since + ' ago') + '). Reminder every ' + x.mins + ' minutes.' : 'No record yet.');
      var row2 = el('div', 'hh-btns', body);
      btn(row2, 'Close', '', stage.closeSheet);
      if (props.script) btn(row2, props.buttonLabel || 'Now', 'hh-pri', function () { stage.closeSheet(); stage.act(id, 'run', {}, 'Got it.'); });
    });
    return {
      update: function (pr) { props = pr; size(box, props, stage); render(); },
      states: render,
      tick: function () { var m = parts(stage, stage.now()).mi; if (m !== lastMinute) { lastMinute = m; render(); } }
    };
  }

  // ---------- button ----------
  var VACUUM = { docked: 'Docked', cleaning: 'Cleaning…', returning: 'Heading home', paused: 'Paused', idle: 'Idle', error: 'Needs help' };
  function buttonWidget(box, stage, id) {
    var root = el('div', 'hh-tile', box), props = {}, ringTimer = null;
    var NS = 'http://www.w3.org/2000/svg';
    // Pills: "go to a view" (with an idle countdown ring) and Grandkids mode.
    function pill() {
      clear(root);
      var kidsOn = props.action === 'kids' && stage.kids;
      var light = props.look === 'pill-light' && !kidsOn;
      root.className = 'hh-pillbox ' + (light ? 'hh-pill-light' : 'hh-pill-dark');
      if (props.ring) {
        var svg = document.createElementNS(NS, 'svg'), bg = document.createElementNS(NS, 'circle'), fg = document.createElementNS(NS, 'circle'), ph = document.createElementNS(NS, 'path');
        svg.setAttribute('viewBox', '0 0 40 40'); svg.setAttribute('class', 'hh-pillring');
        var at = { cx: 20, cy: 20, r: 16, fill: 'none', 'stroke-width': 4 };
        for (var k in at) { bg.setAttribute(k, at[k]); fg.setAttribute(k, at[k]); }
        bg.setAttribute('stroke', '#4a525c');
        fg.setAttribute('stroke', '#fff59a'); fg.setAttribute('stroke-linecap', 'round'); fg.setAttribute('transform', 'rotate(-90 20 20)');
        fg.setAttribute('stroke-dasharray', '100.5'); fg.setAttribute('stroke-dashoffset', '0');
        ph.setAttribute('d', 'M13 26l5-6 4 4 3-3 3 5z'); ph.setAttribute('fill', '#fff');
        svg.appendChild(bg); svg.appendChild(fg); svg.appendChild(ph);
        root.appendChild(svg);
        var tickRing = function () { var left = stage.idleLeft(); fg.setAttribute('stroke-dashoffset', String(100.5 * (1 - (left < 0 ? 1 : left)))); };
        tickRing();
        if (!ringTimer && !stage.editing) ringTimer = setInterval(tickRing, 250);
      }
      root.appendChild(document.createTextNode(kidsOn ? props.labelOn || props.label : (props.icon && props.action !== 'view' ? props.icon + ' ' : '') + (props.label || '')));
    }
    function say(msg) { if (U.wbToast) U.wbToast(stage).show(msg); else stage.toast(msg); }
    function pillTap() {
      if (props.action === 'view') return stage.goView(props.view);
      if (!stage.kids) {
        stage.api('POST', 'api/kids', { on: true }, function (err, d) {
          if (err) return say('Couldn\'t switch: ' + (d.error || err.message));
          stage.setKids(true);
          say('Grandkids mode on. The calendar is look-only.');
        });
        return;
      }
      if (!stage.pinLength) return say('Set a PIN for this screen in Studio first');
      U.pinPad(stage, stage.pinLength, function (pin, cb) {
        stage.api('POST', 'api/kids', { on: false, pin: pin }, function (err, d) {
          if (!err) { stage.setKids(false); say('Grandkids mode off.'); }
          cb(err, err ? (d.error === 'Too many tries. Wait a minute.' ? 429 : 403) : 200, d.error);
        });
      }, props.pinOwner);
    }
    function status() {
      var s = U.stateOf(stage, props.entity);
      if (!s) return props.entity ? 'Unavailable' : stage.editing ? 'Choose what it controls' : '';
      var a = s.attributes || {};
      if (props.action === 'vacuum') return (a.error_text && s.state === 'error' ? a.error_text : VACUUM[s.state] || s.state) + (a.battery_level !== undefined ? ' · ' + a.battery_level + '%' : '');
      if (props.action === 'toggle') return s.state === 'on' ? 'On' : 'Off';
      return s.state === 'on' ? 'Running…' : 'Ready';
    }
    function render() {
      if (props.look === 'pill' || props.look === 'pill-light' || props.action === 'view' || props.action === 'kids') return pill();
      root.className = 'hh-tile';
      clear(root);
      var s = U.stateOf(stage, props.entity);
      setClass(box, 'hh-box-bad', !!(s && s.state === 'error'));
      text(root, 'hh-ic', props.icon || '🔘');
      var mid = el('div', 'hh-tile-mid', root);
      text(mid, 'hh-k', nameOf(stage, props.entity, props.label));
      text(mid, 'hh-v', status());
    }
    function run(what, ok) { stage.closeSheet(); stage.act(id, 'press', { what: what }, ok); }
    tap(root, stage, function () {
      if (props.action === 'view' || props.action === 'kids') return pillTap();
      var label = nameOf(stage, props.entity, props.label), s = U.stateOf(stage, props.entity);
      if (props.action === 'vacuum') {
        var body = stage.openSheet((props.icon ? props.icon + ' ' : '') + label);
        text(body, 'hh-p', status());
        var row2 = el('div', 'hh-btns', body);
        btn(row2, 'Close', '', stage.closeSheet);
        if (s && s.state === 'docked') btn(row2, 'Start cleaning', 'hh-pri', function () { run('start', label + ' is off to clean!'); });
        else btn(row2, 'Send ' + label + ' home', 'hh-pri', function () { run('dock', label + ' is heading home.'); });
        return;
      }
      if (!props.confirm) return run('press', label + ': done');
      var b2 = stage.openSheet((props.icon ? props.icon + ' ' : '') + label);
      text(b2, 'hh-p', status());
      var r2 = el('div', 'hh-btns', b2);
      btn(r2, 'Cancel', '', stage.closeSheet);
      btn(r2, props.action === 'toggle' ? (s && s.state === 'on' ? 'Turn off' : 'Turn on') : 'Go', 'hh-pri', function () { run('press', label + ': done'); });
    });
    return {
      update: function (pr) { props = pr; size(box, props, stage); render(); },
      states: render, kids: render,
      destroy: function () { if (ringTimer) clearInterval(ringTimer); }
    };
  }

  // ---------- sky ----------
  var PAL = { // top, upper, lower, bottom, sun glow
    night: ['#0b1230', '#1b2650', '#3a3570', '#141826', '#ffd9a0'], dawn: ['#2a3a78', '#7a6aa8', '#f2a37c', '#2a2537', '#ffcf9a'],
    morning: ['#4f7fd0', '#9db8e6', '#f1d2b0', '#26304a', '#fff1c9'], day: ['#2f6fd1', '#5f9ae6', '#9fc4ef', '#1e2a44', '#fff6d6'],
    golden: ['#3a4f9a', '#c27a6a', '#f6a35e', '#2a2433', '#ffb46a'], dusk: ['#232463', '#6d3f7a', '#d9705a', '#1d1a2a', '#ff9a6a']
  };
  var COND = { 'clear-night': 'Clear night', sunny: 'Sunny', partlycloudy: 'Partly cloudy', cloudy: 'Cloudy', rainy: 'Rain', pouring: 'Heavy rain',
    'lightning-rainy': 'Storms', lightning: 'Lightning', windy: 'Windy', 'windy-variant': 'Windy', fog: 'Fog', hail: 'Hail', snowy: 'Snow', 'snowy-rainy': 'Sleet', exceptional: 'Unusual weather' };
  function rgb(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
  function mixC(a, b, t) { var x = rgb(a), y = rgb(b), o = []; for (var i = 0; i < 3; i++) o.push(Math.round(x[i] + (y[i] - x[i]) * t)); return 'rgb(' + o.join(',') + ')'; }
  function skyAt(now, rise, set) {
    var r = (now - rise) / 60000, s = (now - set) / 60000;
    var keys = [[-80, 'r', 'night'], [-15, 'r', 'dawn'], [70, 'r', 'morning'], [200, 'r', 'day'], [-110, 's', 'day'], [-25, 's', 'golden'], [20, 's', 'dusk'], [80, 's', 'night']];
    var pos = [], i;
    for (i = 0; i < keys.length; i++) pos.push({ t: keys[i][1] === 'r' ? keys[i][0] - r : keys[i][0] - s, p: keys[i][2] });
    var a = pos[0], b = pos[0];
    if (pos[0].t > 0) { a = b = pos[0]; }
    else if (pos[pos.length - 1].t <= 0) { a = b = pos[pos.length - 1]; }
    else for (i = 0; i < pos.length - 1; i++) if (pos[i].t <= 0 && pos[i + 1].t > 0) { a = pos[i]; b = pos[i + 1]; break; }
    var f = a === b ? 0 : -a.t / (b.t - a.t), cols = [];
    for (i = 0; i < 5; i++) cols.push(mixC(PAL[a.p][i], PAL[b.p][i], f));
    return { cols: cols, night: (a.p === 'night' ? 1 - f : 0) + (b.p === 'night' ? f : 0) };
  }
  function moon(now) {
    var syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
    var age = (((now - ref) / 864e5) % syn + syn) % syn, frac = age / syn;
    var names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return { frac: frac, name: names[Math.round(frac * 8) % 8] };
  }
  function heat(t) { var a = Math.max(0, Math.min(1, (t - 65) / 45)); return a < 0.5 ? mixC('#7cc4ff', '#ffd266', a * 2) : mixC('#ffd266', '#ff6a3d', (a - 0.5) * 2); }

  // The house board's hero: a sky that follows the sun, painted behind the
  // whole screen (props.backdrop) or just this box. Layout inside the box is
  // the board's (1080x640): weather top right, sun arc, ribbon, one line.
  function skyWidget(box, stage) {
    box.className += ' hh-sky';
    var bd = el('div', 'hh-backdrop'), stars = el('div', 'hh-stars', bd), glow = el('div', 'hh-glow', bd);
    var arc = el('div', 'hh-arc', box), wx = el('div', 'hh-wx', box), ribbon = el('div', 'hh-ribbon', box), tip = el('div', 'hh-tip', box);
    var props = {}, lastMinute = -1, seed = 7, painted = null;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    // Star and glow sizes are board pixels, in em of the backdrop (1em = 1/1080 of its width).
    for (var i = 0; i < 170; i++) {
      var st = el('div', 'hh-star', stars), r = rnd() * 1.8;
      st.style.left = rnd() * 1080 + 'em'; st.style.top = rnd() * 720 + 'em';
      st.style.opacity = rnd() * 0.7 + 0.1;
      st.style.width = st.style.height = Math.max(0.6, r * 2) + 'em';
    }
    function host() { return props.backdrop ? stage.el : box; }
    function place() {
      var h = host();
      if (bd.parentNode !== h) {
        unpaint();
        h.insertBefore(bd, h.firstChild);
        painted = h;
      }
      bd.style.fontSize = (h.clientWidth || stage.width) / 1080 + 'px';
    }
    function unpaint() {
      if (painted) { painted.style.backgroundImage = ''; if (bd.parentNode) bd.parentNode.removeChild(bd); }
      painted = null;
    }
    function sunTimes(now) {
      var s = U.stateOf(stage, props.sun), day = 864e5;
      if (!s || !s.attributes || !s.attributes.next_rising) {
        var p = parts(stage, now), base = now - ((p.h * 60 + p.mi) * 60000);
        return { rise: base + 380 * 60000, set: base + 1100 * 60000 };
      }
      var nr = Date.parse(s.attributes.next_rising), ns = Date.parse(s.attributes.next_setting);
      if (s.state === 'above_horizon') return { rise: nr - day, set: ns };
      if (keyOf(parts(stage, nr)) === keyOf(parts(stage, now))) return { rise: nr, set: ns };
      return { rise: nr - day, set: ns - day };
    }
    function label(x, y, anchor, value) {
      return '<text x="' + x + '" y="' + y + '"' + (anchor ? ' text-anchor="' + anchor + '"' : '') + ' fill="rgba(255,255,255,.62)" font-weight="700" font-size="22">' + value + '</text>';
    }
    function render() {
      place();
      var now = stage.now(), t = sunTimes(now), sky = skyAt(now, t.rise, t.set), c = sky.cols;
      host().style.backgroundImage = 'linear-gradient(to bottom, ' + c[0] + ' 0%, ' + c[1] + ' 34%, ' + c[2] + ' 62%, ' + c[3] + ' 100%)';
      stars.style.opacity = sky.night;
      var W = 960, base = 150, amp = 112, p = (now - t.rise) / (t.set - t.rise), up = p >= 0 && p <= 1, pts = [], done = [];
      for (var i = 0; i <= 60; i++) { var x = i / 60; pts.push((x * W).toFixed(1) + ',' + (base - Math.sin(x * Math.PI) * amp).toFixed(1)); if (up && i <= Math.floor(p * 60)) done.push(pts[i]); }
      var cp = Math.max(0, Math.min(1, p)), sx = cp * W, sy = base - Math.sin(cp * Math.PI) * amp, body = '';
      if (up) body = '<circle cx="' + sx + '" cy="' + sy + '" r="44" fill="' + c[4] + '" opacity=".25"/><circle cx="' + sx + '" cy="' + sy + '" r="26" fill="' + c[4] + '"/>';
      else {
        var mo = moon(now), k = Math.cos(mo.frac * 2 * Math.PI), waxing = mo.frac < 0.5, rx = Math.abs(k) * 30;
        var lit = 'M0,-30 A30,30 0 0 ' + (waxing ? 1 : 0) + ' 0,30 A' + rx + ',30 0 0 ' + ((k > 0) === waxing ? 0 : 1) + ' 0,-30';
        body = '<g transform="translate(700,52)"><circle r="30" fill="rgba(244,236,216,.16)"/><path d="' + lit + '" fill="#f4ecd8"/></g>' + label(745, 62, '', mo.name);
      }
      arc.innerHTML = '<svg viewBox="0 0 960 170">' +
        '<line x1="0" y1="' + base + '" x2="' + W + '" y2="' + base + '" stroke="rgba(255,255,255,.18)" stroke-width="2"/>' +
        '<polyline points="' + pts.join(' ') + '" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="3" stroke-dasharray="2 10" stroke-linecap="round"/>' +
        (done.length > 1 ? '<polyline points="' + done.join(' ') + '" fill="none" stroke="' + c[4] + '" stroke-width="4" stroke-linecap="round"/>' : '') +
        label(0, base - 14, '', '↑ ' + t12(stage, t.rise).replace(' AM', '')) + label(W, base - 14, 'end', t12(stage, t.set).replace(' PM', '') + ' ↓') + body + '</svg>';
      // The glow: a 900px blurred disc on the sun (board pixels, see place()).
      var h = host(), em = (h.clientWidth || stage.width) / 1080;
      var k2 = Math.min(arc.offsetWidth / W, arc.offsetHeight / 170) || 0;
      var ox = (arc.offsetWidth - W * k2) / 2, oy = (arc.offsetHeight - 170 * k2) / 2;
      var bx = props.backdrop ? box.offsetLeft : 0, by = props.backdrop ? box.offsetTop : 0;
      var gx = up ? (bx + arc.offsetLeft + ox + sx * k2) / em : 760, gy = up ? (by + arc.offsetTop + oy + sy * k2) / em : 370;
      glow.style.width = glow.style.height = '900em';
      glow.style.left = (gx - 450) + 'em'; glow.style.top = (gy - 450) + 'em';
      glow.style.opacity = up ? 0.55 : 0.16;
      glow.style.background = 'radial-gradient(circle, ' + c[4] + ' 0%, rgba(255,180,90,0.25) 40%, rgba(255,180,90,0) 70%)';
      glow.style.webkitFilter = glow.style.filter = 'blur(60em)';
      weather();
    }
    function weather() {
      clear(wx); clear(ribbon); tip.innerHTML = '';
      var w = U.stateOf(stage, props.entity), fc = stage.data['fc:' + props.entity];
      if (props.showWeather && w) {
        var a = w.attributes || {};
        text(wx, 'hh-wx-t cv-acc', a.temperature !== undefined ? Math.round(a.temperature) + '°' : '—');
        text(wx, 'hh-wx-c', COND[w.state] || w.state);
        var d0 = fc && fc.daily && fc.daily[0];
        if (d0 && d0.temp !== undefined) text(wx, 'hh-wx-hl', 'H ' + Math.round(d0.temp) + '° · L ' + Math.round(d0.low) + '°');
      } else if (props.showWeather && stage.editing && !props.entity) text(wx, 'hh-wx-c', 'Choose a weather entity');
      var hrs = fc && fc.hourly ? fc.hourly.slice(0, 12) : [];
      if (props.showRibbon) for (var i = 0; i < hrs.length; i++) {
        var p = parts(stage, Date.parse(hrs[i].t)), cell = el('div', 'hh-hr' + (i === 0 ? ' hh-hr-now' : ''), ribbon);
        text(cell, 'hh-hr-l', i === 0 ? 'Now' : (p.h % 12 || 12) + (p.h < 12 ? 'a' : 'p'));
        if (hrs[i].rain >= 40) text(cell, 'hh-rain', '💧');
        var v = text(cell, 'hh-hr-v', Math.round(hrs[i].temp));
        v.style.backgroundColor = heat(hrs[i].temp);
      }
      if (props.showTip && hrs.length) tip.innerHTML = tipFor(hrs);
    }
    function tipFor(hrs) {
      function fmt(h) { return t12(stage, Date.parse(h.t)).replace(':00', ''); }
      var rain = null, max = hrs[0], min = hrs[0], i;
      for (i = 0; i < hrs.length; i++) { if (!rain && hrs[i].rain >= 40) rain = hrs[i]; if (hrs[i].temp > max.temp) max = hrs[i]; if (hrs[i].temp < min.temp) min = hrs[i]; }
      if (rain) return 'Rain likely around <b>' + fmt(rain) + '</b> (' + rain.rain + '%) ☔';
      var now = hrs[0].temp;
      if (max.temp >= 105) return 'Dangerous heat: <b>' + Math.round(max.temp) + '°</b> around ' + fmt(max) + ' — water for the dogs';
      if (now > 85) for (i = 0; i < hrs.length; i++) if (hrs[i].temp <= 85) return 'Patio weather by <b>' + fmt(hrs[i]) + '</b> (' + Math.round(hrs[i].temp) + '°) · coolest ' + fmt(min) + ', ' + Math.round(min.temp) + '°';
      if (max.temp - now >= 8) return 'Warming to <b>' + Math.round(max.temp) + '°</b> by ' + fmt(max);
      return 'Coolest around <b>' + fmt(min) + '</b>, ' + Math.round(min.temp) + '°';
    }
    return {
      update: function (pr) { props = pr; box.style.fontSize = (props.size || 1.04) * stage.height / 100 + 'px'; render(); },
      states: render, data: weather, destroy: unpaint,
      tick: function () { var m = parts(stage, stage.now()).mi; if (m !== lastMinute) { lastMinute = m; render(); } }
    };
  }

  // ---------- who came by ----------
  var LABEL = { person: '🚶 Person', car: '🚗 Car', dog: '🐕 Dog', cat: '🐈 Cat', package: '📦 Package', bicycle: '🚲 Bike', motorcycle: '🏍 Motorcycle' };
  function camerasWidget(box, stage) {
    var wrap = el('div', 'hh-cams', box), props = {}, root = null;
    function events() {
      var d = stage.data.cams, out = [], names = {}, i;
      for (i = 0; i < (props.cameras || []).length; i++) names[props.cameras[i].camera] = props.cameras[i].name || props.cameras[i].camera;
      if (!d) return { list: out, ok: true, names: names };
      for (i = 0; i < d.events.length; i++) if (names[d.events[i].camera]) out.push(d.events[i]);
      return { list: out, ok: d.ok !== false, names: names };
    }
    function render() {
      clear(wrap);
      if (props.title) heading(wrap, props.title, props.note);
      root = el('div', 'hh-film', wrap);
      var ev = events(), list = ev.list.slice(0, props.count || 5);
      if (!(props.cameras || []).length) { text(root, 'hh-empty', stage.editing ? 'Add cameras in the panel on the right' : ''); return; }
      if (!list.length) { text(root, 'hh-empty cv-acc', ev.ok ? 'Nobody came by today. Quiet.' : 'Cameras unavailable right now'); return; }
      for (var i = 0; i < list.length; i++) (function (c) {
        var shot = el('div', 'hh-shot' + (c.alert ? ' hh-alert' : ''), root);
        shot.style.backgroundImage = 'url("' + stage.frigateUrl(c.id, 'snap') + '")';
        if (c.box) shot.style.backgroundPosition = Math.round((c.box[0] + c.box[2] / 2) * 100) + '% ' + Math.round((c.box[1] + c.box[3] / 2) * 100) + '%';
        text(shot, 'hh-tag', c.subLabel || LABEL[c.label] || c.label);
        if (c.count > 1) text(shot, 'hh-stack', '×' + c.count);
        var lb = text(shot, 'hh-lb', ev.names[c.camera] + ' ');
        el('span', '', lb).textContent = '· ' + t12(stage, c.time * 1000);
        tap(shot, stage, function () { open(c, ev.names[c.camera]); });
      })(list[i]);
    }
    function open(c, name) {
      var body = stage.openSheet(name);
      var what = c.count > 1 ? c.count + ' ' + c.label + ' events since ' + t12(stage, c.oldest * 1000) + ' — showing the latest' : (c.subLabel || (LABEL[c.label] || c.label).replace(/^\S+ /, ''));
      text(body, 'hh-p', what + ' · ' + t12(stage, c.time * 1000));
      var media = el('div', 'hh-media', body);
      var img = el('img', '', media);
      img.src = stage.frigateUrl(c.id, 'snap');
      var row2 = el('div', 'hh-btns', body);
      btn(row2, 'Close', '', stage.closeSheet);
      if (c.hasClip) btn(row2, '▶ Play the clip', 'hh-pri', function () {
        clear(media);
        var v = el('video', '', media);
        v.setAttribute('controls', '');
        v.setAttribute('autoplay', '');
        v.setAttribute('playsinline', '');
        v.src = stage.frigateUrl(c.id, 'clip');
      });
    }
    return { update: function (pr) { props = pr; size(box, props, stage); render(); }, data: render };
  }


  // ---------- card: a see-through panel with a heading, for grouping ----------
  // look "whiteboard": a metal frame and board (sizes: the original whiteboard app's px / 16).
  var GHOSTS = [['Dentist 2pm', 7.5, 15.6, 3.75, -6], ['milk · eggs · bread', 28.75, 33.75, 3, 4], ['CALL BACK!', 15, 26.9, 4.375, -2]];
  function panelWidget(box, stage) {
    var root = el('div', 'hh-panel', box), props = {};
    function render() {
      clear(root);
      var wb = props.look === 'whiteboard';
      setClass(box, 'hh-wbframe', wb);
      setClass(box, 'hh-kids', wb && stage.kids);
      if (wb) {
        box.style.fontSize = (props.size || 2.08) * stage.height / 100 + 'px';
        var surf = el('div', 'hh-wbsurface', root);
        for (var i = 0; i < GHOSTS.length; i++) {
          var g = text(surf, 'hh-ghost', GHOSTS[i][0]);
          // left/top in the ghost's own em, which is fontSize times the board's.
          g.style.fontSize = GHOSTS[i][3] + 'em';
          g.style.left = GHOSTS[i][1] / GHOSTS[i][3] + 'em'; g.style.top = GHOSTS[i][2] / GHOSTS[i][3] + 'em';
          g.style.webkitTransform = g.style.transform = 'rotate(' + GHOSTS[i][4] + 'deg)';
        }
        el('div', 'hh-kidsbar', surf);
        return;
      }
      if (props.title || props.note) heading(root, props.title, props.note);
    }
    return { update: function (pr) { props = pr; size(box, props, stage); render(); }, kids: render };
  }

  // ---------- status tile: quiet until something is busy (the laundry) ----------
  function statusWidget(box, stage) {
    var root = el('div', 'hh-tile', box), props = {};
    function fresh(s) { return s && (!s.last_changed || stage.now() - Date.parse(s.last_changed) < (props.staleHours || 12) * 3600e3); }
    function render() {
      clear(root);
      text(root, 'hh-ic', props.icon || '🫧');
      var mid = el('div', 'hh-tile-mid', root), keys = [], vals = [], items = props.items || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i], a = U.stateOf(stage, it.entity), st = U.stateOf(stage, it.status);
        var name = it.name || nameOf(stage, it.entity);
        if (a && (a.state === 'on' || a.state === 'running') && fresh(a)) { keys.push(name + ' running'); continue; }
        if (st && fresh(st) && st.state && st.state !== 'unknown' && st.state !== 'unavailable') {
          keys.push(name + ' done');
          // "Washer finished at 10:35 AM" -> "Finished at 10:35 AM"
          var v = st.state.replace(new RegExp('^' + name.replace(/[^\w ]/g, '') + '\\s+', 'i'), '');
          vals.push(v.charAt(0).toUpperCase() + v.slice(1));
        }
      }
      text(mid, 'hh-k', keys.length ? keys.join(' · ') : props.title || '');
      text(mid, 'hh-v', keys.length ? vals.join(' · ') || 'In progress' : !items.length && stage.editing ? 'Add things in the panel on the right' : props.idleText || '');
    }
    return { update: function (pr) { props = pr; size(box, props, stage); render(); }, states: render, tick: render };
  }

  // ---------- status icons: doors, locks, garage, a temperature ----------
  // A "matrix" item is a button: its sheet puts text or a light show on the
  // Matrix until nobody has tapped for the widget's playMinutes (server side).
  var PLAY_COLORS = [['#ffffff', 'White'], ['#ff2a2a', 'Red'], ['#ff8a00', 'Orange'], ['#ffe100', 'Yellow'], ['#2aff4a', 'Green'],
    ['#00d8ff', 'Aqua'], ['#3a6bff', 'Blue'], ['#b44bff', 'Purple'], ['#ff4fc3', 'Pink']];
  var PLAY_PALETTES = [['party', 'Party', '#ff4fc3'], ['neon', 'Neon', '#00d8ff'], ['ocean', 'Ocean', '#3a6bff'], ['sunset', 'Sunset', '#ff8a00'], ['forest', 'Forest', '#2aff4a']];
  var PLAY_EFFECTS = [['rainbow_waves', '🌈 Rainbow'], ['fireworks', '🎆 Fireworks'], ['confetti', '🎉 Confetti'], ['fire', '🔥 Fire'],
    ['lava', '🌋 Lava lamp'], ['starfield', '✨ Stars'], ['twinkle', '⭐ Twinkle'], ['aurora', '🌌 Aurora'], ['plasma', '🔮 Plasma'],
    ['color_vortex', '🌀 Vortex'], ['digital_rain', '💚 Code rain'], ['ripples', '💧 Ripples'], ['life', '🦠 Life'], ['pong', '🏓 Pong clock']];
  var PLAY_STYLES = [['sign', 'Sign'], ['bounce', 'Bounce'], ['scanner', 'Scanner']];
  var PLAY_BRIGHT = [['dim', 'Dim'], ['normal', 'Normal'], ['bright', 'Bright']];

  function iconsWidget(box, stage, id) {
    var root = el('div', 'hh-icons', box), props = {};
    // Choices survive closing the sheet; `until` is when the Matrix goes back to normal.
    var ui = { line1: '', line2: '', style: 'sign', color: '#ffffff', palette: 'party', effect: '', brightness: 'normal', last: null, until: 0 };
    function minutes() { return Number(props.playMinutes) || 10; }
    function playing() { return ui.until > stage.now(); }
    function matrixSheet(it) {
      var body = stage.openSheet('🌈 ' + (it.name || 'Matrix'));
      var status = text(body, 'hh-p', '');
      function showStatus() {
        status.textContent = playing() ? 'Showing now. Back to normal at ' + t12(stage, ui.until) + ' unless someone taps again.'
          : 'Put something on the Matrix. It goes back to normal ' + minutes() + ' minutes after the last tap.';
      }
      function send(what, ok) {
        var args = what === 'stop' ? { what: 'stop' } : { what: 'show', play: what };
        stage.act(id, 'matrix', args, ok, function (err) {
          if (err) return;
          if (what === 'stop') { ui.until = 0; ui.last = null; ui.effect = ''; } else { ui.last = what; ui.until = stage.now() + minutes() * 60000; }
          marks(); showStatus(); render();
        });
      }
      function textPlay() { return { style: ui.style, line1: ui.line1, line2: ui.line2, color: ui.color, palette: ui.palette, brightness: ui.brightness }; }
      function effectPlay() { return { style: 'effect', effect: ui.effect, palette: ui.palette, brightness: ui.brightness }; }
      // Tweaking a colour or the brightness updates whatever is showing.
      function resend() {
        if (!ui.last || !playing()) return;
        send(ui.last.style === 'effect' ? effectPlay() : textPlay());
      }
      var chips = [];
      function chipRow(parent, list, key, onPick, dots) {
        var row = el('div', 'hh-chips', parent);
        for (var i = 0; i < list.length; i++) (function (o) {
          var c = el('button', 'hh-chipbtn', row);
          if (dots !== undefined) { var d = el('span', 'hh-dot', c); d.style.backgroundColor = o[dots]; }
          c.appendChild(document.createTextNode(o[1]));
          c.onclick = function (e) { e.stopPropagation(); ui[key] = o[0]; marks(); onPick(); };
          chips.push({ node: c, key: key, value: o[0] });
        })(list[i]);
        return row;
      }
      function marks() {
        for (var i = 0; i < chips.length; i++) setClass(chips[i].node, 'hh-on', ui[chips[i].key] === chips[i].value);
        line2.style.display = colors.style.display = ui.style === 'sign' ? '' : 'none';
        palText.style.display = ui.style === 'sign' ? 'none' : '';
        input1.setAttribute('maxlength', ui.style === 'sign' ? '60' : '12');
        input1.setAttribute('placeholder', ui.style === 'sign' ? 'Top line' : 'One short word');
      }
      function field(parent, value, key, placeholder) {
        var row = el('div', 'hh-inp', parent), input = el('input', 'cv-acc', row);
        input.setAttribute('placeholder', placeholder);
        input.value = value;
        input.onkeyup = input.onchange = function () { ui[key] = input.value; };
        input.onkeydown = function (e) { if (e.keyCode === 13) { e.preventDefault(); input.blur(); go(); } };
        return { row: row, input: input };
      }
      function go() {
        if (!/\S/.test(ui.line1 + ui.line2)) return stage.toast('Type something first');
        send(textPlay(), 'On the Matrix!');
      }

      text(body, 'hh-lab', 'Write something');
      var f1 = field(body, ui.line1, 'line1', 'Top line'), input1 = f1.input;
      var line2 = field(body, ui.line2, 'line2', 'Bottom line (optional)').row;
      chipRow(body, PLAY_STYLES, 'style', function () {});
      var colors = chipRow(body, PLAY_COLORS, 'color', function () { if (ui.last && ui.last.style === 'sign') resend(); }, 0);
      var palText = chipRow(body, PLAY_PALETTES, 'palette', resend, 2);
      var r1 = el('div', 'hh-btns', body);
      btn(r1, 'Show it', 'hh-pri', go);

      text(body, 'hh-lab', 'Or a light show');
      chipRow(body, PLAY_EFFECTS, 'effect', function () { send(effectPlay()); });
      text(body, 'hh-lab', 'Colours');
      chipRow(body, PLAY_PALETTES, 'palette', resend, 2);

      text(body, 'hh-lab', 'Brightness');
      chipRow(body, PLAY_BRIGHT, 'brightness', resend);

      var r2 = el('div', 'hh-btns', body);
      btn(r2, 'Close', '', stage.closeSheet);
      btn(r2, 'Back to normal now', '', function () { send('stop', 'The Matrix is back to normal.'); });
      marks(); showStatus();
    }
    function render() {
      clear(root);
      var items = props.items || [];
      if (!items.length) { text(root, 'hh-empty', stage.editing ? 'Add icons in the panel on the right' : ''); return; }
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'matrix') { matrixIcon(items[i]); continue; }
        var it = items[i], s = U.stateOf(stage, it.entity), name = it.name || nameOf(stage, it.entity);
        var state = s ? s.state : 'unknown', unknown = state === 'unknown' || state === 'unavailable' || state === '';
        var cls = '', icon = '—', label = name;
        if (it.kind === 'temp') {
          var a = (s && s.attributes) || {}, n = Number(a.current_temperature !== undefined ? a.current_temperature : state);
          icon = s && isFinite(n) && state !== '' ? Math.round(n) + '°' : '—';
          cls = ' hh-lk-temp';
        } else if (!unknown) {
          var lock = it.kind === 'lock', secure = lock ? state === 'locked' : state === 'off' || state === 'closed';
          icon = lock ? (secure ? '🔒' : '🔓') : it.kind === 'garage' ? (secure ? '🚗' : '⚠️') : (secure ? '🚪' : '⚠️');
          cls = secure ? ' hh-lk-ok' : ' hh-lk-warn';
          if (!secure && !lock) label = name + ' open';
        }
        var lk = el('div', 'hh-lk' + cls, root);
        text(lk, 'hh-lk-ic', icon);
        text(lk, 'hh-lk-n', label);
      }
    }
    function matrixIcon(it) {
      var lk = el('div', 'hh-lk hh-lk-tap' + (playing() ? ' hh-lk-ok' : ''), root);
      text(lk, 'hh-lk-ic', '🌈');
      text(lk, 'hh-lk-n', playing() ? 'Playing' : it.name || 'Matrix');
      tap(lk, stage, function () { matrixSheet(it); });
    }
    var wasPlaying = false;
    function tick() { if (playing() !== wasPlaying) { wasPlaying = playing(); render(); } }
    return { update: function (pr) { props = pr; size(box, props, stage); render(); }, states: render, tick: tick };
  }

  CVRender.register('calendar', calendarWidget);
  CVRender.register('people', peopleWidget);
  CVRender.register('todo', todoWidget);
  CVRender.register('chores', choresWidget);
  CVRender.register('since', sinceWidget);
  CVRender.register('button', buttonWidget);
  CVRender.register('sky', skyWidget);
  CVRender.register('cameras', camerasWidget);
  CVRender.register('panel', panelWidget);
  CVRender.register('status', statusWidget);
  CVRender.register('icons', iconsWidget);
})();
