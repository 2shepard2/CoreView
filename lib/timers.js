// Home Assistant timers (timer.*) for the timer pop-up on screens and the
// countdown on the Matrix. V1 showed the timer's `remaining` attribute, which
// HA only updates on pause, so it never counted. Here the end time goes to the
// screen (or the Beacon) and it counts down by itself.
//
// A timer is "running" (active), "paused", or "done" for a while after it
// finished. Cancelling one makes it disappear straight away. HA's
// `last_transition` attribute tells finished from cancelled; without it, a
// timer that goes idle within a few seconds of its end time counts as finished.
const ENTITY = /^timer\.[a-z0-9_]+$/;
const DEFAULT_TIMER = { enabled: false, entities: [], doneSeconds: 60 };

function cleanTimer(input) {
  const o = input && typeof input === "object" ? input : {};
  const list = Array.isArray(o.entities) ? o.entities.filter((e) => typeof e === "string" && ENTITY.test(e)) : [];
  const n = Math.round(Number(o.doneSeconds));
  return {
    enabled: o.enabled === true,
    entities: [...new Set(list)].slice(0, 4),
    doneSeconds: Number.isFinite(n) ? Math.min(600, Math.max(0, n)) : DEFAULT_TIMER.doneSeconds
  };
}

// "1:05:30" (HA's duration/remaining format, maybe with a day part) -> ms.
function durationMs(v) {
  const m = /^(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(v || ""));
  if (!m) return null;
  return (((Number(m[1] || 0) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}

function labelOf(s, entity) {
  const name = s && s.attributes && s.attributes.friendly_name;
  return String(name || entity.slice(6).replace(/_/g, " ")).replace(/\s*\bNFC\b\s*/i, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

function createTimers({ states = () => ({}), now = Date.now } = {}) {
  const last = new Map(); // entity -> last state seen
  const ends = new Map(); // entity -> end time while it ran (idle states drop finishes_at)
  const done = new Map(); // entity -> finished at (ms)

  // HA changed some entities: catch timers that just finished.
  function onStates(ids) {
    for (const id of ids) {
      if (!ENTITY.test(id)) continue;
      const s = states()[id];
      const state = s ? s.state : undefined;
      const prev = last.get(id);
      last.set(id, state);
      const a = (s && s.attributes) || {};
      if (state === "active" || state === "paused") {
        done.delete(id);
        if (state === "active") ends.set(id, Date.parse(a.finishes_at || ""));
        continue;
      }
      if (state !== "idle" || (prev !== "active" && prev !== "paused")) continue;
      const end = ends.get(id);
      const finished = a.last_transition ? a.last_transition === "finished"
        : prev === "active" && Number.isFinite(end) && Math.abs(now() - end) < 5000;
      if (finished) done.set(id, now());
      else done.delete(id);
    }
  }

  // What to show for one timer right now, or null.
  function info(entity, doneSeconds) {
    const s = states()[entity];
    if (!s) return null;
    const a = s.attributes || {};
    const base = { entity, label: labelOf(s, entity), duration: durationMs(a.duration) };
    if (s.state === "active") {
      const endsAt = Date.parse(a.finishes_at || "");
      return Number.isFinite(endsAt) ? { ...base, state: "running", endsAt } : null;
    }
    if (s.state === "paused") {
      const remaining = durationMs(a.remaining);
      return remaining === null ? null : { ...base, state: "paused", remaining };
    }
    const at = done.get(entity);
    if (at && doneSeconds > 0 && now() < at + doneSeconds * 1000) return { ...base, state: "done", doneAt: at, until: at + doneSeconds * 1000 };
    return null;
  }

  function list(cfg) {
    if (!cfg || !cfg.enabled) return [];
    return cfg.entities.map((e) => info(e, cfg.doneSeconds)).filter(Boolean);
  }

  return { onStates, info, list };
}

module.exports = { createTimers, cleanTimer, durationMs, DEFAULT_TIMER };
