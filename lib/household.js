// Household data for the interactive widgets (calendar, to-do lists, chores,
// sky, "who came by") and the fixed list of actions screens may ask for.
// Ported from an earlier standalone house board app.
//
// Data is cached under keys a view asks for (viewNeeds(view).data):
//   cal:<calendar entity>   events from 5 weeks back to 4 months ahead
//                           (birthday calendars: a year ahead)
//   todo:<todo entity>      items (needs_action + completed)
//   fc:<weather entity>     { hourly, daily } forecasts
//   cams                    recent Frigate events, grouped (all watched cameras)
//   lab                     the lab at a glance from Prometheus (lib/lab.js)
// change(keys) fires after a refresh; server.js pushes the keys to screens.
const { EventEmitter } = require("node:events");
const { createFrigate } = require("./frigate-events");

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localIso = (d) => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function createHousehold({ hass, frigateUrl, lab = null, log = () => {}, fetchImpl = fetch, now = () => new Date() }) {
  const bus = new EventEmitter();
  const cache = {};                 // key -> data
  let want = { calendars: new Map(), todos: new Set(), forecasts: new Set(), cameras: {}, lab: false };
  let frigate = null, frigateCams = "";
  const timers = [];

  const ha = () => hass();
  const emit = (keys) => { if (keys.length) bus.emit("change", keys); };

  // ---------- refreshers ----------
  async function refreshCalendar(entity) {
    const h = ha();
    if (!h || !h.connected) return; // REST only once the WebSocket has proven the token
    const birthdays = want.calendars.get(entity);
    // From five weeks back (the whiteboard pages back) to four months ahead.
    const t = now(), s0 = startOfDay(addDays(t, -t.getDay() - 35));
    const end = addDays(startOfDay(t), birthdays ? 370 : 120);
    try {
      const events = [];
      for (const e of await h.calendar(entity, localIso(s0), localIso(end))) {
        const allDay = Boolean(e.start && e.start.date);
        const start = allDay ? new Date(e.start.date + "T00:00:00") : new Date(e.start.dateTime);
        const stop = allDay ? new Date(e.end.date + "T00:00:00") : new Date(e.end.dateTime);
        events.push({
          title: String(e.summary || "").trim().slice(0, 120), start: start.toISOString(), end: stop.toISOString(), allDay,
          day: dayKey(start), lastDay: dayKey(allDay ? addDays(stop, -1) : stop),
          uid: e.uid || null, rid: e.recurrence_id || null, rec: Boolean(e.rrule || e.recurrence_id)
        });
      }
      events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      cache["cal:" + entity] = { ok: true, events };
    } catch (err) {
      log("calendar", entity, err.message);
      cache["cal:" + entity] = { ok: false, events: (cache["cal:" + entity] || {}).events || [] };
    }
    emit(["cal:" + entity]);
  }
  async function refreshTodo(entity) {
    const h = ha();
    if (!h || !h.connected) return;
    try {
      const r = await h.callService("todo", "get_items", { entity_id: entity, status: ["needs_action", "completed"] }, true);
      const items = (((r && r[entity]) || {}).items || []).map((x) => ({ uid: x.uid, text: String(x.summary || "").slice(0, 120), done: x.status === "completed" }));
      cache["todo:" + entity] = { ok: true, items };
    } catch (err) {
      log("todo", entity, err.message);
      cache["todo:" + entity] = { ok: false, items: (cache["todo:" + entity] || {}).items || [] };
    }
    emit(["todo:" + entity]);
  }
  async function refreshForecast(entity) {
    const h = ha();
    if (!h || !h.connected) return;
    try {
      const [hr, dy] = await Promise.all([
        h.callService("weather", "get_forecasts", { entity_id: entity, type: "hourly" }, true),
        h.callService("weather", "get_forecasts", { entity_id: entity, type: "daily" }, true)
      ]);
      const slim = (f) => ({ t: f.datetime, temp: f.temperature, low: f.templow, cond: f.condition, rain: f.precipitation_probability });
      cache["fc:" + entity] = { ok: true, hourly: (((hr && hr[entity]) || {}).forecast || []).slice(0, 24).map(slim),
        daily: (((dy && dy[entity]) || {}).forecast || []).slice(0, 7).map(slim) };
    } catch (err) { log("forecast", entity, err.message); }
    emit(["fc:" + entity]);
  }
  async function refreshCams() {
    if (!frigate) return;
    try { cache.cams = { ok: true, events: (await frigate.recent()).slice(0, 12) }; }
    catch (err) { log("frigate events:", err.message); cache.cams = { ok: false, events: (cache.cams || {}).events || [] }; }
    emit(["cams"]);
  }
  // A failed refresh keeps the last good picture, marked stale.
  async function refreshLab() {
    if (!lab || !want.lab) return;
    const d = await lab.refresh();
    cache.lab = d.ok ? d : { ...(cache.lab && cache.lab.ok ? cache.lab : {}), ok: false, stale: true, error: d.error };
    emit(["lab"]);
  }
  const refreshAll = () => {
    for (const e of want.calendars.keys()) refreshCalendar(e);
    for (const e of want.todos) refreshTodo(e);
    for (const e of want.forecasts) refreshForecast(e);
    refreshCams();
    refreshLab();
  };

  // ---------- what the published views need ----------
  // needs: { calendars: [{entity, birthdays}], todos: [], forecasts: [], cameras: {name: label} }
  function sync(needs) {
    const prev = want;
    want = {
      calendars: new Map(needs.calendars.map((c) => [c.entity, Boolean(c.birthdays)])),
      todos: new Set(needs.todos), forecasts: new Set(needs.forecasts), cameras: needs.cameras || {}, lab: Boolean(needs.lab)
    };
    if (want.lab && !prev.lab) refreshLab();
    for (const [e, b] of want.calendars) if (!prev.calendars.has(e) || prev.calendars.get(e) !== b) refreshCalendar(e);
    for (const e of want.todos) if (!prev.todos.has(e)) refreshTodo(e);
    for (const e of want.forecasts) if (!prev.forecasts.has(e)) refreshForecast(e);
    const camKey = JSON.stringify(want.cameras);
    if (camKey !== frigateCams) {
      frigateCams = camKey;
      frigate = frigateUrl && Object.keys(want.cameras).length ? createFrigate({ url: frigateUrl, cameras: want.cameras, fetchImpl }) : null;
      if (!frigate) delete cache.cams;
      refreshCams();
    }
  }

  // HA state changes: a todo entity's state is its open count, so a change
  // means the list changed (from the app, a phone, an automation).
  function onStates(ids) {
    for (const id of ids) {
      if (want.todos.has(id)) refreshTodo(id);
      if (want.forecasts.has(id)) refreshForecast(id);
    }
  }

  // ---------- actions (validated by the caller against the widget) ----------
  async function calendarAdd(entity, { title, date, time, repeat, minutes }) {
    title = String(title || "").trim().slice(0, 80);
    date = String(date || ""); time = time ? String(time) : null;
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) throw bad("Title and day are required");
    const event = { summary: title };
    if (!time) { event.dtstart = date; event.dtend = dayKey(addDays(new Date(date + "T12:00:00"), 1)); }
    else {
      const start = new Date(`${date}T${time}:00`), mins = Math.min(Math.max(Number(minutes) || 60, 15), 12 * 60);
      event.dtstart = localIso(start); event.dtend = localIso(new Date(start.getTime() + mins * 60000));
    }
    const rule = { weekly: "FREQ=WEEKLY", yearly: "FREQ=YEARLY" }[repeat];
    if (rule) event.rrule = rule;
    await ha().command({ type: "calendar/event/create", entity_id: entity, event });
    await refreshCalendar(entity);
  }
  // Only events we listed; for a series, rid erases just that occurrence.
  async function calendarErase(entity, uid, rid) {
    const list = (cache["cal:" + entity] || {}).events || [];
    const e = list.find((x) => x.uid && x.uid === uid && (x.rid || null) === (rid || null));
    if (!e) throw bad("That event isn't on this calendar any more");
    const payload = { type: "calendar/event/delete", entity_id: entity, uid: e.uid };
    if (e.rid) payload.recurrence_id = e.rid;
    await ha().command(payload);
    await refreshCalendar(entity);
  }
  async function todoAdd(entity, text) {
    text = String(text || "").trim().slice(0, 80);
    if (!text) throw bad("Type something first");
    await ha().callService("todo", "add_item", { entity_id: entity, item: text });
    await refreshTodo(entity);
  }
  async function todoCheck(entity, uid, done) {
    const item = ((cache["todo:" + entity] || {}).items || []).find((x) => x.uid === uid);
    if (!item) throw bad("That item isn't on the list any more");
    await ha().callService("todo", "update_item", { entity_id: entity, item: item.uid, status: done ? "completed" : "needs_action" });
    await refreshTodo(entity);
  }
  const service = (domain, name, data) => ha().callService(domain, name, data);

  function snapshot(keys) {
    const out = {};
    for (const k of keys) out[k] = cache[k] === undefined ? null : cache[k];
    return out;
  }
  // A Frigate image/clip for an event we listed, on a camera the caller allows.
  async function cameraMedia(id, kind, range, allowedCameras) {
    const e = ((cache.cams || {}).events || []).find((x) => x.id === id);
    if (!e || !allowedCameras.has(e.camera) || !frigate) return null;
    return frigate.media(id, kind, range);
  }

  return {
    sync, onStates, snapshot, cameraMedia, refreshAll,
    calendarAdd, calendarErase, todoAdd, todoCheck, service,
    on: bus.on.bind(bus),
    start() {
      timers.push(setInterval(() => { for (const e of want.calendars.keys()) refreshCalendar(e); }, 3 * 60 * 1000),
        setInterval(() => { for (const e of want.todos) refreshTodo(e); }, 5 * 60 * 1000),
        setInterval(() => { for (const e of want.forecasts) refreshForecast(e); }, 15 * 60 * 1000),
        setInterval(refreshCams, 30 * 1000),
        setInterval(refreshLab, 30 * 1000));
      return this;
    },
    stop() { timers.splice(0).forEach(clearInterval); }
  };
}

module.exports = { createHousehold, dayKey };
