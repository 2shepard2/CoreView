// Camera person overlay: watch Frigate for new events and tell screens to pop
// up that camera for a while. Same rules as V1's two Frigate overlay rules:
// label + camera list, optional required zones per camera, a per-screen
// cooldown, and optional active hours (local time, "06:00"-"20:30").
//
// Reads Frigate's HTTP API (no MQTT login needed). While an overlay is up the
// display refreshes the camera's latest frame through Studio.

const DEFAULT_OVERLAY = {
  enabled: false, labels: ["person"], cameras: [], zones: {}, seconds: 90, cooldown: 45, activeStart: "", activeEnd: ""
};

function cleanOverlay(input, knownCameras) {
  const o = input && typeof input === "object" ? input : {};
  const cams = Array.isArray(o.cameras) ? o.cameras.filter((c) => typeof c === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(c)) : [];
  const zones = {};
  for (const [cam, list] of Object.entries(o.zones && typeof o.zones === "object" ? o.zones : {})) {
    if (!cams.includes(cam) || !Array.isArray(list)) continue;
    const z = list.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 10);
    if (z.length) zones[cam] = z;
  }
  const time = (t) => (typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : "");
  const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const labels = Array.isArray(o.labels) ? o.labels.filter((l) => typeof l === "string" && /^[a-z_]{1,32}$/.test(l)).slice(0, 10) : [];
  return {
    enabled: o.enabled === true,
    labels: labels.length ? labels : ["person"],
    cameras: knownCameras ? cams.filter((c) => knownCameras.includes(c)) : cams,
    zones,
    seconds: num(o.seconds, 10, 600, 90),
    cooldown: num(o.cooldown, 0, 3600, 45),
    activeStart: time(o.activeStart),
    activeEnd: time(o.activeEnd)
  };
}

function minutesOfDay(date) { return date.getHours() * 60 + date.getMinutes(); }
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function activeNow(o, date) {
  if (!o.activeStart || !o.activeEnd) return true;
  const m = minutesOfDay(date), a = toMin(o.activeStart), b = toMin(o.activeEnd);
  return a <= b ? m >= a && m < b : m >= a || m < b; // b < a spans midnight
}

function matches(o, event) {
  if (!o.enabled || !o.cameras.includes(event.camera) || !o.labels.includes(event.label)) return false;
  if (event.false_positive) return false;
  const need = o.zones[event.camera];
  if (need && need.length) {
    const zones = Array.isArray(event.zones) ? event.zones : [];
    if (!need.some((z) => zones.includes(z))) return false;
  }
  return true;
}

function createOverlayWatcher({ url, screens, onOverlay, fetchImpl = fetch, log = () => {}, now = Date.now, pollMs = 3000 }) {
  const root = String(url || "").replace(/\/+$/, "");
  const seen = new Map(); // event id -> first seen (ms)
  const shown = new Map(); // event id -> camera, for snapshot requests
  const lastShown = new Map(); // screen id -> ms
  let after = Math.floor(now() / 1000) - 60;
  let timer = null, cameras = null, failing = false;

  async function fetchEvents(query) {
    const rsp = await fetchImpl(`${root}/api/events?${query}&include_thumbnails=0`);
    if (!rsp.ok) throw new Error(`Frigate events failed (${rsp.status})`);
    return rsp.json();
  }

  async function poll() {
    // Recent events, plus every event still in progress however old it is:
    // a person can enter a required zone long after the event started.
    const [recent, active] = await Promise.all([
      fetchEvents(`after=${after}&limit=50`),
      fetchEvents("in_progress=1&limit=50")
    ]);
    const byId = new Map();
    for (const e of [...recent, ...active]) byId.set(e.id, e);
    const events = [...byId.values()];
    const t = now();
    for (const e of events.sort((a, b) => a.start_time - b.start_time)) {
      if (seen.has(e.id)) continue;
      // An event can start without the zone it later enters (the driveway
      // rule), so in-progress events stay unseen until they match or end.
      let fired = false;
      for (const s of screens()) {
        const o = s.overlay;
        if (!o || !matches(o, e) || !activeNow(o, new Date(t))) continue;
        fired = true;
        if (t - (lastShown.get(s.id) || 0) < o.cooldown * 1000) continue;
        lastShown.set(s.id, t);
        shown.set(e.id, e.camera);
        onOverlay(s.id, { eventId: e.id, camera: e.camera, label: e.label, seconds: o.seconds, at: t });
      }
      if (fired || e.end_time) seen.set(e.id, t);
    }
    // Look back 10 minutes so long in-progress events are re-checked.
    after = Math.floor(t / 1000) - 600;
    for (const [id, at] of seen) if (t - at > 3600 * 1000) { seen.delete(id); shown.delete(id); }
  }

  async function loop() {
    try {
      await poll();
      if (failing) log("frigate: events reachable again");
      failing = false;
    } catch (err) {
      if (!failing) log(`frigate: ${err.message}`);
      failing = true;
    }
    timer = setTimeout(loop, pollMs);
  }

  async function listCameras() {
    if (cameras) return cameras;
    const rsp = await fetchImpl(`${root}/api/config`);
    if (!rsp.ok) throw new Error(`Frigate config failed (${rsp.status})`);
    const cfg = await rsp.json();
    cameras = Object.entries(cfg.cameras || {}).map(([name, c]) => ({
      name, zones: Object.keys((c && c.zones) || {}), enabled: c && c.enabled !== false
    }));
    setTimeout(() => { cameras = null; }, 10 * 60 * 1000).unref?.();
    return cameras;
  }

  async function latestFrame(camera) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(camera)) return null;
    const rsp = await fetchImpl(`${root}/api/${encodeURIComponent(camera)}/latest.jpg?h=540`);
    if (!rsp.ok) return null;
    return { body: Buffer.from(await rsp.arrayBuffer()), type: rsp.headers.get("content-type") || "image/jpeg" };
  }

  // Frigate keeps an event's snapshot up to date while the event runs, and it
  // exists even when the camera stream has gone idle (motion-triggered).
  async function eventSnapshot(eventId, camera) {
    if (shown.get(eventId) !== camera) return null;
    const rsp = await fetchImpl(`${root}/api/events/${encodeURIComponent(eventId)}/snapshot.jpg?bbox=1&h=720`);
    if (!rsp.ok) return null;
    return { body: Buffer.from(await rsp.arrayBuffer()), type: rsp.headers.get("content-type") || "image/jpeg" };
  }

  // Live video for the pop-up, as V1 did it: Frigate's MJPEG stream
  // (multipart/x-mixed-replace) piped into one <img>, which every display
  // browser down to Chrome 44 plays. Ends when the screen hangs up or after
  // maxSeconds, so a forgotten tab can't hold a stream open.
  async function liveStream(camera, res, { maxSeconds = 600 } = {}) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(camera)) return false;
    const ctl = new AbortController();
    const cap = setTimeout(() => ctl.abort(), maxSeconds * 1000);
    const done = () => { clearTimeout(cap); ctl.abort(); };
    res.on("close", done);
    let rsp;
    try {
      rsp = await fetchImpl(`${root}/api/${encodeURIComponent(camera)}?h=720`, { signal: ctl.signal });
    } catch (_e) { done(); return false; }
    const type = rsp.headers.get("content-type") || "";
    if (!rsp.ok || !rsp.body || !/^multipart\//i.test(type)) { done(); return false; }
    res.writeHead(200, {
      "Content-Type": type, "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff"
    });
    const reader = rsp.body.getReader();
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end || res.destroyed) break;
        // Wait for drain or close, then drop both listeners (leaving them piled up
        // close listeners on long streams: MaxListenersExceededWarning).
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => {
            const go = () => { res.off("drain", go); res.off("close", go); r(); };
            res.once("drain", go); res.once("close", go);
          });
        }
      }
    } catch (_e) { /* aborted: screen left or time cap */ }
    done();
    res.end();
    return true;
  }

  return {
    start() { if (root && !timer) loop(); return this; },
    stop() { clearTimeout(timer); timer = null; },
    poll, listCameras, latestFrame, eventSnapshot, liveStream
  };
}

module.exports = { createOverlayWatcher, cleanOverlay, matches, activeNow, DEFAULT_OVERLAY };
