// The Matrix (CoreView Beacon, an ESP32 HUB75 panel) over MQTT. Studio speaks
// the same protocol V1 did (V1 docs/matrix-mqtt-protocol.md), so the firmware
// and Home Assistant need no changes:
//
//   Studio -> home/signage/matrix/<id>/state    retained desired scene (revision++)
//   Beacon -> home/signage/matrix/<id>/status   retained heartbeat (30 s)
//   Beacon -> home/signage/matrix/<id>/ack      revision applied
//   Beacon -> home/signage/matrix/<id>/control  HA control card request (mode, effect, ...)
//
// What it shows, highest priority first: an HA alert/notification message, a
// running HA timer (countdown, see lib/timers.js), "play" from a touch screen (temporary, see play()), Lights/Music mode from the control card, a live game from the sports
// watchlist, then the clock. A marquee message rides along as the ticker.
// Colours and brightness follow a time-of-day theme schedule.
//
// Until `live` is set Studio only computes scenes (shadow mode) and watches
// what another publisher (V1) sends, so the two can be compared before cutover.
const watchlist = require("./sports-watchlist");
const scoreboard = require("../public/scoreboard");
const { createLogos } = require("./logos");
const { cleanTimer } = require("./timers");

// The last five arrived with Beacon 2.0 firmware (2026-10-10).
const EFFECTS = ["scanner", "bouncing_text", "rainbow_waves", "aurora", "digital_rain", "fire", "twinkle", "color_vortex", "confetti", "starfield", "plasma",
  "fireworks", "lava", "life", "ripples", "pong"];
const PALETTES = ["neon", "ocean", "sunset", "forest", "party"];
const AUDIO_MODES = ["pulse_rings", "orbit", "waterfall", "bars", "ridgeline", "inferno", "warp", "mix"];
const FEATURES = ["clock", "status", "notification", "ticker", "icons", "music", "localaudio"];
const ICONS = ["", "info", "warning", "success", "door", "lock", "motion", "water", "fire"];
const SEVERITIES = ["info", "success", "warning", "critical"];
const STALE_MS = 90000; // two missed 30 s heartbeats

// Play (the House Board's Matrix sheet): a sign in one of these colours, a
// word that bounces or gets scanned in a palette, or one of the effects.
const PLAY_COLORS = ["#ffffff", "#ff2a2a", "#ff8a00", "#ffe100", "#2aff4a", "#00d8ff", "#3a6bff", "#b44bff", "#ff4fc3"];
const PLAY_STYLES = ["sign", "bounce", "scanner", "effect"];
const PLAY_BRIGHTNESS = { dim: 24, bright: 140 }; // of 255; anything else follows the theme
const HEX = /^#[0-9a-f]{6}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;

const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const word = (v) => String(v || "").trim().split(/\s+/)[0].slice(0, 16);
const text = (v, max) => String(v == null ? "" : v).slice(0, max);

function cleanTheme(t) {
  const m = t && typeof t === "object" ? t : {};
  const c = (v, d) => (HEX.test(String(v)) ? String(v).toLowerCase() : d);
  return {
    at: TIME.test(m.at) ? m.at : "00:00",
    name: text(m.name || "Theme", 40),
    background: c(m.background, "#000000"),
    primary: c(m.primary, "#e6e8ed"),
    secondary: c(m.secondary, "#0080ff"),
    accent: c(m.accent, "#ffb000"),
    critical: c(m.critical, "#ff2000"),
    effectPalette: PALETTES.includes(m.effectPalette) ? m.effectPalette : "neon",
    brightness: num(m.brightness, 1, 255, 64)
  };
}

// Same rules as V1 normalizeMatrixControlState; brightness null = follow the theme.
function cleanControls(v) {
  const c = v && typeof v === "object" ? v : {};
  const pct = (raw, d) => (raw === null || raw === undefined || raw === "" ? d : num(raw, 1, 100, d));
  return {
    mode: ["display", "lights", "music"].includes(c.mode) ? c.mode : "display",
    effect: EFFECTS.includes(c.effect) ? c.effect : "scanner",
    palette: PALETTES.includes(c.palette) ? c.palette : null,
    brightness: pct(c.brightness, null),
    speed: pct(c.speed, 35),
    intensity: pct(c.intensity, 60),
    audioMode: AUDIO_MODES.includes(c.audioMode) ? c.audioMode : "pulse_rings",
    scannerText: word(c.scannerText),
    bouncingText: word(c.bouncingText)
  };
}

// The panel's pixel font is printable ASCII; emoji and smart quotes would draw as nothing.
const ascii = (v, max) => String(v == null ? "" : v).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

// One play request from a screen. Returns null when there is nothing to show.
function cleanPlay(v) {
  const p = v && typeof v === "object" ? v : {};
  const style = PLAY_STYLES.includes(p.style) ? p.style : "sign";
  const out = {
    style,
    line1: ascii(p.line1, style === "sign" ? 60 : 12),
    line2: style === "sign" ? ascii(p.line2, 60) : "",
    color: PLAY_COLORS.includes(String(p.color).toLowerCase()) ? String(p.color).toLowerCase() : PLAY_COLORS[0],
    effect: EFFECTS.includes(p.effect) ? p.effect : "rainbow_waves",
    palette: PALETTES.includes(p.palette) ? p.palette : "party",
    brightness: Object.prototype.hasOwnProperty.call(PLAY_BRIGHTNESS, p.brightness) ? p.brightness : "normal"
  };
  if (style === "effect") { out.line1 = ""; if (out.effect === "scanner" || out.effect === "bouncing_text") out.effect = "rainbow_waves"; }
  else if (!out.line1 && !out.line2) return null;
  if (style === "sign" && !out.line1) { out.line1 = out.line2; out.line2 = ""; }
  return out;
}
function playScene(p) {
  if (p.style === "sign") return { kind: "message", severity: "info", title: p.line1, detail: p.line2, icon: "", flashBorder: false, ticker: null };
  const effect = p.style === "bounce" ? "bouncing_text" : p.style === "scanner" ? "scanner" : p.effect;
  return { kind: "effect", effect, palette: p.palette, speed: 40, intensity: 80, text: p.line1, title: p.line1 || "HELLO", ticker: null };
}

// A kitchen timer on the panel: scene kind `countdown` (Beacon firmware
// 2.1+). The Beacon counts down from `endsAt` (epoch seconds) on its own SNTP
// clock, so the scene only changes on start/pause/finish. Older firmware draws
// unknown kinds as title + detail, so `detail` says the same in words.
function pickTimer(list) {
  const rank = (x) => (x.state === "done" ? 0 : x.state === "running" ? 1 : 2);
  return [...(list || [])].sort((a, b) => rank(a) - rank(b) || (a.endsAt || 0) - (b.endsAt || 0))[0] || null;
}
function clockText(ms) {
  const d = new Date(ms), hr = d.getHours() % 12 || 12;
  return `${hr}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
}
function leftText(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
function countdownScene(tm) {
  const scene = { kind: "countdown", state: tm.state, title: ascii(tm.label, 24).toUpperCase() || "TIMER", ticker: null };
  if (tm.duration) scene.duration = Math.round(tm.duration / 1000);
  if (tm.state === "running") { scene.endsAt = Math.round(tm.endsAt / 1000); scene.detail = `DONE AT ${clockText(tm.endsAt)}`; }
  else if (tm.state === "paused") { scene.remaining = Math.ceil(tm.remaining / 1000); scene.detail = `PAUSED ${leftText(tm.remaining)}`; }
  else scene.detail = "DONE!";
  return scene;
}

function cleanMessage(m, d) {
  const o = m && typeof m === "object" ? m : {};
  return {
    entity: ENTITY.test(String(o.entity || "")) ? o.entity : d.entity,
    seconds: num(o.seconds, 5, 3600, d.seconds),
    cooldown: num(o.cooldown, 0, 3600, d.cooldown),
    severity: SEVERITIES.includes(o.severity) ? o.severity : d.severity,
    icon: ICONS.includes(o.icon) ? o.icon : d.icon,
    flashBorder: o.flashBorder === undefined ? d.flashBorder : o.flashBorder === true
  };
}

const MESSAGE_DEFAULTS = {
  alert: { entity: "input_text.coreview_alert_text", seconds: 90, cooldown: 30, severity: "critical", icon: "warning", flashBorder: true },
  notification: { entity: "input_text.coreview_notification_text", seconds: 60, cooldown: 30, severity: "warning", icon: "info", flashBorder: false },
  marquee: { entity: "input_text.coreview_marquee_text", seconds: 110, cooldown: 30 }
};

// The Beacon as V1 had it configured on 2026-10-09 (V1 DB: matrix_targets,
// view screen-kitchen-sign, theme rules, banners, sports_watchlist).
const BEACON_DEFAULTS = {
  id: "coreview-beacon",
  name: "Kitchen Matrix",
  width: 96, height: 32, colorDepth: 4, rotation: 0,
  features: ["clock", "status", "notification", "ticker", "icons"],
  clockTitle: "Out:{{sensor.openweathermap_temperature.state | round(0)}}",
  themes: [
    { at: "06:00", name: "Day", background: "#000000", primary: "#ae00ff", secondary: "#fbff00", accent: "#ffb000", critical: "#ff2000", effectPalette: "neon", brightness: 64 },
    { at: "17:00", name: "Evening", background: "#000000", primary: "#ffffff", secondary: "#0080ff", accent: "#ffb000", critical: "#ff2000", effectPalette: "neon", brightness: 64 },
    { at: "20:30", name: "Overnight", background: "#000000", primary: "#ff0000", secondary: "#ff0000", accent: "#ffb000", critical: "#ffffff", effectPalette: "neon", brightness: 10 }
  ],
  sports: {
    mode: "auto", pinnedEntityId: "",
    // Add Team Tracker sensors (sensor.<league>_<team>) in Studio's Matrix settings.
    teams: [],
    scoreboard: { tickerSpeed: 9, leftColor: "#63D44D", rightColor: "#FFAD21" }
  },
  controls: { mode: "display", effect: "fire", palette: "neon", brightness: 20, speed: 16, intensity: 62, audioMode: "pulse_rings", scannerText: "COREVIEW", bouncingText: "COREVIEW" }
};

// Validate a whole target. `existing` supplies fields an edit leaves out.
function cleanTarget(input, existing) {
  const base = existing || {};
  const o = { ...base, ...(input && typeof input === "object" ? input : {}) };
  const themes = (Array.isArray(o.themes) ? o.themes : []).slice(0, 12).map(cleanTheme);
  themes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const sp = o.sports && typeof o.sports === "object" ? o.sports : {};
  const sb = sp.scoreboard && typeof sp.scoreboard === "object" ? sp.scoreboard : {};
  const sports = watchlist.normalize({ mode: sp.mode, pinnedEntityId: sp.pinnedEntityId, teams: sp.teams });
  const msgs = o.messages && typeof o.messages === "object" ? o.messages : {};
  return {
    id: String(base.id || o.id),
    name: text(o.name || "Matrix", 60),
    width: num(o.width, 8, 512, 96),
    height: num(o.height, 8, 256, 32),
    colorDepth: num(o.colorDepth, 1, 24, 4),
    rotation: [0, 90, 180, 270].includes(Number(o.rotation)) ? Number(o.rotation) : 0,
    features: (Array.isArray(o.features) ? o.features : []).filter((f) => FEATURES.includes(f)),
    live: o.live === true,
    clockTitle: text(o.clockTitle, 200),
    themes: themes.length ? themes : [cleanTheme({ at: "00:00", name: "Default" })],
    messages: {
      alert: cleanMessage(msgs.alert, MESSAGE_DEFAULTS.alert),
      notification: cleanMessage(msgs.notification, MESSAGE_DEFAULTS.notification),
      marquee: cleanMessage(msgs.marquee, MESSAGE_DEFAULTS.marquee)
    },
    sports: {
      mode: sports.mode, pinnedEntityId: sports.pinnedEntityId, teams: sports.teams,
      scoreboard: {
        tickerSpeed: num(sb.tickerSpeed, 0, 40, 9),
        leftColor: HEX.test(String(sb.leftColor)) ? sb.leftColor : "#63D44D",
        rightColor: HEX.test(String(sb.rightColor)) ? sb.rightColor : "#FFAD21"
      }
    },
    controls: cleanControls(o.controls),
    timer: cleanTimer(o.timer),
    revision: num(base.revision, 0, Number.MAX_SAFE_INTEGER, 0),
    sportsSelection: base.sportsSelection || null
  };
}

// V1's template subset: {{domain.object.state}} / {{...attributes.x}} with an optional | round(n).
function renderTemplate(source, states) {
  const s = String(source || "");
  if (!s.includes("{{")) return s;
  return s.replace(/\{\{\s*([a-z0-9_]+\.[a-z0-9_]+)\.(state|attributes(?:\.[a-z0-9_]+)*)(?:\s*\|\s*round\(\s*(\d+)\s*\))?\s*\}\}/gi,
    (_m, id, p, digits) => {
      const e = states[String(id).toLowerCase()];
      let v = "";
      if (e) {
        if (p.toLowerCase() === "state") v = e.state;
        else {
          v = e.attributes;
          for (const k of p.toLowerCase().split(".").slice(1)) v = v && typeof v === "object" ? v[k] : undefined;
        }
      }
      if (v === undefined || v === null) v = "";
      if (digits === undefined || v === "" || !Number.isFinite(Number(v))) return String(v);
      const d = Math.min(6, Number(digits)), f = 10 ** d;
      const r = Math.round(Number(v) * f) / f;
      return d > 0 ? r.toFixed(d) : String(r);
    });
}
const templateEntities = (s) => [...String(s || "").matchAll(/\{\{\s*([a-z0-9_]+\.[a-z0-9_]+)\./gi)].map((m) => m[1].toLowerCase());

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
// The latest theme whose start time has passed; before the first one, yesterday's last.
function themeAt(themes, date) {
  const m = date.getHours() * 60 + date.getMinutes();
  let pick = themes[themes.length - 1];
  for (const t of themes) if (toMin(t.at) <= m) pick = t;
  return pick;
}

// Scene for a target at one moment. `rt` holds the transient message state.
function compileScene(target, states, rt, now, logoFor = () => null, timerList = []) {
  // Message text is captured when the trigger fires (as V1 did), so HA's
  // "clear the helper after display" automations don't cut a message short.
  const mq = rt.marquee;
  const ticker = mq && now < mq.until && mq.text ? { message: mq.text } : null;
  const b = rt.banner;
  if (b && now < b.until && b.text) {
    const m = target.messages[b.kind];
    return { kind: "notification", severity: m.severity, title: b.text, detail: "", icon: m.icon, flashBorder: m.flashBorder, ticker };
  }
  const tm = pickTimer(timerList);
  if (tm) return countdownScene(tm);
  if (rt.play && now < rt.play.until) return playScene(rt.play.spec);
  const c = target.controls;
  if (c.mode === "lights") {
    const word = c.effect === "scanner" ? c.scannerText : c.effect === "bouncing_text" ? c.bouncingText : "";
    const theme = themeAt(target.themes, new Date(now));
    return { kind: "effect", effect: c.effect, palette: c.palette || theme.effectPalette, speed: c.speed, intensity: c.intensity,
      text: word, title: word || "COREVIEW", ticker };
  }
  if (c.mode === "music") {
    const palette = c.palette || themeAt(target.themes, new Date(now)).effectPalette;
    return { kind: "music", title: "VIBES", detail: "", mode: `local_${c.audioMode}`, palette, visualizer: {}, ticker };
  }
  const sel = target.sportsSelection;
  if (sel && sel.entityId && target.width === 96 && target.height === 32) {
    const entity = states[sel.entityId];
    const others = watchlist.otherGames(target.sports, entityList(states, target.sports.teams), sel.entityId);
    const a = (entity && entity.attributes) || {};
    const own = [[a.event_name, a.down_distance_text || a.last_play].filter(Boolean).join("  ")].filter(Boolean);
    const widget = { ...target.sports.scoreboard, entityId: sel.entityId, tickerEntries: [...others, ...own] };
    return scoreboard.compile(widget, entity ? { entityId: sel.entityId, ...entity } : null, (x) => x, ticker ? ticker.message : "", logoFor);
  }
  return { kind: "clock", title: renderTemplate(target.clockTitle, states) || target.name, ticker };
}

// HA states in the shape V1's watchlist expects ({ entityId, state, attributes, lastChangedAt }).
function entityList(states, teams) {
  return teams.map((t) => (states[t.entityId] ? { entityId: t.entityId, state: states[t.entityId].state,
    attributes: states[t.entityId].attributes || {}, lastChangedAt: states[t.entityId].last_changed } : null)).filter(Boolean);
}

// The retained state payload, field for field as V1 publishMatrixRuntime built it.
// `play` (optional) is an active play spec: its colour and brightness win over the theme's.
function buildPayload(target, scene, now, play) {
  const t = themeAt(target.themes, new Date(now));
  const theme = { background: t.background, primary: t.primary, secondary: t.secondary, accent: t.accent,
    critical: t.critical, effectPalette: t.effectPalette, brightness: t.brightness };
  const c = target.controls;
  if (c.brightness !== null) theme.brightness = Math.round(c.brightness * 255 / 100);
  if (play && scene.kind === "message") theme.primary = play.color;
  if (play && PLAY_BRIGHTNESS[play.brightness]) theme.brightness = PLAY_BRIGHTNESS[play.brightness];
  return {
    schema: "coreview.matrix.state.v1",
    target: target.id,
    revision: target.revision,
    issuedAt: new Date(now).toISOString(),
    display: { width: target.width, height: target.height, colorDepth: target.colorDepth, rotation: target.rotation,
      features: target.features, controls: c },
    theme,
    controls: c,
    scene
  };
}

// One control-card request (V1 applyMatrixControl). Returns { ok, controls } or { ok:false, error }.
function applyControl(controls, control, value) {
  const key = String(control || "").trim().toLowerCase();
  const next = { ...controls };
  let v = String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, "_");
  if (key === "effect" && v === "stars") v = "starfield"; // ESPHome's label for it
  if (key === "effect" && v === "lava_lamp") v = "lava";
  if (key === "audio_mode" && v === "spectrum_bars") v = "pulse_rings";
  if (key === "mode") { if (!["display", "lights", "music"].includes(v)) return { ok: false, error: "unsupported Matrix mode" }; next.mode = v; }
  else if (key === "effect") { if (!EFFECTS.includes(v)) return { ok: false, error: "unsupported Matrix effect" }; next.effect = v; }
  else if (key === "palette") { if (!PALETTES.includes(v)) return { ok: false, error: "unsupported Matrix palette" }; next.palette = v; }
  else if (key === "audio_mode") { if (!AUDIO_MODES.includes(v)) return { ok: false, error: "unsupported Matrix audio mode" }; next.audioMode = v; }
  else if (key === "scanner_text") next.scannerText = word(value);
  else if (key === "bouncing_text") next.bouncingText = word(value);
  else if (["brightness", "speed", "intensity"].includes(key)) {
    if (!Number.isFinite(Number(value))) return { ok: false, error: `Matrix ${key} must be numeric` };
    next[key] = num(value, 1, 100, 50);
  } else return { ok: false, error: "unsupported Matrix control" };
  return { ok: true, controls: cleanControls(next) };
}

function createMatrix({ store, mqtt, topicRoot = "home/signage", states = () => ({}), onChange = () => {}, log = () => {},
  now = Date.now, tickMs = 15000, logos = null, timers = null }) {
  const rt = {}; // id -> { banner, marquee, lastFired: {kind: ms}, status, ack, observed, scene, signature }
  const r = (id) => (rt[id] = rt[id] || { banner: null, marquee: null, lastFired: {}, status: null, ack: null, observed: null, scene: null, signature: "" });
  const targets = () => (store.data.matrix && store.data.matrix.targets) || {};
  const topic = (id, ch) => `${topicRoot}/matrix/${id}/${ch}`;
  let ticker = null;
  // Restore the scene the moment a message ends instead of on the next tick.
  function expireAt(id, until) {
    const t = setTimeout(() => refresh(id), Math.max(0, until - now()) + 50);
    if (t.unref) t.unref();
  }
  // Team logos arrive asynchronously; recompute every target when one lands.
  const logoCache = logos || createLogos({ onReady: () => refreshAll(), log });
  const ours = new Set(); // "id:revision" we published, to tell our retained echo from another publisher

  function entities() {
    const set = new Set();
    for (const t of Object.values(targets())) {
      for (const e of templateEntities(t.clockTitle)) set.add(e);
      for (const k of ["alert", "notification", "marquee"]) set.add(t.messages[k].entity);
      for (const team of t.sports.teams) set.add(team.entityId);
      if (t.timer && t.timer.enabled) for (const e of t.timer.entities) set.add(e);
    }
    return [...set].sort();
  }

  function updateSports(t) {
    if (!t.sports.teams.length) return;
    const prev = t.sportsSelection || {};
    const sel = watchlist.select(t.sports, entityList(states(), t.sports.teams), prev, now());
    if (JSON.stringify(sel) !== JSON.stringify(prev)) {
      store.update((d) => { d.matrix.targets[t.id].sportsSelection = sel; });
    }
  }

  // Recompute a target's scene; publish it when it changed and Studio owns the Matrix.
  function refresh(id, { force = false } = {}) {
    const t = targets()[id];
    if (!t) return;
    updateSports(t);
    const st = r(id);
    const at = now();
    const timerList = timers ? timers.list(t.timer) : [];
    // "Done" ends by itself: come back when it does.
    for (const x of timerList) if (x.until && st.timerUntil !== x.until) { st.timerUntil = x.until; expireAt(id, x.until); }
    const scene = compileScene(targets()[id], states(), st, at, logoCache.get, timerList);
    const playing = st.play && at < st.play.until && scene.kind !== "notification" ? st.play.spec : null;
    if (st.play && at >= st.play.until) st.play = null;
    const draft = buildPayload(targets()[id], scene, at, playing);
    const signature = JSON.stringify({ display: draft.display, theme: draft.theme, scene });
    st.scene = scene;
    st.preview = draft;
    if (!force && signature === st.signature) return;
    st.signature = signature;
    if (targets()[id].live && mqtt && mqtt.connected) {
      const revision = store.update((d) => (d.matrix.targets[id].revision += 1));
      const payload = { ...draft, revision };
      ours.add(`${id}:${revision}`);
      if (ours.size > 50) ours.delete(ours.values().next().value);
      mqtt.publish(topic(id, "state"), JSON.stringify(payload), { qos: 1, retain: true });
      st.published = { revision, at };
    } else if (targets()[id].live) {
      st.signature = ""; // not sent: try again on reconnect
    }
    onChange(id, summary(id));
  }
  const refreshAll = (opts) => { for (const id of Object.keys(targets())) refresh(id, opts); };

  // HA changed some entities: fire message triggers (state changes only, like V1), then recompute.
  // The first value seen for a helper (Studio start, HA reconnect) never fires.
  const lastValue = {};
  function onStates(ids) {
    const changed = new Set(ids);
    const at = now();
    const previous = {};
    for (const id of ids) {
      previous[id] = lastValue[id];
      const s = states()[id];
      lastValue[id] = s ? String(s.state || "") : undefined;
    }
    for (const t of Object.values(targets())) {
      const st = r(t.id);
      for (const kind of ["alert", "notification", "marquee"]) {
        const m = t.messages[kind];
        if (!changed.has(m.entity)) continue;
        const cur = String((states()[m.entity] || {}).state || "");
        if (previous[m.entity] === undefined || previous[m.entity] === cur) continue;
        if (kind !== "marquee" && !cur.trim()) continue; // V1: alert/notification fire on "not empty"
        if (m.cooldown > 0 && at - (st.lastFired[kind] || 0) < m.cooldown * 1000) continue;
        st.lastFired[kind] = at;
        // The marquee fires on any change, so HA clearing it ends the ticker (V1 rule "changes").
        const msg = ["unknown", "unavailable"].includes(cur.trim()) ? "" : cur.trim().slice(0, 255);
        if (kind === "marquee") st.marquee = { text: msg, until: at + m.seconds * 1000 };
        else st.banner = { kind, text: msg, until: at + m.seconds * 1000 };
        expireAt(t.id, at + m.seconds * 1000);
      }
      refresh(t.id);
    }
  }

  // Push a message by hand (Studio's "Test" buttons); same path as the HA helper.
  function showMessage(id, kind, seconds, message) {
    const t = targets()[id];
    if (!t || !t.messages[kind]) return false;
    const st = r(id);
    const until = now() + (seconds || t.messages[kind].seconds) * 1000;
    const msg = String(message || "").trim().slice(0, 255) || `Test ${kind}`;
    if (kind === "marquee") st.marquee = { text: msg, until };
    else st.banner = { kind, text: msg, until };
    expireAt(id, until);
    refresh(id);
    return true;
  }

  // Someone is playing with the Matrix from a screen: show `spec` until nobody
  // has touched it for `idleMs`, then the regular program returns. Every new
  // request restarts the clock. Not saved: a restart also ends it.
  function play(id, spec, idleMs) {
    const t = targets()[id];
    if (!t) return { ok: false, error: "unknown Matrix target" };
    const st = r(id);
    const clean = cleanPlay(spec);
    if (!clean) return { ok: false, error: "Type something first" };
    const until = now() + Math.max(60000, Math.min(3600000, Number(idleMs) || 600000));
    st.play = { spec: clean, until };
    if (st.playTimer) clearTimeout(st.playTimer);
    st.playTimer = setTimeout(() => { st.playTimer = null; refresh(id); }, until - now() + 50);
    if (st.playTimer.unref) st.playTimer.unref();
    refresh(id);
    return { ok: true, until };
  }
  function endPlay(id) {
    const st = r(id);
    if (st.playTimer) { clearTimeout(st.playTimer); st.playTimer = null; }
    st.play = null;
    refresh(id);
    return { ok: true };
  }

  function control(id, name, value) {
    const t = targets()[id];
    if (!t) return { ok: false, error: "unknown Matrix target" };
    const res = applyControl(t.controls, name, value);
    if (!res.ok) return res;
    store.update((d) => { d.matrix.targets[id].controls = res.controls; });
    refresh(id);
    return res;
  }

  function onMessage(tp, payload) {
    const m = tp.match(/^(.*)\/matrix\/([^/]+)\/(state|status|ack|control)$/);
    if (!m || m[1] !== topicRoot || !targets()[m[2]]) return;
    const id = m[2], ch = m[3], st = r(id);
    let body;
    try { body = JSON.parse(payload.toString("utf8")); } catch (_e) { return; }
    if (!body || typeof body !== "object") return;
    if (ch === "state") {
      const rev = Number(body.revision);
      if (!Number.isFinite(rev)) return;
      if (!ours.has(`${id}:${rev}`)) {
        st.observed = { revision: rev, at: now(), payload: body };
        if (targets()[id].live) log(`matrix: ${id} revision ${rev} came from another publisher`);
        // In shadow mode V1 owns the control card: follow its Lights/Music
        // settings so the handover doesn't change what the panel shows.
        else if (body.controls && typeof body.controls === "object") {
          const c = cleanControls(body.controls);
          if (JSON.stringify(c) !== JSON.stringify(targets()[id].controls)) store.update((d) => { d.matrix.targets[id].controls = c; });
        }
        refresh(id);
      }
      // The Beacon ignores older revisions, so never fall behind whatever is retained.
      if (rev > targets()[id].revision) {
        store.update((d) => { d.matrix.targets[id].revision = rev; });
        if (targets()[id].live) refresh(id, { force: true });
      }
    } else if (ch === "status") {
      st.status = { at: now(), online: body.online !== false, width: body.width, height: body.height,
        features: Array.isArray(body.features) ? body.features : [], firmware: body.firmware || body.firmwareVersion || body.version || null,
        claimCode: body.claimCode ? String(body.claimCode) : null };
    } else if (ch === "ack") {
      st.ack = { at: now(), revision: body.revision ?? null, eventId: body.eventId ?? null, ok: body.ok !== false, error: body.error || null };
      if (st.status) st.status.at = now();
    } else if (ch === "control") {
      if (!targets()[id].live) return; // V1 still owns the control card in shadow mode
      const res = control(id, body.control, body.value);
      if (!res.ok) log(`matrix: ${id} control ${String(body.control).slice(0, 32)} refused: ${res.error}`);
      return;
    }
    onChange(id, summary(id));
  }

  function summary(id) {
    const t = targets()[id], st = r(id);
    if (!t) return null;
    const seen = st.status ? st.status.at : 0;
    return {
      ...t,
      online: Boolean(st.status && st.status.online && now() - seen < STALE_MS),
      lastSeen: seen || null,
      status: st.status, ack: st.ack,
      scene: st.scene, preview: st.preview || null, published: st.published || null,
      observed: st.observed ? { revision: st.observed.revision, at: st.observed.at, scene: st.observed.payload.scene,
        theme: st.observed.payload.theme, controls: st.observed.payload.controls } : null,
      message: st.banner && now() < st.banner.until ? { kind: st.banner.kind, until: st.banner.until } : null,
      marquee: st.marquee && now() < st.marquee.until ? { until: st.marquee.until } : null,
      play: st.play && now() < st.play.until ? { until: st.play.until, style: st.play.spec.style } : null,
      mqtt: Boolean(mqtt && mqtt.connected)
    };
  }

  function start() {
    if (mqtt) {
      mqtt.on("message", onMessage);
      mqtt.on("status", (up) => { if (up) refreshAll({ force: true }); for (const id of Object.keys(targets())) onChange(id, summary(id)); });
      for (const ch of ["state", "status", "ack", "control"]) mqtt.subscribe(`${topicRoot}/matrix/+/${ch}`);
      mqtt.start();
    }
    // Theme changes, message expiry and sports final-score windows are time based.
    ticker = setInterval(() => refreshAll(), tickMs);
    if (ticker.unref) ticker.unref();
    refreshAll();
  }
  function stop() { clearInterval(ticker); if (mqtt) mqtt.stop(); }

  return { start, stop, refresh, refreshAll, onStates, showMessage, play, endPlay, control, summary, entities,
    list: () => Object.keys(targets()).map(summary) };
}

module.exports = { createMatrix, cleanTarget, cleanControls, cleanPlay, compileScene, countdownScene, buildPayload, applyControl, renderTemplate,
  themeAt, BEACON_DEFAULTS, EFFECTS, PALETTES, AUDIO_MODES, ICONS, SEVERITIES, PLAY_COLORS };
