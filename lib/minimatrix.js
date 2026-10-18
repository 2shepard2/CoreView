// The WLED panel: a 16x16 WLED matrix that shows home scenes (someone came
// home, a door is open, a person on a camera, dogs need out, laundry done,
// CoreView notifications/alerts). Studio streams frames over DDP only while a
// scene is up; when it stops, WLED's realtime timeout hands the panel back to
// its own effects. Decisions are pure (decide()) so they can be tested.
const dgram = require("node:dgram");
const mini = require("../public/minimatrix");

const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const text = (v, max) => String(v == null ? "" : v).slice(0, max);
const entity = (v) => (/^[a-z_]+\.[a-z0-9_]+$/.test(String(v || "").trim().toLowerCase()) ? String(v).trim().toLowerCase() : "");
const hhmm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
const colour = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : d);
const rows = (v, max, fn) => (Array.isArray(v) ? v : []).slice(0, max).map(fn).filter((r) => r.entityId);

// Shipped defaults: off, nothing configured. People, doors, cameras, dogs and
// laundry are added in Studio's settings for the panel.
const BEDROOM_DEFAULTS = {
  id: "bedroom-matrix", name: "WLED panel", host: "", enabled: false, brightness: 100,
  rotate: 0, flipX: false, flipY: false,
  quiet: { enabled: true, start: "21:00", end: "06:00", dim: 40 },
  arrivalSeconds: 30, doorMaxMinutes: 15, cameraMinSeconds: 20,
  people: [], doors: [], cameras: [],
  dogs: { enabled: false, lastOut: "", minutes: "", from: "07:00", to: "22:00" },
  laundry: { enabled: true, runMinutes: 15, quietMinutes: 12, showMinutes: 120, machines: [] },
  messages: { alert: "input_text.coreview_alert_text", notification: "input_text.coreview_notification_text", alertSeconds: 90, notificationSeconds: 60 }
};

function cleanTarget(input, existing) {
  const base = existing || {};
  const o = { ...base, ...(input && typeof input === "object" ? input : {}) };
  const q = { ...BEDROOM_DEFAULTS.quiet, ...(o.quiet || {}) };
  const dg = { ...BEDROOM_DEFAULTS.dogs, ...(o.dogs || {}) };
  const ld = { ...BEDROOM_DEFAULTS.laundry, ...(o.laundry || {}) };
  const ms = { ...BEDROOM_DEFAULTS.messages, ...(o.messages || {}) };
  return {
    id: String(base.id || o.id || BEDROOM_DEFAULTS.id),
    name: text(o.name || BEDROOM_DEFAULTS.name, 60),
    host: /^[a-z0-9.-]{1,253}$/i.test(String(o.host || "")) ? String(o.host) : "",
    enabled: o.enabled === true,
    brightness: num(o.brightness, 5, 100, 100),
    rotate: [0, 90, 180, 270].includes(Number(o.rotate)) ? Number(o.rotate) : 0,
    flipX: o.flipX === true, flipY: o.flipY === true,
    quiet: { enabled: q.enabled !== false, start: hhmm(q.start, "21:00"), end: hhmm(q.end, "06:00"), dim: num(q.dim, 5, 100, 40) },
    arrivalSeconds: num(o.arrivalSeconds, 5, 600, 30),
    doorMaxMinutes: num(o.doorMaxMinutes, 1, 240, 15),
    cameraMinSeconds: num(o.cameraMinSeconds, 0, 300, 20),
    people: rows(o.people, 12, (p) => ({ entityId: entity(p && p.entityId), label: mini.clean(p && p.label, 4), color: colour(p && p.color, "#ffffff") })),
    doors: rows(o.doors, 12, (d) => ({ entityId: entity(d && d.entityId), kind: d && d.kind === "garage" ? "garage" : "door",
      letter: mini.clean(d && d.letter, d && d.kind === "garage" ? 4 : 1) || "D" })),
    cameras: rows(o.cameras, 16, (c) => ({ entityId: entity(c && c.entityId), label: mini.clean(c && c.label, 4) || "CAM" })),
    dogs: { enabled: dg.enabled !== false, lastOut: entity(dg.lastOut), minutes: entity(dg.minutes), from: hhmm(dg.from, "07:00"), to: hhmm(dg.to, "22:00") },
    laundry: { enabled: ld.enabled !== false, runMinutes: num(ld.runMinutes, 1, 120, 15),
      quietMinutes: num(ld.quietMinutes, 1, 60, 12), showMinutes: num(ld.showMinutes, 5, 720, 120),
      machines: (Array.isArray(ld.machines) ? ld.machines : []).slice(0, 4)
        .map((m) => ({ entity: entity(m && m.entity), kind: m && m.kind === "dryer" ? "dryer" : "washer" })).filter((m) => m.entity) },
    messages: { alert: entity(ms.alert), notification: entity(ms.notification),
      alertSeconds: num(ms.alertSeconds, 5, 3600, 90), notificationSeconds: num(ms.notificationSeconds, 5, 3600, 60) }
  };
}

// Minutes since midnight for a Date in Studio's local time (TZ is set in compose).
const minutes = (d) => d.getHours() * 60 + d.getMinutes();
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
function within(now, start, end) {
  const m = minutes(new Date(now)), a = toMin(start), b = toMin(end);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

// Washer: shaking adds up to a load; a load followed by quiet minutes is done;
// the next bump after that (unloading) or the time limit clears it.
function laundryStep(st, cfg, { on, now }) {
  const s = { phase: "idle", sessionMs: 0, onSince: null, lastActivity: 0, doneAt: null, ...st };
  const quietMs = cfg.quietMinutes * 60000;
  if (on === true && s.onSince === null) {
    if (s.phase === "done" && now - s.doneAt > 120000) { s.phase = "idle"; s.doneAt = null; }
    if (s.phase !== "done" && now - s.lastActivity > quietMs) s.sessionMs = 0;
    s.onSince = now;
  } else if (on === false && s.onSince !== null) {
    s.sessionMs += now - s.onSince;
    s.onSince = null;
    s.lastActivity = now;
  }
  if (s.phase !== "done" && s.onSince === null && s.sessionMs >= cfg.runMinutes * 60000 && now - s.lastActivity >= quietMs) {
    s.phase = "done"; s.doneAt = now; s.sessionMs = 0;
  }
  if (s.phase === "done" && now - s.doneAt > cfg.showMinutes * 60000) { s.phase = "idle"; s.doneAt = null; }
  return s;
}

const PRIORITY = ["alert", "camera", "door", "notification", "dogs", "laundry", "arrival"];

// Which scene to show right now, or null. rt holds the remembered events.
function decide(t, states, rt, now) {
  const st = (id) => states[id];
  const quiet = t.quiet.enabled && within(now, t.quiet.start, t.quiet.end);
  const found = { alert: [], camera: [], door: [], notification: [], dogs: [], laundry: [], arrival: [] };
  for (const k of ["alert", "notification"]) {
    const m = rt.messages[k];
    if (m && now < m.until) found[k].push({ kind: k, text: m.text });
  }
  for (const c of t.cameras) {
    const on = st(c.entityId) && st(c.entityId).state === "on";
    if (on || (rt.cameraUntil[c.entityId] || 0) > now) found.camera.push({ kind: "camera", label: c.label });
  }
  for (const d of t.doors) {
    const e = st(d.entityId);
    if (!e || e.state !== "on") continue;
    const since = Date.parse(e.last_changed || "") || now;
    if (now - since > t.doorMaxMinutes * 60000) continue;
    found.door.push(d.kind === "garage" ? { kind: "garage", label: d.letter } : { kind: "door", letter: d.letter });
  }
  if (t.dogs.enabled && within(now, t.dogs.from, t.dogs.to)) {
    const last = st(t.dogs.lastOut), lim = st(t.dogs.minutes);
    const at = last && last.attributes && Number(last.attributes.timestamp) * 1000;
    const mins = lim ? Number(lim.state) : NaN;
    if (Number.isFinite(at) && at > 0 && Number.isFinite(mins) && now - at >= mins * 60000) found.dogs.push({ kind: "dogs" });
  }
  if (t.laundry.enabled) for (const m of t.laundry.machines) if ((rt.laundry[m.entity] || {}).phase === "done") found.laundry.push({ kind: "laundry", machine: m.kind });
  for (const p of t.people) if ((rt.arrivals[p.entityId] || 0) > now) found.arrival.push({ kind: "arrival", label: p.label, color: p.color });
  for (const k of PRIORITY) {
    if (quiet && k !== "alert" && k !== "camera") continue;
    const list = found[k];
    // Several at once (two doors open): take turns every 4 seconds.
    if (list.length) return { scene: list[Math.floor(now / 4000) % list.length], quiet };
  }
  return { scene: null, quiet };
}

function createMiniMatrix({ store, states = () => ({}), onChange = () => {}, log = () => {}, now = Date.now, socket = null, fps = 12 }) {
  const targets = () => (store.data.minimatrix && store.data.minimatrix.targets) || {};
  const rt = {}; // id -> { messages, arrivals, cameraUntil, laundry, last, test, scene, since, seq, sentAt }
  const r = (id) => (rt[id] = rt[id] || { messages: {}, arrivals: {}, cameraUntil: {}, laundry: {}, last: {}, test: null, scene: null, since: 0, seq: 0, sentAt: 0, quiet: false });
  let sock = socket, timer = null;
  const udp = () => {
    if (!sock) { sock = dgram.createSocket("udp4"); sock.on("error", (e) => log(`minimatrix: udp ${e.message}`)); sock.unref(); }
    return sock;
  };

  function entities() {
    const set = new Set();
    for (const t of Object.values(targets())) {
      for (const p of t.people) set.add(p.entityId);
      for (const d of t.doors) set.add(d.entityId);
      for (const c of t.cameras) set.add(c.entityId);
      for (const e of [t.dogs.lastOut, t.dogs.minutes, t.messages.alert, t.messages.notification]) if (e) set.add(e);
      for (const m of t.laundry.machines) set.add(m.entity);
    }
    return [...set].sort();
  }

  // HA changed: remember events (arrivals, message text, camera hold, washer).
  // The first value seen for an entity (start-up, reconnect) never fires.
  function onStates(ids) {
    const s = states(), at = now();
    for (const t of Object.values(targets())) {
      const x = r(t.id);
      for (const id of ids) {
        const cur = s[id] ? s[id].state : undefined, prev = x.last[id];
        const seen = Object.prototype.hasOwnProperty.call(x.last, id);
        x.last[id] = cur;
        if (!seen || cur === prev) continue;
        const person = t.people.find((p) => p.entityId === id);
        if (person && cur === "home") x.arrivals[id] = at + t.arrivalSeconds * 1000;
        if (t.cameras.some((c) => c.entityId === id) && cur === "on") x.cameraUntil[id] = at + t.cameraMinSeconds * 1000;
        for (const k of ["alert", "notification"]) {
          if (id !== t.messages[k]) continue;
          const msg = String(cur || "").trim();
          if (msg && !["unknown", "unavailable"].includes(msg)) x.messages[k] = { text: msg, until: at + t.messages[k + "Seconds"] * 1000 };
        }
        if (t.laundry.machines.some((m) => m.entity === id) && (cur === "on" || cur === "off")) x.laundry[id] = laundryStep(x.laundry[id], t.laundry, { on: cur === "on", now: at });
      }
    }
    refreshAll();
  }

  function sceneFor(t, at) {
    const x = r(t.id);
    for (const m of t.laundry.machines) x.laundry[m.entity] = laundryStep(x.laundry[m.entity], t.laundry, { now: at });
    if (x.test && at < x.test.until) return { scene: x.test.scene, quiet: false };
    return decide(t, states(), x, at);
  }

  // DDP: 10-byte header (version 1, push flag, RGB 8-bit, data type) + 16*16*3 bytes.
  function frame(t, scene, ms, quiet) {
    const N = mini.N, buf = Buffer.alloc(N * N * 3);
    const k = (t.brightness / 100) * (quiet ? t.quiet.dim / 100 : 1);
    mini.render(scene, ms, (x, y, c) => {
      let px = t.flipX ? N - 1 - x : x, py = t.flipY ? N - 1 - y : y;
      for (let i = 0; i < t.rotate / 90; i++) [px, py] = [N - 1 - py, px];
      const v = parseInt(c.slice(1), 16), o = (py * N + px) * 3;
      // WLED skips gamma for realtime data (no-gc), so apply it here like its effects get.
      const g = (n) => Math.round(255 * Math.pow((n / 255) * k, 2.2));
      buf[o] = g(v >> 16); buf[o + 1] = g((v >> 8) & 255); buf[o + 2] = g(v & 255);
    });
    return buf;
  }
  function send(t, x, data) {
    x.seq = (x.seq % 15) + 1;
    const h = Buffer.from([0x41, x.seq, 0x01, 0x01, 0, 0, 0, 0, (data.length >> 8) & 255, data.length & 255]);
    udp().send(Buffer.concat([h, data]), 4048, t.host);
    x.sentAt = now();
  }

  function refresh(id) {
    const t = targets()[id];
    if (!t) return;
    const x = r(id), at = now();
    const { scene, quiet } = sceneFor(t, at);
    const changed = JSON.stringify(scene) !== JSON.stringify(x.scene) || quiet !== x.quiet;
    if (JSON.stringify(scene) !== JSON.stringify(x.scene)) x.since = at;
    x.scene = scene; x.quiet = quiet;
    if (changed) onChange(id, summary(id));
  }
  const refreshAll = () => { for (const id of Object.keys(targets())) refresh(id); };

  function tick() {
    const at = now();
    for (const t of Object.values(targets())) {
      const x = r(t.id);
      if (Math.floor(at / 1000) !== Math.floor((at - 1000 / fps) / 1000)) refresh(t.id); // re-decide once a second
      const live = t.enabled || (x.test && at < x.test.until);
      if (x.scene && live && t.host) send(t, x, frame(t, x.scene, at - x.since, x.quiet));
    }
  }

  function test(id, kind) {
    const t = targets()[id];
    if (!t) throw new Error("unknown matrix");
    const scene = mini.SAMPLES[kind];
    if (!scene) throw new Error("unknown scene");
    r(id).test = { scene, until: now() + 10000 };
    refresh(id);
  }

  function summary(id) {
    const t = targets()[id], x = r(id);
    return { ...t, scene: x.scene, quietNow: x.quiet, sending: Boolean(x.scene && t.host && (t.enabled || (x.test && now() < x.test.until))),
      laundryNow: Object.fromEntries(t.laundry.machines.map((m) => [m.kind, (x.laundry[m.entity] || {}).phase || "idle"])) };
  }
  const list = () => Object.keys(targets()).map(summary);
  function start() { if (!timer) { timer = setInterval(tick, Math.round(1000 / fps)); if (timer.unref) timer.unref(); } refreshAll(); }
  function stop() { clearInterval(timer); timer = null; }
  return { entities, onStates, refresh, refreshAll, tick, test, summary, list, start, stop, frame: (id, scene, ms) => frame(targets()[id], scene, ms, false) };
}

module.exports = { createMiniMatrix, cleanTarget, decide, laundryStep, within, BEDROOM_DEFAULTS };
