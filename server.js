// CoreView Studio: a WYSIWYG screen builder for the house displays.
//
// Two listeners in one process:
//   DISPLAY_PORT  the page every screen runs (pairing, live view, photos)
//   ADMIN_PORT    Studio itself (sign-in, screens, the view editor)
// Both are meant to sit behind a reverse proxy that terminates HTTPS. Live updates go out as
// Server-Sent Events, which every display browser down to Chrome 44 supports.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { createStore } = require("./lib/store");
const { createAuth } = require("./lib/auth");
const { createDevices } = require("./lib/devices");
const { cleanView, blankView, viewNeeds, viewLinks, unsupportedFor, catalog, WIDGETS } = require("./lib/widgets");
const { createBoards } = require("./lib/boards");
const { createLab } = require("./lib/lab");
const { createJellyfin } = require("./lib/jellyfin");
const { createImmich } = require("./lib/immich");
const { createHass } = require("./lib/hass");
const { createOverlayWatcher, cleanOverlay, DEFAULT_OVERLAY } = require("./lib/overlay");
const { createTimers, cleanTimer } = require("./lib/timers");
const { createMatrix, cleanTarget, BEACON_DEFAULTS, EFFECTS, PALETTES, AUDIO_MODES, ICONS, SEVERITIES } = require("./lib/matrix");
const { createMqtt, createSwitchableMqtt } = require("./lib/mqtt");
const { createConnections } = require("./lib/connections");
const { createHousehold } = require("./lib/household");
const { createMiniMatrix, cleanTarget: cleanMini, BEDROOM_DEFAULTS } = require("./lib/minimatrix");
const { exportBackup, readBackup } = require("./lib/backup");
const { version: VERSION } = require("./package.json");
const STARTED = Date.now();

const PUBLIC = path.join(__dirname, "public");
// The display page's code, hashed: a screen that sees a new value after
// reconnecting (a deploy) reloads itself.
const DISPLAY_FILES = ["display.html", "display.js", "display.css", "render.js", "render-household.js", "render-whiteboard.js", "render-lab.js", "render-media.js", "render.css"];
const CODE_VERSION = (() => {
  const h = crypto.createHash("sha256");
  for (const f of DISPLAY_FILES) { try { h.update(fs.readFileSync(path.join(PUBLIC, f))); } catch (_e) { /* missing in tests */ } }
  return h.digest("hex").slice(0, 12);
})();
const FONT_FILES = ["/fonts/manrope.woff2", "/fonts/fraunces.woff2", "/fonts/nunito-latin.woff2", "/fonts/patrick-hand-latin.woff2", "/fonts/permanent-marker-latin.woff2"];

// Night dim: between from and to (hours, may wrap midnight), after two
// minutes without a touch. brightness is the backlight level (0.01-1) on the
// House Board app; elsewhere the display darkens the page instead.
function cleanNightDim(v) {
  const n = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d);
  v = v && typeof v === "object" ? v : {};
  return { on: v.on === true, from: Math.round(n(v.from, 0, 23, 22)), to: Math.round(n(v.to, 0, 23, 6)), brightness: Math.round(n(v.brightness, 0.01, 1, 0.12) * 100) / 100 };
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

function createApp(env = process.env, deps = {}) {
  const dataDir = env.DATA_DIR || path.join(__dirname, "data");
  const store = deps.store || createStore(dataDir);
  const auth = createAuth({ store, agentTokenFile: env.AGENT_TOKEN_FILE, setupCodeFile: env.SETUP_CODE_FILE });
  const devices = createDevices({ store });
  const boards = createBoards(dataDir);
  // Integration addresses and keys: .env + secrets/, or the Settings page.
  const conn = deps.connections || createConnections({ env, dataDir });
  // A client only gets the key while the settings still point at its own
  // address: a request in flight when the address changes must not carry the
  // new key to the old server. (Server keys are still read live, for rotation.)
  const keyFor = (id, url) => () => { const c = conn.get(id); return c.url === url ? c.secret : ""; };
  const makeImmich = () => { const url = conn.get("immich").url; return createImmich({ baseUrl: url, readKey: keyFor("immich", url), cacheDir: path.join(dataDir, "previews"), log }); };
  let immich = deps.immich || makeImmich();
  const secureCookies = env.COOKIE_SECURE !== "0";

  // ---------- live connections ----------
  const displayStreams = new Map(); // deviceId -> Set(res)
  const adminStreams = new Set();

  function sse(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function toDevice(deviceId, event, data) {
    for (const res of displayStreams.get(deviceId) || []) sse(res, event, data);
  }
  function toScreen(screenId, event, data) {
    const dev = devices.forScreen(screenId);
    if (dev) toDevice(dev.id, event, data);
  }
  function toAdmins(event, data) {
    for (const res of adminStreams) sse(res, event, data);
  }
  const online = (deviceId) => (displayStreams.get(deviceId) || new Set()).size > 0;

  // ---------- Home Assistant ----------
  let hass = null, hassEntities = "";
  const haUrl = () => conn.get("homeAssistant").url;
  const haToken = () => conn.get("homeAssistant").secret;
  function wantedEntities() {
    const set = new Set();
    for (const v of Object.values(store.data.views)) {
      for (const e of viewNeeds(v.published).entities) set.add(e);
      for (const e of viewNeeds(v.draft).entities) set.add(e);
    }
    for (const s of Object.values(store.data.screens)) if (s.timer && s.timer.enabled) for (const e of s.timer.entities) set.add(e);
    for (const e of matrix.entities()) set.add(e);
    for (const e of minimatrix.entities()) set.add(e);
    return [...set].sort();
  }
  function onHassChange(ids) {
    timers.onStates(ids);
    const changed = {};
    for (const id of ids) changed[id] = slimState(hass.states[id]);
    for (const dev of Object.values(store.data.devices)) {
      if (!dev.screenId || !online(dev.id)) continue;
      const need = new Set(viewNeeds(screenView(dev.screenId)).entities);
      const mine = {};
      for (const id of ids) if (need.has(id)) mine[id] = changed[id];
      if (Object.keys(mine).length) toDevice(dev.id, "states", mine);
      const t = (store.data.screens[dev.screenId] || {}).timer;
      if (t && t.enabled && ids.some((id) => t.entities.includes(id))) toDevice(dev.id, "timers", timersFor(dev.screenId));
    }
    toAdmins("states", changed);
    matrix.onStates(ids);
    minimatrix.onStates(ids);
    household.onStates(ids);
  }
  // (Re)subscribe to exactly the entities that drafts and published views use.
  function syncHass() {
    if (deps.hass) {
      if (hass !== deps.hass) { hass = deps.hass; hass.on("change", onHassChange); }
      syncHousehold();
      return;
    }
    syncHousehold();
    const want = wantedEntities();
    const key = want.join(",");
    if (key === hassEntities && hass) return;
    hassEntities = key;
    if (hass) hass.stop();
    hass = null;
    if (!haUrl() || !haToken() || !want.length) return;
    hass = createHass({ url: haUrl(), token: haToken(), entities: want, log }).start();
    hass.on("change", onHassChange);
    hass.on("status", (up) => { if (up) household.refreshAll(); });
  }
  // Attributes screens may show. Entity tiles can ask for one more by name.
  const SLIM_ATTRS = ["friendly_name", "unit_of_measurement", "temperature", "temperature_unit", "device_class", "humidity",
    "current_temperature", "battery_level", "error_text", "next_rising", "next_setting", "elevation"];
  let extraAttrs = new Set();
  function slimState(s) {
    if (!s) return null;
    const a = s.attributes || {};
    const keep = {};
    for (const k of SLIM_ATTRS) if (a[k] !== undefined) keep[k] = a[k];
    for (const k of extraAttrs) if (a[k] !== undefined && typeof a[k] !== "object") keep[k] = a[k];
    if (a.entity_picture) keep.has_picture = true; // the URL stays on the server (/api/person/<id>)
    return { state: s.state, attributes: keep, last_changed: s.last_changed || null };
  }
  function statesFor(entities) {
    const out = {};
    for (const id of entities) out[id] = hass ? slimState(hass.states[id]) : null;
    return out;
  }

  // ---------- timer pop-up (HA timer.* helpers) ----------
  const timers = deps.timers || createTimers({ states: () => (hass ? hass.states : {}), now: deps.now });
  function timersFor(screenId) {
    const s = store.data.screens[screenId];
    return { timers: s ? timers.list(s.timer) : [], serverTime: Date.now() };
  }

  // ---------- Frigate overlay ----------
  const makeOverlays = () => createOverlayWatcher({
    url: conn.get("frigate").url, log,
    screens: () => Object.values(store.data.screens),
    onOverlay: (screenId, info) => {
      toScreen(screenId, "overlay", info);
      toAdmins("overlay", { screenId, ...info });
    }
  });
  let overlays = deps.overlays || makeOverlays();

  // ---------- household data (calendars, lists, forecasts, Frigate events) ----------
  const labFor = (url) => createLab({ url, log, storageMetric: env.LAB_STORAGE_METRIC || undefined, hostPattern: env.LAB_HOST_PATTERN || "" });
  const jellyfinFor = (url, readKey) => createJellyfin({ url, readKey, log });
  const makeLab = () => (conn.get("prometheus").url ? labFor(conn.get("prometheus").url) : null);
  const makeJellyfin = () => { const url = conn.get("jellyfin").url; return url ? jellyfinFor(url, keyFor("jellyfin", url)) : null; };
  let lab = deps.lab || makeLab();
  let jellyfin = deps.jellyfin || makeJellyfin();
  const household = deps.household || createHousehold({ hass: () => hass, frigateUrl: () => conn.get("frigate").url, log, lab, jellyfin });
  function allNeeds() {
    const views = [];
    for (const v of Object.values(store.data.views)) views.push(v.published, v.draft);
    const merged = { calendars: new Map(), todos: new Set(), forecasts: new Set(), cameras: {}, attrs: new Set(), lab: false, jellyfin: false };
    for (const v of views) {
      const n = viewNeeds(v);
      for (const c of n.calendars) merged.calendars.set(c.entity, merged.calendars.get(c.entity) || c.birthdays);
      for (const t of n.todos) merged.todos.add(t);
      for (const f of n.forecasts) merged.forecasts.add(f);
      Object.assign(merged.cameras, n.cameras);
      if (n.data.includes("lab")) merged.lab = true;
      if (n.data.includes("jellyfin")) merged.jellyfin = true;
      for (const w of (v && v.widgets) || []) if (w.type === "entity" && w.props.attribute) merged.attrs.add(w.props.attribute);
    }
    return merged;
  }
  function syncHousehold() {
    const n = allNeeds();
    extraAttrs = n.attrs;
    household.sync({ calendars: [...n.calendars].map(([entity, birthdays]) => ({ entity, birthdays })),
      todos: [...n.todos], forecasts: [...n.forecasts], cameras: n.cameras, lab: n.lab, jellyfin: n.jellyfin });
  }
  household.on("change", (keys) => {
    const snap = household.snapshot(keys);
    for (const dev of Object.values(store.data.devices)) {
      if (!dev.screenId || !online(dev.id)) continue;
      const need = new Set(viewNeeds(screenView(dev.screenId)).data);
      const mine = {};
      for (const k of keys) if (need.has(k)) mine[k] = snap[k];
      if (Object.keys(mine).length) toDevice(dev.id, "data", mine);
    }
    toAdmins("data", snap);
  });

  // One request from a screen's interactive widget. Only actions the widget
  // allows, on the calendars/lists/entities configured in it, on this screen.
  async function act(dev, b) {
    const no = (msg, status = 403) => Object.assign(new Error(msg), { status });
    const view = dev.screenId ? screenView(dev.screenId) : null;
    const w = view && view.widgets.find((x) => x.id === String(b.widget || ""));
    if (!w) throw no("That isn't on this screen");
    const p = w.props, a = String(b.action || "");
    const result = { ok: true };
    const kidsOn = () => Boolean((store.data.screens[dev.screenId] || {}).kids);
    const row = (list, i) => { const r = (list || [])[Number(i)]; if (!r) throw no("Unknown row", 400); return r; };
    switch (`${w.type}.${a}`) {
      case "calendar.add": if (!p.allowAdd) throw no("Adding isn't allowed here"); await household.calendarAdd(row(p.calendars, b.cal).entity, b); break;
      case "calendar.erase": {
        if (!p.allowErase) throw no("Erasing isn't allowed here");
        const c = (p.calendars || []).find((x) => x.entity === b.calendar);
        if (!c) throw no("Unknown calendar", 400);
        await household.calendarErase(c.entity, String(b.uid || ""), b.rid ? String(b.rid) : null);
        break;
      }
      case "todo.add": if (!p.allowAdd) throw no("Adding isn't allowed here"); await household.todoAdd(p.entity, b.text); break;
      case "todo.check": if (!p.allowCheck) throw no("Checking off isn't allowed here"); await household.todoCheck(p.entity, String(b.uid || ""), Boolean(b.done)); break;
      case "chores.add": if (!p.allowAdd) throw no("Adding isn't allowed here"); await household.todoAdd(row(p.kids, b.kid).entity, b.text); break;
      case "chores.check": if (!p.allowCheck) throw no("Checking off isn't allowed here"); await household.todoCheck(row(p.kids, b.kid).entity, String(b.uid || ""), Boolean(b.done)); break;
      case "wbcal.add": {
        if (!p.allowAdd) throw no("Writing isn't allowed here");
        if (kidsOn()) throw no("Grandkids mode is on", 423);
        const c = row(p.calendars, b.cal);
        const day = String(b.day || ""), min = b.min === null || b.min === undefined ? null : Number(b.min);
        if (min !== null && !(Number.isInteger(min) && min >= 0 && min < 1440)) throw no("Bad time", 400);
        const time = min === null ? null : `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
        await household.calendarAdd(c.entity, { title: b.title, date: day, time, repeat: b.weekly ? "weekly" : "none", minutes: 60 });
        result.event = findEvent(c.entity, String(b.title || "").trim().slice(0, 80), day, time);
        break;
      }
      case "wbcal.erase": {
        if (!p.allowErase) throw no("Erasing isn't allowed here");
        if (kidsOn()) throw no("Grandkids mode is on", 423);
        const c = (p.calendars || []).find((x) => x.entity === b.calendar);
        if (!c) throw no("Unknown calendar", 400);
        const ev = ((household.snapshot(["cal:" + c.entity])["cal:" + c.entity] || {}).events || [])
          .find((x) => x.uid === String(b.uid || "") && (x.rid || null) === (b.rid ? String(b.rid) : null));
        await household.calendarErase(c.entity, String(b.uid || ""), b.rid ? String(b.rid) : null);
        if (ev) result.erased = logErased(w.id, c.entity, ev);
        break;
      }
      case "wbcal.restore": {
        if (!p.allowErase) throw no("Erasing isn't allowed here");
        if (kidsOn()) throw no("Grandkids mode is on", 423);
        const entry = (store.data.erased || []).find((x) => x.id === String(b.id || "") && x.widget === w.id);
        if (!entry) throw no("That isn't in the erased list any more", 400);
        const e = entry.event;
        await household.calendarAdd(entry.calendar, { title: e.title, date: e.day, time: e.time, repeat: "none", minutes: 60 });
        store.update((d) => { d.erased = (d.erased || []).filter((x) => x.id !== entry.id); });
        result.event = findEvent(entry.calendar, e.title, e.day, e.time);
        break;
      }
      case "since.run": if (!p.script) throw no("No button here"); await household.service("script", "turn_on", { entity_id: p.script }); break;
      case "button.press": {
        const e = p.entity, domain = e.split(".")[0];
        if (p.action === "script" && domain === "script") await household.service("script", "turn_on", { entity_id: e });
        else if (p.action === "vacuum" && domain === "vacuum") await household.service("vacuum", b.what === "dock" ? "return_to_base" : "start", { entity_id: e });
        else if (p.action === "toggle" && ["switch", "light", "fan", "input_boolean"].includes(domain)) await household.service("homeassistant", "toggle", { entity_id: e });
        else throw no("This button isn't set up", 400);
        break;
      }
      case "icons.matrix": {
        // The "Matrix" icon opens a sheet for playing with the Matrix; what it
        // shows is temporary (lib/matrix.js play()).
        const item = (p.items || []).find((x) => x.kind === "matrix");
        if (!item) throw no("No Matrix button here");
        const id = Object.keys(store.data.matrix.targets)[0]; // the household has one Matrix
        if (!id) throw no("There's no Matrix set up", 409);
        if (!store.data.matrix.targets[id].live) throw no("Studio isn't driving the Matrix right now", 409);
        const r = b.what === "stop" ? matrix.endPlay(id) : matrix.play(id, b.play, (Number(p.playMinutes) || 10) * 60000);
        if (!r.ok) throw no(r.error, 400);
        if (r.until) result.until = r.until;
        break;
      }
      default: throw no("Unknown action", 400);
    }
    const screen = store.data.screens[dev.screenId];
    log(`act: ${screen ? screen.name : dev.id} ${w.type}.${a}`);
    return result;
  }
  // The event just written, so the screen can offer "Undo".
  function findEvent(entity, title, day, time) {
    const list = (household.snapshot(["cal:" + entity])["cal:" + entity] || {}).events || [];
    const e = list.find((x) => x.title === title && x.day === day && (time ? !x.allDay : x.allDay));
    return e ? { calendar: entity, uid: e.uid, rid: e.rid } : null;
  }
  // Erased whiteboard events, kept 30 days so they can be brought back.
  function logErased(widgetId, entity, ev) {
    const t = new Date(ev.start), hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    const entry = { id: crypto.randomBytes(6).toString("hex"), at: Date.now(), widget: widgetId, calendar: entity,
      event: { title: ev.title, day: ev.day, time: ev.allDay ? null : hhmm } };
    store.update((d) => {
      const keep = Date.now() - 30 * 864e5;
      d.erased = (d.erased || []).filter((x) => x.at > keep).concat(entry).slice(-200);
    });
    return entry;
  }
  // Grandkids mode: on with a tap, off only with the screen's PIN.
  const pinTries = new Map(); // screenId -> { fails: [ms], lockedUntil }
  function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString("hex"); }
  function setKids(dev, b) {
    const s = store.data.screens[dev.screenId];
    if (!s) throw Object.assign(new Error("Not paired"), { status: 403 });
    if (b.on) { store.update((d) => { d.screens[s.id].kids = true; }); }
    else {
      if (!s.pin) throw Object.assign(new Error("This screen has no PIN yet; set one in Studio"), { status: 409 });
      const t = pinTries.get(s.id) || { fails: [], lockedUntil: 0 }, now = Date.now();
      pinTries.set(s.id, t);
      if (now < t.lockedUntil) throw Object.assign(new Error("Too many tries. Wait a minute."), { status: 429 });
      const given = Buffer.from(hashPin(String(b.pin || ""), s.pin.salt), "hex");
      if (!crypto.timingSafeEqual(given, Buffer.from(s.pin.hash, "hex"))) {
        t.fails = t.fails.filter((x) => now - x < 5 * 60000).concat(now);
        if (t.fails.length >= 5) { t.lockedUntil = now + 60000; t.fails = []; }
        throw Object.assign(new Error("Wrong PIN"), { status: 403 });
      }
      t.fails = [];
      store.update((d) => { d.screens[s.id].kids = false; });
    }
    toScreen(s.id, "kids", { kids: Boolean(store.data.screens[s.id].kids) });
    toAdmins("changed", { what: "screens" });
    return { kids: Boolean(store.data.screens[s.id].kids) };
  }

  // ---------- Matrix (MQTT) ----------
  // The household's one Matrix target is seeded with V1's settings the first
  // time Studio starts with an MQTT broker configured.
  function seedMatrix() {
    if (conn.get("mqtt").url && !(store.data.matrix && Object.keys(store.data.matrix.targets).length)) {
      store.update((d) => { d.matrix = { targets: { [BEACON_DEFAULTS.id]: cleanTarget(BEACON_DEFAULTS) } }; });
    }
  }
  seedMatrix();
  if (!store.data.matrix) store.data.matrix = { targets: {} };
  const mqttClientId = env.MQTT_CLIENT_ID || "coreview-studio-" + crypto.randomBytes(3).toString("hex");
  // A client for the current broker settings, or null. Set on the server with
  // no password yet = no MQTT at all (a refused login every 30 s helps nobody).
  function makeMqttClient() {
    const c = conn.get("mqtt");
    if (!c.url) return null;
    if (c.source === "server" && env.MQTT_PASSWORD_FILE && !c.secret) { log("mqtt: no password file yet; the Matrix stays in preview only"); return null; }
    return createMqtt({ url: c.url, username: c.username, password: c.secret, clientId: mqttClientId, log });
  }
  const mqtt = deps.mqtt !== undefined ? deps.mqtt : createSwitchableMqtt();
  if (deps.mqtt === undefined) mqtt.use(makeMqttClient());
  const matrix = createMatrix({
    store, mqtt, topicRoot: env.MQTT_TOPIC_ROOT || "home/signage", log, now: deps.now,
    states: () => (hass ? hass.states : {}), timers,
    onChange: (id, summary) => toAdmins("matrix", summary)
  });

  // ---------- Bedroom matrix (WLED, DDP) ----------
  // Seeded once with the household's people, doors, cameras and helpers; off
  // until someone ticks "Studio drives it".
  if (!store.data.minimatrix) {
    store.update((d) => { d.minimatrix = { targets: { [BEDROOM_DEFAULTS.id]: cleanMini(BEDROOM_DEFAULTS) } }; });
  }
  // Bring saved settings up to the current shape (e.g. the dryer joining laundry).
  store.update((d) => { for (const [id, t] of Object.entries(d.minimatrix.targets)) d.minimatrix.targets[id] = cleanMini(t, t); });
  const minimatrix = deps.minimatrix || createMiniMatrix({
    store, log, now: deps.now, states: () => (hass ? hass.states : {}),
    onChange: (id, summary) => toAdmins("minimatrix", summary)
  });

  // ---------- model helpers ----------
  // A screen shows its view plus any views that view leads to (a tap switches
  // to the calendar, a button opens the drawing board...), at most 8.
  function screenViews(screenId) {
    const s = store.data.screens[screenId];
    const out = {};
    const queue = s && s.viewId ? [s.viewId] : [];
    while (queue.length && Object.keys(out).length < 8) {
      const id = queue.shift();
      if (out[id] || !store.data.views[id]) continue;
      out[id] = store.data.views[id].published;
      queue.push(...viewLinks(out[id]));
    }
    return { main: s && out[s.viewId] ? s.viewId : null, views: out };
  }
  // Everything on a screen, as one view: what it needs and what it may do.
  function screenView(screenId) {
    const { main, views } = screenViews(screenId);
    if (!main) return null;
    const widgets = [];
    for (const v of Object.values(views)) widgets.push(...v.widgets);
    return { ...views[main], widgets };
  }
  function tzOffsetMin() { return -new Date().getTimezoneOffset(); }
  function displayPayload(dev) {
    const screen = dev.screenId ? store.data.screens[dev.screenId] : null;
    const view = screen ? screenView(screen.id) : null;
    const linked = screen ? screenViews(screen.id) : { main: null, views: {} };
    return {
      deviceId: dev.id, paired: Boolean(screen), code: screen ? null : dev.code,
      screen: screen ? { id: screen.id, name: screen.name, nightDim: cleanNightDim(screen.nightDim), kids: Boolean(screen.kids), pinLength: screen.pin ? screen.pin.length : 0 } : null,
      view: linked.main ? linked.views[linked.main] : null, viewId: linked.main, views: linked.views,
      states: view ? statesFor(viewNeeds(view).entities) : {},
      data: view ? household.snapshot(viewNeeds(view).data) : {},
      unsupported: view ? unsupportedFor(view, dev.chrome) : [],
      timers: screen ? timersFor(screen.id).timers : [],
      codeVersion: CODE_VERSION,
      serverTime: Date.now(), tzOffsetMin: tzOffsetMin()
    };
  }
  function pushScreen(screenId) {
    const dev = devices.forScreen(screenId);
    if (dev) toDevice(dev.id, "init", displayPayload(dev));
  }
  function screensUsingView(viewId) {
    return Object.values(store.data.screens).filter((s) => s.viewId === viewId);
  }
  // The PIN's hash stays on the server.
  function publicScreen(s) {
    const { pin, ...rest } = s;
    return { ...rest, hasPin: Boolean(pin), pinLength: pin ? pin.length : 0 };
  }
  function publicDevice(d) {
    return { id: d.id, screenId: d.screenId, code: d.screenId ? null : d.code, label: d.label, chrome: d.chrome,
      width: d.width, height: d.height, ip: d.ip, lastSeen: d.lastSeen, createdAt: d.createdAt, online: online(d.id) };
  }
  function adminState(user) {
    return {
      user,
      screens: Object.values(store.data.screens).map(publicScreen),
      devices: Object.values(store.data.devices).map(publicDevice),
      views: Object.values(store.data.views),
      catalog: catalog(),
      matrix: matrix.list(),
      minimatrix: minimatrix.list(),
      matrixOptions: { effects: EFFECTS, palettes: PALETTES, audioModes: AUDIO_MODES, icons: ICONS, severities: SEVERITIES },
      integrations: { immich: immich.configured(), homeAssistant: Boolean(hass && hass.connected), haConfigured: Boolean(haUrl() && haToken()), frigate: Boolean(conn.get("frigate").url) },
      tzOffsetMin: tzOffsetMin(), serverTime: Date.now()
    };
  }
  // ---------- settings page ----------
  const CONN_IDS = Object.keys(conn.SERVICES);
  // Live state for services with a standing connection; null = ask with a test.
  function liveStatus(id) {
    if (id === "homeAssistant") return hass ? Boolean(hass.connected) : null;
    if (id === "mqtt") return conn.get("mqtt").url ? Boolean(mqtt && mqtt.connected) : null;
    return null;
  }
  function settingsInfo(user) {
    return {
      user, version: VERSION, codeVersion: CODE_VERSION, startedAt: STARTED, serverTime: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      connections: CONN_IDS.map((id) => ({ ...conn.describe(id), connected: liveStatus(id) })),
      signs: [
        ...matrix.list().map((t) => ({ name: t.name || t.id, kind: "Matrix (MQTT)", online: t.online, lastSeen: t.lastSeen, firmware: (t.status && t.status.firmware) || null })),
        ...minimatrix.list().map((t) => ({ name: t.name || t.id, kind: "Bedroom matrix (WLED)", online: null, lastSeen: null, firmware: null,
          note: !t.host ? "No WLED address yet" : t.enabled ? `Studio drives it (${t.host})` : `Left to WLED (${t.host})` }))
      ],
      counts: { screens: Object.keys(store.data.screens).length, views: Object.keys(store.data.views).length,
        displays: Object.values(store.data.devices).filter((d) => d.screenId).length }
    };
  }
  // Log in to a broker once and hang up (a draft from the Settings page).
  function testMqtt(cfg) {
    return new Promise((resolve) => {
      let last = "", finished = false;
      const c = createMqtt({ url: cfg.url, username: cfg.username, password: cfg.secret, clientId: `${mqttClientId}-test`, log: (msg) => { last = String(msg); } });
      const done = (r) => { if (finished) return; finished = true; clearTimeout(t); c.stop(); resolve(r); };
      const t = setTimeout(() => done({ ok: false, detail: "No answer from the broker" }), 6000);
      c.on("status", (up) => done(up ? { ok: true, detail: cfg.username ? `Logged in as ${cfg.username}` : "Connected" }
        : { ok: false, detail: last.replace(/^mqtt: /, "").replace(/; retrying$/, "") || "Couldn't connect" }));
      c.start();
    });
  }
  // One real request to the service: with the live settings, or with a draft
  // from the Settings page (resolved by conn.draft, so a changed address never
  // carries the saved key).
  async function testConnection(id, cfg, isDraft) {
    const plain = (d) => (/^fetch failed\b/.test(d) ? d.replace(/^fetch failed/, "Couldn't reach that address") : d);
    const res = (ok, detail) => ({ ok, detail: plain(String(detail || "")).slice(0, 160) });
    const need = (what) => res(false, `No ${what} yet`);
    const run = async () => {
      switch (id) {
        case "homeAssistant": {
          if (!cfg.url) return need("address");
          if (!cfg.secret) return need("access token");
          const r = await fetch(`${cfg.url.replace(/\/+$/, "")}/api/config`, { headers: { Authorization: `Bearer ${cfg.secret}` }, redirect: "error", signal: AbortSignal.timeout(8000) });
          if (r.status === 401) return res(false, "Home Assistant refused the token (401)");
          if (!r.ok) return res(false, `Home Assistant said ${r.status}`);
          const c = await r.json();
          return res(true, `${c.location_name || "Home Assistant"} · version ${c.version || "?"}`);
        }
        case "mqtt":
          if (!cfg.url) return need("address");
          if (isDraft) return testMqtt(cfg);
          if (cfg.source === "server" && env.MQTT_PASSWORD_FILE && !cfg.secret) return res(false, "No password file yet (secrets/mqtt_password)");
          return mqtt.connected ? res(true, "Connected") : res(false, "Not connected; Studio keeps retrying (see the log)");
        case "immich": {
          if (isDraft || !immich.configured()) {
            if (!cfg.url) return need("address");
            if (!cfg.secret) return need("API key");
          }
          const im = isDraft ? createImmich({ baseUrl: cfg.url, readKey: () => cfg.secret }) : immich;
          const albums = await im.listAlbums();
          return res(true, `${albums.length} album${albums.length === 1 ? "" : "s"} visible`);
        }
        case "frigate": {
          if (!cfg.url) return need("address");
          const ov = isDraft ? createOverlayWatcher({ url: cfg.url, screens: () => [], onOverlay: () => {} }) : overlays;
          const cams = await ov.listCameras();
          return res(true, `${cams.length} camera${cams.length === 1 ? "" : "s"}`);
        }
        case "jellyfin": {
          if (!cfg.url) return need("address");
          if (!cfg.secret) return need("API key");
          const j = isDraft ? jellyfinFor(cfg.url, () => cfg.secret) : jellyfin;
          if (!j) return need("address");
          const r = await j.refresh();
          return r.ok ? res(true, `${r.recent.length} recently added, ${r.playing.length} playing`) : res(false, r.error);
        }
        case "prometheus": {
          if (!cfg.url) return need("address");
          const l = isDraft ? labFor(cfg.url) : lab;
          if (!l) return need("address");
          const r = await l.refresh();
          return r.ok ? res(true, `${(r.hosts || []).length} hosts`) : res(false, r.error);
        }
        default: throw Object.assign(new Error("Unknown connection"), { status: 404 });
      }
    };
    let timer;
    try {
      return await Promise.race([run(), new Promise((resolve) => { timer = setTimeout(() => resolve(res(false, "No answer within 10 seconds")), 10000); })]);
    } catch (e) {
      if (e.status === 404) throw e;
      const cause = e.cause && (e.cause.code || e.cause.message);
      return res(false, cause ? `${e.message} (${cause})` : e.message);
    } finally { clearTimeout(timer); }
  }
  // Settings page saved a connection: rebuild that integration in place.
  function applyConnection(id) {
    switch (id) {
      case "homeAssistant":
        if (deps.hass) break;
        if (hass) { hass.stop(); hass = null; }
        hassEntities = "";
        syncHass();
        break;
      case "mqtt":
        if (deps.mqtt !== undefined) break;
        seedMatrix();
        mqtt.use(makeMqttClient());
        for (const t of Object.keys(store.data.matrix.targets)) matrix.refresh(t, { force: true });
        break;
      case "immich": if (!deps.immich) immich = makeImmich(); break;
      case "frigate":
        if (!deps.overlays) { overlays.stop(); overlays = makeOverlays(); overlays.start(); }
        syncHousehold();
        break;
      case "jellyfin": if (!deps.jellyfin) { jellyfin = makeJellyfin(); if (household.setSources) household.setSources({ jellyfin }); } break;
      case "prometheus": if (!deps.lab) { lab = makeLab(); if (household.setSources) household.setSources({ lab }); } break;
    }
    toAdmins("changed", { what: "settings" });
  }
  function restoreBackup(input) {
    const next = readBackup(input, { cleanView, cleanOverlay, cleanTimer, cleanNightDim, cleanMatrix: cleanTarget, cleanMini });
    // Keep the current file next to the store, in case the restore was a mistake.
    const keep = `${store.file}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (fs.existsSync(store.file)) { fs.copyFileSync(store.file, keep); fs.chmodSync(keep, 0o600); }
    // Displays waiting to pair right now stay waiting.
    for (const dev of Object.values(store.data.devices)) if (!dev.screenId && !next.devices[dev.id]) next.devices[dev.id] = dev;
    // The Beacon ignores revisions at or below the last one it applied, so a
    // restored Matrix carries on from the current revision, never back.
    for (const [id, t] of Object.entries(next.matrix.targets)) {
      const cur = (store.data.matrix.targets || {})[id];
      if (cur) t.revision = Math.max(t.revision || 0, cur.revision || 0);
    }
    const gone = Object.keys(store.data.devices).filter((id) => !next.devices[id]);
    store.update((d) => Object.assign(d, next));
    for (const id of gone) toDevice(id, "unpaired", {});
    syncHass();
    for (const id of Object.keys(store.data.matrix.targets)) matrix.refresh(id, { force: true });
    for (const id of Object.keys(store.data.minimatrix.targets)) minimatrix.refresh(id);
    for (const dev of Object.values(store.data.devices)) toDevice(dev.id, "init", displayPayload(dev));
    toAdmins("changed", { what: "screens" });
    log(`restore: ${Object.keys(next.screens).length} screens, ${Object.keys(next.views).length} views (previous file kept as ${path.basename(keep)})`);
    return { screens: Object.keys(next.screens).length, views: Object.keys(next.views).length, displays: Object.values(next.devices).filter((d) => d.screenId).length };
  }

  const newId = (prefix) => prefix + "-" + crypto.randomBytes(5).toString("hex");
  // Always have at least one view, so a freshly paired screen shows something.
  function ensureStarterView() {
    if (Object.keys(store.data.views).length) return;
    const id = newId("view"), view = blankView();
    store.update((d) => { d.views[id] = { id, name: "Photo frame", draft: view, published: view, updatedAt: Date.now(), publishedAt: Date.now() }; });
  }
  ensureStarterView();
  const cleanName = (n, fallback) => (typeof n === "string" && n.trim() ? n.trim().slice(0, 60) : fallback);

  // ---------- HTTP plumbing ----------
  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf || typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": isBuf || typeof body === "string" ? headers["Content-Type"] || "text/plain; charset=utf-8" : "application/json",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      ...headers
    });
    res.end(payload);
  }
  const fail = (res, err) => send(res, err.status || 500, { error: err.status ? err.message : "Something went wrong" });

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function setCookie(name, value, { maxAge, sameSite = "Lax" } = {}) {
    let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}`;
    if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
    if (secureCookies) c += "; Secure";
    return c;
  }
  async function body(req, limit = 256 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_e) {
      throw Object.assign(new Error("Bad JSON"), { status: 400 });
    }
  }
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
  function serveFile(res, file, csp) {
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: "Not found" });
    const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" };
    if (csp) headers["Content-Security-Policy"] = csp;
    send(res, 200, fs.readFileSync(file), headers);
  }
  function clientIp(req) {
    // Behind the reverse proxy, which sets X-Real-IP.
    return String(req.headers["x-real-ip"] || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  }
  function openStream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff"
    });
    res.write("retry: 5000\n\n");
    // A real event (not a comment) so displays can tell a stalled stream apart.
    const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 25000);
    req.on("close", () => clearInterval(ping));
  }
  const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

  async function pipeUpstream(res, upstream, cacheSecs) {
    if (!upstream || (!upstream.ok && upstream.status !== 206)) return send(res, 404, { error: "Not found" });
    const h = { "Content-Type": upstream.headers.get("content-type") || "application/octet-stream", "Cache-Control": `private, max-age=${cacheSecs}`, "X-Content-Type-Options": "nosniff" };
    for (const k of ["content-length", "content-range", "accept-ranges"]) { const v = upstream.headers.get(k); if (v) h[k] = v; }
    res.writeHead(upstream.status, h);
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  }
  async function personPicture(res, entity) {
    const s = hass && hass.states[entity];
    const pic = s && s.attributes && s.attributes.entity_picture;
    if (!pic || !hass.connected || !/^\/[^/]/.test(pic)) return send(res, 404, { error: "No picture" });
    return pipeUpstream(res, await hass.rest(pic).catch(() => null), 86400);
  }
  async function frigateMedia(req, res, id, kind, cameras) {
    const up = await household.cameraMedia(id, kind, req.headers.range, cameras).catch(() => null);
    return pipeUpstream(res, up, kind === "clip" ? 300 : 3600);
  }

  async function jellyfinImage(res, id, kind) {
    const img = await Promise.resolve(household.jellyfinImage ? household.jellyfinImage(id, kind) : null).catch(() => null);
    if (!img) return send(res, 404, { error: "Not found" });
    return send(res, 200, img.body, { "Content-Type": img.type, "Cache-Control": "private, max-age=86400" });
  }

  // ---------- display listener ----------
  async function display(req, res) {
    const url = new URL(req.url, "http://display");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(res, path.join(PUBLIC, "display.html"), CSP);
      if (req.method === "GET" && ["/display.js", "/display.css", "/render.js", "/render-household.js", "/render-whiteboard.js", "/render-lab.js", "/render-media.js", "/render.css"].includes(p)) {
        return serveFile(res, path.join(PUBLIC, p.slice(1)));
      }
      if (req.method === "GET" && FONT_FILES.includes(p)) return serveFile(res, path.join(PUBLIC, p.slice(1)));

      if (req.method === "POST" && p === "/api/hello") {
        const b = await body(req, 4096);
        const info = { ua: req.headers["user-agent"], ip: clientIp(req), width: b.w, height: b.h };
        let dev = devices.authenticate(cookies(req).cv_device);
        let headers = {};
        if (dev) devices.seen(dev, info);
        else {
          const created = devices.create(info);
          dev = created.device;
          headers = { "Set-Cookie": setCookie("cv_device", created.cookie, { maxAge: 10 * 365 * 24 * 3600 }) };
          toAdmins("devices", { reason: "new" });
        }
        return send(res, 200, displayPayload(store.data.devices[dev.id]), headers);
      }

      const dev = devices.authenticate(cookies(req).cv_device);
      if (!dev) return send(res, 401, { error: "Display not registered" });

      if (req.method === "GET" && p === "/api/stream") {
        openStream(req, res);
        if (!displayStreams.has(dev.id)) displayStreams.set(dev.id, new Set());
        const set = displayStreams.get(dev.id);
        const wasOnline = set.size > 0;
        set.add(res);
        devices.seen(dev, {});
        sse(res, "init", displayPayload(store.data.devices[dev.id]));
        if (!wasOnline) toAdmins("devices", { reason: "online", deviceId: dev.id });
        req.on("close", () => {
          set.delete(res);
          if (store.data.devices[dev.id]) devices.seen(dev, {});
          if (!set.size) toAdmins("devices", { reason: "offline", deviceId: dev.id });
        });
        return;
      }

      const view = dev.screenId ? screenView(dev.screenId) : null;
      const needs = viewNeeds(view);
      const allowedAlbums = new Set(needs.albums);
      if (req.method === "POST" && p === "/api/act") return send(res, 200, await act(dev, await body(req, 8192)));
      if (req.method === "POST" && p === "/api/client-error") {
        const b = await body(req, 2048), s = dev.screenId && store.data.screens[dev.screenId];
        const clip = (v, n) => String(v || "").replace(/[\r\n]+/g, " ").slice(0, n);
        log(`display script error: ${s ? s.name : dev.id} (Chrome ${dev.chrome || "?"}): ${clip(b.msg, 300)} at ${clip(b.src, 80)}:${Number(b.line) || 0}:${Number(b.col) || 0}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/kids") return send(res, 200, setKids(dev, await body(req, 1024)));
      if (req.method === "GET" && p === "/api/erased") {
        const wid = url.searchParams.get("widget"), day = url.searchParams.get("day");
        const w = view && view.widgets.find((x) => x.id === wid && x.type === "wbcal");
        if (!w) return send(res, 403, { error: "Not on this screen" });
        const s = store.data.screens[dev.screenId], keep = Date.now() - 30 * 864e5;
        const list = s.kids ? [] : (store.data.erased || []).filter((x) => x.widget === wid && x.at > keep && (!day || x.event.day === day));
        return send(res, 200, { erased: list });
      }
      let bm;
      if ((bm = /^\/api\/board\/([a-z0-9-]{1,32})\/(notes|play|fridge)(?:\.png)?(?:\/(\d{13}-[0-9a-f]{6,8})\.jpg)?$/.exec(p))) {
        const [, name, part, fid] = bm;
        if (!needs.boards.includes(name)) return send(res, 403, { error: "Not on this screen" });
        const drawable = view.widgets.some((x) => x.type === "drawing" && x.props.board === name);
        if (part === "fridge") {
          if (req.method === "GET" && fid) { const img = boards.fridgeImage(name, fid); return img ? send(res, 200, img, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" }) : send(res, 404, { error: "Not found" }); }
          if (req.method === "GET") return send(res, 200, { fridge: boards.fridge(name) });
          if (req.method === "POST" && drawable) return send(res, 201, { id: boards.addFridge(name, (await body(req, 4 * 1024 * 1024)).img) });
        } else {
          if (req.method === "GET") { const img = boards.page(name, part); return img ? send(res, 200, img, { "Content-Type": "image/png" }) : send(res, 404, { error: "Blank" }); }
          if (req.method === "PUT" && drawable) {
            if (part === "notes" && store.data.screens[dev.screenId].kids) return send(res, 423, { error: "Grandkids mode is on" });
            const b2 = await body(req, 6 * 1024 * 1024);
            boards.savePage(name, part, b2.img ? b2.img : null);
            return send(res, 200, { ok: true });
          }
        }
        return send(res, 405, { error: "Not allowed" });
      }
      let mm;
      if (req.method === "GET" && (mm = /^\/api\/person\/(person\.[a-z0-9_]+)$/.exec(p))) {
        if (!needs.people.includes(mm[1])) return send(res, 403, { error: "Not on this screen" });
        return personPicture(res, mm[1]);
      }
      if (req.method === "GET" && (mm = /^\/api\/frigate\/([\w.-]{1,80})\/(snap|thumb|clip)$/.exec(p))) {
        return frigateMedia(req, res, mm[1], mm[2], new Set(Object.keys(needs.cameras)));
      }
      if (req.method === "GET" && (mm = /^\/api\/jellyfin\/([0-9a-f]{32})\/(poster|backdrop)$/.exec(p))) {
        if (!needs.data.includes("jellyfin")) return send(res, 403, { error: "Not on this screen" });
        return jellyfinImage(res, mm[1], mm[2]);
      }
      let m;
      if (req.method === "GET" && (m = /^\/api\/album\/([0-9a-f-]{36})$/.exec(p))) {
        if (!allowedAlbums.has(m[1])) return send(res, 403, { error: "Album not on this screen" });
        return send(res, 200, { photos: await immich.album(m[1]) });
      }
      if (req.method === "GET" && (m = /^\/api\/photo\/([0-9a-f-]{36})$/.exec(p))) {
        let ok = false;
        for (const a of allowedAlbums) if ((await immich.album(a)).some((x) => x.id === m[1])) { ok = true; break; }
        if (!ok) return send(res, 403, { error: "Photo not on this screen" });
        const img = await immich.preview(m[1]);
        if (!img) return send(res, 404, { error: "Not found" });
        return send(res, 200, img.body, { "Content-Type": img.type, "Cache-Control": "private, max-age=86400" });
      }
      if (req.method === "GET" && (m = /^\/api\/camera\/([A-Za-z0-9_-]{1,64})(\/live)?$/.exec(p))) {
        const s = dev.screenId && store.data.screens[dev.screenId];
        if (!s || !s.overlay || !s.overlay.enabled || !s.overlay.cameras.includes(m[1])) return send(res, 403, { error: "Camera not on this screen" });
        if (m[2]) {
          if (await overlays.liveStream(m[1], res, { maxSeconds: s.overlay.seconds + 30 })) return;
          return send(res, 502, { error: "Camera unavailable" });
        }
        const event = url.searchParams.get("event");
        const img = (event && event !== "test" && overlays.eventSnapshot && await overlays.eventSnapshot(event, m[1])) || await overlays.latestFrame(m[1]);
        if (!img) return send(res, 502, { error: "Camera unavailable" });
        return send(res, 200, img.body, { "Content-Type": img.type, "Cache-Control": "private, max-age=10" });
      }
      return send(res, 404, { error: "Not found" });
    } catch (err) {
      if (!err.status) log("display error", p, err.stack || err.message);
      return fail(res, err);
    }
  }

  // ---------- admin listener ----------
  function adminUser(req) {
    const authz = String(req.headers.authorization || "");
    return auth.who({ sessionId: cookies(req).cv_session, bearer: authz.startsWith("Bearer ") ? authz.slice(7) : null });
  }
  // Cookie-authenticated changes need our header and an Origin that is
  // exactly this site (browsers always send Origin on POST/PUT/PATCH/DELETE).
  // Bearer (agent) requests carry no cookie, so they skip this.
  function csrfOk(req) {
    if (String(req.headers.authorization || "").startsWith("Bearer ")) return true;
    if (req.headers["x-studio"] !== "1") return false;
    try {
      const o = new URL(String(req.headers.origin || ""));
      const scheme = secureCookies ? "https:" : o.protocol;
      return o.protocol === scheme && o.host === req.headers.host && o.pathname === "/";
    } catch (_e) { return false; }
  }

  async function admin(req, res) {
    const url = new URL(req.url, "http://admin");
    const p = url.pathname;
    const err = (status, message) => Object.assign(new Error(message), { status });
    try {
      if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(res, path.join(PUBLIC, "studio", "index.html"), CSP);
      if (req.method === "GET" && ["/render.js", "/render-household.js", "/render-whiteboard.js", "/render-lab.js", "/render-media.js", "/render.css", "/scoreboard.js", "/minimatrix.js"].includes(p)) return serveFile(res, path.join(PUBLIC, p.slice(1)));
      if (req.method === "GET" && FONT_FILES.includes(p)) return serveFile(res, path.join(PUBLIC, p.slice(1)));
      if (req.method === "GET" && p.startsWith("/studio/")) return serveFile(res, path.normalize(path.join(PUBLIC, p)));

      if (req.method !== "GET" && !csrfOk(req)) throw err(403, "Request refused");

      if (req.method === "GET" && p === "/api/session") {
        return send(res, 200, { setup: auth.needsSetup(), user: adminUser(req) });
      }
      if (req.method === "POST" && p === "/api/setup") {
        const b = await body(req, 4096);
        const sid = auth.setup(b.username, b.password, b.code);
        return send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cv_session", sid, { maxAge: 30 * 24 * 3600, sameSite: "Strict" }) });
      }
      if (req.method === "POST" && p === "/api/login") {
        const b = await body(req, 4096);
        const sid = auth.login(b.username, b.password, clientIp(req));
        if (!sid) throw err(401, "Wrong username or password");
        return send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cv_session", sid, { maxAge: 30 * 24 * 3600, sameSite: "Strict" }) });
      }
      if (req.method === "POST" && p === "/api/logout") {
        auth.logout(cookies(req).cv_session);
        return send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cv_session", "", { maxAge: 0, sameSite: "Strict" }) });
      }

      const user = adminUser(req);
      if (!user) throw err(401, "Please sign in");

      if (req.method === "GET" && p === "/api/state") return send(res, 200, adminState(user));
      if (req.method === "GET" && p === "/api/events") {
        openStream(req, res);
        adminStreams.add(res);
        req.on("close", () => adminStreams.delete(res));
        return;
      }

      let m;
      // Settings
      if (req.method === "GET" && p === "/api/settings") return send(res, 200, settingsInfo(user));
      if (req.method === "POST" && (m = /^\/api\/settings\/test\/([a-zA-Z]{1,20})$/.exec(p))) {
        if (!conn.SERVICES[m[1]]) throw err(404, "Unknown connection");
        const b = await body(req, 16384);
        if (b.draft && conn.locked(m[1])) throw err(409, "This connection is set on the server");
        return send(res, 200, await testConnection(m[1], b.draft ? conn.draft(m[1], b.draft) : conn.get(m[1]), Boolean(b.draft)));
      }
      // Change a connection: the admin's password again, then a test (unless
      // "save anyway"), then the integration reconnects. Never with the agent token.
      if (req.method === "PUT" && (m = /^\/api\/settings\/connections\/([a-zA-Z]{1,20})$/.exec(p))) {
        const id = m[1];
        if (!conn.SERVICES[id]) throw err(404, "Unknown connection");
        if (user === "agent") throw err(403, "Sign in as the household admin to change connections");
        if (conn.locked(id)) throw err(409, `${conn.SERVICES[id].name} is set on the server (.env / secrets); change it there`);
        const b = await body(req, 16384);
        auth.verifyPassword(b.password, clientIp(req));
        const d = conn.draft(id, b);
        const test = d.url ? await testConnection(id, d, true) : null;
        if (test && !test.ok && !b.force) return send(res, 422, { error: `Not saved: ${test.detail}`, testFailed: true });
        if (conn.save(id, b)) {
          applyConnection(id);
          log(`settings: ${id} ${d.url ? `set to ${d.url}${d.secret ? " with a key" : ""}` : "turned off"}${test && !test.ok ? " (saved although its test failed)" : ""}`);
        }
        return send(res, 200, { ...conn.describe(id), connected: liveStatus(id), test });
      }
      if (req.method === "POST" && p === "/api/account/password") {
        if (user === "agent") throw err(403, "Sign in as the household admin to change the password");
        const b = await body(req, 4096);
        auth.changePassword(b.current, b.next, cookies(req).cv_session, clientIp(req));
        log("account: admin password changed; other sign-ins ended");
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && p === "/api/backup") {
        const name = `coreview-studio-backup-${new Date().toLocaleDateString("sv-SE")}.json`;
        return send(res, 200, JSON.stringify(exportBackup(store.data, { version: VERSION }), null, 1),
          { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"` });
      }
      if (req.method === "POST" && p === "/api/restore") return send(res, 200, restoreBackup(await body(req, 16 * 1024 * 1024)));

      // Screens
      if (req.method === "POST" && p === "/api/screens") {
        const b = await body(req);
        const id = newId("screen");
        const firstView = Object.keys(store.data.views)[0] || null;
        store.update((d) => {
          d.screens[id] = { id, name: cleanName(b.name, "New screen"), viewId: d.views[b.viewId] ? b.viewId : firstView, overlay: { ...DEFAULT_OVERLAY } };
        });
        toAdmins("changed", { what: "screens" });
        return send(res, 200, store.data.screens[id]);
      }
      if ((m = /^\/api\/screens\/(screen-[0-9a-f]{10})$/.exec(p))) {
        const id = m[1];
        if (!store.data.screens[id]) throw err(404, "Unknown screen");
        if (req.method === "PATCH") {
          const b = await body(req);
          let cams = null;
          if (b.overlay) { try { cams = (await overlays.listCameras()).map((c) => c.name); } catch (_e) { cams = null; } }
          store.update((d) => {
            const s = d.screens[id];
            if (b.name !== undefined) s.name = cleanName(b.name, s.name);
            if (b.viewId !== undefined) {
              if (!d.views[b.viewId]) throw err(400, "Unknown view");
              const dev = Object.values(d.devices).find((x) => x.screenId === id);
              const bad = dev ? unsupportedFor(d.views[b.viewId].published, dev.chrome) : [];
              if (bad.length) throw err(409, `This display runs Chrome ${dev.chrome}; the view uses ${WIDGETS[bad[0].type].name}, which needs Chrome ${bad[0].needs}+`);
              s.viewId = b.viewId;
            }
            if (b.overlay !== undefined) s.overlay = cleanOverlay(b.overlay, cams);
            if (b.timer !== undefined) s.timer = cleanTimer(b.timer);
            if (b.nightDim !== undefined) s.nightDim = cleanNightDim(b.nightDim);
            if (b.pin !== undefined) {
              const pin = String(b.pin || "");
              if (pin && !/^\d{4,6}$/.test(pin)) throw err(400, "The PIN is 4 to 6 digits");
              if (!pin) delete s.pin;
              else { const salt = crypto.randomBytes(16).toString("hex"); s.pin = { salt, hash: hashPin(pin, salt), length: pin.length }; }
            }
            if (b.kids !== undefined) s.kids = Boolean(b.kids);
          });
          syncHass();
          pushScreen(id);
          toAdmins("changed", { what: "screens" });
          if (b.kids !== undefined) toScreen(id, "kids", { kids: Boolean(store.data.screens[id].kids) });
          return send(res, 200, publicScreen(store.data.screens[id]));
        }
        if (req.method === "DELETE") {
          const dev = devices.forScreen(id);
          store.update((d) => {
            delete d.screens[id];
            if (dev) delete d.devices[dev.id];
          });
          if (dev) toDevice(dev.id, "unpaired", {});
          toAdmins("changed", { what: "screens" });
          return send(res, 200, { ok: true });
        }
      }
      if (req.method === "POST" && (m = /^\/api\/screens\/(screen-[0-9a-f]{10})\/reload$/.exec(p))) {
        toScreen(m[1], "reload", {});
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/pair") {
        const b = await body(req, 4096);
        let screenId = b.screenId;
        if (!screenId) {
          screenId = newId("screen");
          const firstView = Object.keys(store.data.views)[0] || null;
          const pending = Object.values(store.data.devices).find((x) => !x.screenId && x.code === String(b.code || "").trim().toUpperCase());
          if (!pending) throw err(404, "No display is showing that code");
          store.update((d) => { d.screens[screenId] = { id: screenId, name: cleanName(b.name, "New screen"), viewId: firstView, overlay: { ...DEFAULT_OVERLAY } }; });
        }
        const dev = devices.pair(b.code, screenId);
        const view = screenView(screenId);
        const bad = unsupportedFor(view, dev.chrome);
        toDevice(dev.id, "init", displayPayload(dev));
        toAdmins("changed", { what: "screens" });
        return send(res, 200, { screenId, deviceId: dev.id, warning: bad.length ? `This display runs Chrome ${dev.chrome}; some widgets in its view need a newer display` : null });
      }
      if (req.method === "POST" && (m = /^\/api\/devices\/(dev-[A-Za-z0-9_-]{12})\/unpair$/.exec(p))) {
        devices.unpair(m[1]);
        toDevice(m[1], "unpaired", {});
        toAdmins("changed", { what: "screens" });
        return send(res, 200, { ok: true });
      }

      // Views
      if (req.method === "POST" && p === "/api/views") {
        const b = await body(req);
        const id = newId("view");
        const src = b.copyOf && store.data.views[b.copyOf];
        const view = src ? cleanView(src.draft) : b.aspect ? cleanView({ ...blankView(), aspect: b.aspect }) : blankView();
        store.update((d) => {
          d.views[id] = { id, name: cleanName(b.name, src ? `${src.name} copy` : "New view"), draft: view, published: view, updatedAt: Date.now(), publishedAt: Date.now() };
        });
        toAdmins("changed", { what: "views" });
        return send(res, 200, store.data.views[id]);
      }
      if ((m = /^\/api\/views\/(view-[0-9a-f]{10})(\/draft|\/publish|\/revert)?$/.exec(p))) {
        const id = m[1], action = m[2] || "";
        if (!store.data.views[id]) throw err(404, "Unknown view");
        if (req.method === "PUT" && action === "/draft") {
          const b = await body(req);
          store.update((d) => { d.views[id].draft = cleanView(b.draft); d.views[id].updatedAt = Date.now(); });
          syncHass();
          return send(res, 200, store.data.views[id]);
        }
        if (req.method === "POST" && action === "/publish") {
          const view = store.data.views[id].draft;
          for (const s of screensUsingView(id)) {
            const dev = devices.forScreen(s.id);
            const bad = dev ? unsupportedFor(view, dev.chrome) : [];
            if (bad.length) throw err(409, `${s.name} runs Chrome ${dev.chrome}; ${WIDGETS[bad[0].type].name} needs Chrome ${bad[0].needs}+. Remove it or move that screen to another view.`);
          }
          store.update((d) => { d.views[id].published = view; d.views[id].publishedAt = Date.now(); });
          syncHass();
          for (const s of screensUsingView(id)) pushScreen(s.id);
          toAdmins("changed", { what: "views" });
          return send(res, 200, { ...store.data.views[id], screens: screensUsingView(id).length });
        }
        if (req.method === "POST" && action === "/revert") {
          store.update((d) => { d.views[id].draft = d.views[id].published; d.views[id].updatedAt = Date.now(); });
          return send(res, 200, store.data.views[id]);
        }
        if (req.method === "PATCH" && !action) {
          const b = await body(req);
          store.update((d) => { d.views[id].name = cleanName(b.name, d.views[id].name); });
          toAdmins("changed", { what: "views" });
          return send(res, 200, store.data.views[id]);
        }
        if (req.method === "DELETE" && !action) {
          const users = screensUsingView(id);
          if (users.length) throw err(409, `Used by ${users.map((s) => s.name).join(", ")}; move those screens first`);
          if (Object.keys(store.data.views).length === 1) throw err(409, "Keep at least one view");
          store.update((d) => { delete d.views[id]; });
          toAdmins("changed", { what: "views" });
          return send(res, 200, { ok: true });
        }
      }

      // Drawing boards (editor previews)
      if (req.method === "GET" && (m = /^\/api\/board\/([a-z0-9-]{1,32})\/(notes|play)\.png$/.exec(p))) {
        const img = boards.page(m[1], m[2]);
        return img ? send(res, 200, img, { "Content-Type": "image/png" }) : send(res, 404, { error: "Blank" });
      }
      if (req.method === "GET" && (m = /^\/api\/board\/([a-z0-9-]{1,32})\/fridge$/.exec(p))) return send(res, 200, { fridge: boards.fridge(m[1]) });
      if (req.method === "GET" && (m = /^\/api\/board\/([a-z0-9-]{1,32})\/fridge\/(\d{13}-[0-9a-f]{6,8})\.jpg$/.exec(p))) {
        const img = boards.fridgeImage(m[1], m[2]);
        return img ? send(res, 200, img, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" }) : send(res, 404, { error: "Not found" });
      }

      // Integrations
      if (req.method === "GET" && p === "/api/immich/albums") return send(res, 200, { albums: await immich.listAlbums() });
      if (req.method === "GET" && (m = /^\/api\/immich\/album\/([0-9a-f-]{36})$/.exec(p))) return send(res, 200, { photos: await immich.album(m[1]) });
      if (req.method === "GET" && (m = /^\/api\/(?:immich\/)?photo\/([0-9a-f-]{36})$/.exec(p))) {
        const img = await immich.preview(m[1]);
        if (!img) throw err(404, "Not found");
        return send(res, 200, img.body, { "Content-Type": img.type, "Cache-Control": "private, max-age=86400" });
      }
      if (req.method === "GET" && p === "/api/ha/entities") {
        if (!haUrl() || !haToken()) throw err(503, "Home Assistant isn't connected yet");
        const rsp = await fetch(`${haUrl().replace(/\/+$/, "")}/api/states`, { headers: { Authorization: `Bearer ${haToken()}` }, redirect: "error" });
        if (!rsp.ok) throw err(502, `Home Assistant said ${rsp.status}`);
        const domain = url.searchParams.get("domain");
        const list = (await rsp.json())
          .filter((s) => !domain || s.entity_id.startsWith(domain + "."))
          .map((s) => ({ id: s.entity_id, name: (s.attributes && s.attributes.friendly_name) || s.entity_id, state: s.state, unit: (s.attributes && s.attributes.unit_of_measurement) || "" }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return send(res, 200, { entities: list });
      }
      if (req.method === "GET" && p === "/api/ha/states") {
        const ids = String(url.searchParams.get("ids") || "").split(",").filter((x) => /^[a-z_]+\.[a-z0-9_]+$/.test(x)).slice(0, 100);
        syncHass();
        return send(res, 200, { states: statesFor(ids) });
      }
      if (req.method === "GET" && p === "/api/household") {
        syncHousehold();
        const keys = String(url.searchParams.get("keys") || "").split(",").filter((k) => /^(cal|todo|fc):[a-z_]+\.[a-z0-9_]+$|^cams$|^lab$|^jellyfin$/.test(k)).slice(0, 50);
        return send(res, 200, { data: household.snapshot(keys) });
      }
      if (req.method === "GET" && (m = /^\/api\/person\/(person\.[a-z0-9_]+)$/.exec(p))) return personPicture(res, m[1]);
      if (req.method === "GET" && (m = /^\/api\/frigate\/([\w.-]{1,80})\/(snap|thumb|clip)$/.exec(p))) {
        return frigateMedia(req, res, m[1], m[2], new Set(Object.keys(allNeeds().cameras)));
      }
      if (req.method === "GET" && (m = /^\/api\/jellyfin\/([0-9a-f]{32})\/(poster|backdrop)$/.exec(p))) return jellyfinImage(res, m[1], m[2]);
      if (req.method === "GET" && p === "/api/frigate/cameras") {
        if (!conn.get("frigate").url) throw err(503, "Frigate isn't configured");
        return send(res, 200, { cameras: await overlays.listCameras() });
      }
      if (req.method === "GET" && (m = /^\/api\/camera\/([A-Za-z0-9_-]{1,64})\/live$/.exec(p))) {
        if (await overlays.liveStream(m[1], res, { maxSeconds: 120 })) return;
        throw err(502, "Camera unavailable");
      }
      if (req.method === "GET" && (m = /^\/api\/camera\/([A-Za-z0-9_-]{1,64})$/.exec(p))) {
        const img = await overlays.latestFrame(m[1]);
        if (!img) throw err(502, "Camera unavailable");
        return send(res, 200, img.body, { "Content-Type": img.type });
      }
      // Matrix
      if (req.method === "POST" && (m = /^\/api\/matrix\/([a-z0-9-]{1,64})$/.exec(p))) {
        const cur = store.data.matrix.targets[m[1]];
        if (!cur) throw err(404, "Unknown Matrix");
        const next = cleanTarget(await body(req), cur);
        if (next.live && !cur.live) log(`matrix: ${cur.id} is now driven by Studio`);
        store.update((d) => { d.matrix.targets[cur.id] = next; });
        syncHass();
        matrix.refresh(cur.id, { force: true });
        return send(res, 200, matrix.summary(cur.id));
      }
      if (req.method === "POST" && (m = /^\/api\/matrix\/([a-z0-9-]{1,64})\/control$/.exec(p))) {
        const b = await body(req);
        const r = matrix.control(m[1], b.control, b.value);
        if (!r.ok) throw err(400, r.error);
        return send(res, 200, matrix.summary(m[1]));
      }
      if (req.method === "POST" && (m = /^\/api\/matrix\/([a-z0-9-]{1,64})\/test$/.exec(p))) {
        const b = await body(req);
        if (!["alert", "notification", "marquee"].includes(b.kind)) throw err(400, "Pick alert, notification or marquee");
        if (!matrix.showMessage(m[1], b.kind, 15, b.text)) throw err(404, "Unknown Matrix");
        return send(res, 200, matrix.summary(m[1]));
      }
      // Bedroom matrix
      if (req.method === "POST" && (m = /^\/api\/minimatrix\/([a-z0-9-]{1,64})$/.exec(p))) {
        const cur = store.data.minimatrix.targets[m[1]];
        if (!cur) throw err(404, "Unknown matrix");
        const next = cleanMini(await body(req, 65536), cur);
        if (next.enabled !== cur.enabled) log(`minimatrix: ${cur.id} ${next.enabled ? "driven by Studio" : "left to WLED"}`);
        store.update((d) => { d.minimatrix.targets[cur.id] = next; });
        syncHass();
        minimatrix.refresh(cur.id);
        return send(res, 200, minimatrix.summary(cur.id));
      }
      if (req.method === "POST" && (m = /^\/api\/minimatrix\/([a-z0-9-]{1,64})\/test$/.exec(p))) {
        const b = await body(req);
        if (!store.data.minimatrix.targets[m[1]]) throw err(404, "Unknown matrix");
        try { minimatrix.test(m[1], String(b.kind || "")); } catch (e) { throw err(400, e.message); }
        return send(res, 200, minimatrix.summary(m[1]));
      }
      if (req.method === "POST" && (m = /^\/api\/screens\/(screen-[0-9a-f]{10})\/test-overlay$/.exec(p))) {
        const s = store.data.screens[m[1]];
        if (!s) throw err(404, "Unknown screen");
        const cam = s.overlay.cameras[0];
        if (!cam) throw err(400, "Pick at least one camera first");
        toScreen(s.id, "overlay", { eventId: "test", camera: cam, label: "person", seconds: 15, at: Date.now(), test: true });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && (m = /^\/api\/screens\/(screen-[0-9a-f]{10})\/test-timer$/.exec(p))) {
        const s = store.data.screens[m[1]];
        if (!s) throw err(404, "Unknown screen");
        // A 20-second countdown, then "done" for 8 seconds; the screen drops it by itself.
        const t = Date.now();
        toScreen(s.id, "timers", { serverTime: t, test: true, timers: [{ entity: "test", label: "Test timer", state: "running",
          duration: 20000, endsAt: t + 20000, until: t + 28000 }] });
        return send(res, 200, { ok: true });
      }

      throw err(404, "Not found");
    } catch (e) {
      if (!e.status) log("admin error", p, e.stack || e.message);
      return fail(res, e);
    }
  }

  return {
    store, devices, auth,
    displayHandler: display, adminHandler: admin,
    matrix,
    household,
    start() { syncHass(); overlays.start(); matrix.start(); minimatrix.start(); household.start(); return this; },
    stop() { if (hass) hass.stop(); overlays.stop(); matrix.stop(); minimatrix.stop(); household.stop(); for (const s of displayStreams.values()) for (const r of s) r.end(); for (const r of adminStreams) r.end(); }
  };
}

if (require.main === module) {
  const app = createApp().start();
  const displayPort = Number(process.env.DISPLAY_PORT || 3216);
  const adminPort = Number(process.env.ADMIN_PORT || 3217);
  const host = process.env.LISTEN_HOST || "0.0.0.0";
  http.createServer(app.displayHandler).listen(displayPort, host, () => log(`display on ${host}:${displayPort}`));
  http.createServer(app.adminHandler).listen(adminPort, host, () => log(`studio on ${host}:${adminPort}`));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { app.stop(); process.exit(0); });
}

module.exports = { createApp };
