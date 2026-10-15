// The Matrix card on the Screens page: a live LED preview of what the panel
// shows, its status, and its settings (clock, themes, messages, sports,
// lights/music controls, and the switch that lets Studio drive the panel).
import { h, api, toast, ago, modal, confirmBox } from "./lib.js";

const SB = window.CoreViewScoreboard; // 5x7 font + the exact scoreboard renderer the firmware mirrors
const W = 96, H = 32;

// ---------- LED preview ----------
// Scoreboards use the firmware-exact renderer; other scenes are a close
// approximation (same font, colours and layout idea, not pixel-exact).
function ledPreview(canvas) {
  const scale = 6;
  canvas.width = W * scale; canvas.height = H * scale;
  const g = canvas.getContext("2d");
  let scene = null, theme = null, t0 = performance.now(), raf = 0;
  const px = new Array(W * H);
  const put = (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = c; };
  const text = (s, x, y, c, scale1 = 1, lo = 0, hi = H) => {
    for (const ch of String(s).toUpperCase()) {
      const cols = SB.font[ch] || SB.font["?"];
      for (let col = 0; col < 5; col++) for (let row = 0; row < 7; row++) if (cols[col] & (1 << (6 - row)))
        for (let dx = 0; dx < scale1; dx++) for (let dy = 0; dy < scale1; dy++) {
          const yy = y + row * scale1 + dy;
          if (yy >= lo && yy < hi) put(x + col * scale1 + dx, yy, c);
        }
      x += 6 * scale1;
    }
  };
  const width = (s, k = 1) => Math.max(0, String(s).length * 6 * k - k);
  const marquee = (s, y, c, ms, speed = 20) => {
    const w = width(s);
    if (w <= W) return text(s, Math.floor((W - w) / 2), y, c);
    const span = w + 24, off = Math.floor(ms * speed / 1000) % span;
    text(s, -off, y, c); text(s, span - off, y, c);
  };
  const PAL = { neon: ["#ff00d4", "#00e5ff", "#7cff00"], ocean: ["#0040ff", "#00b3ff", "#00ffd5"], sunset: ["#ff3d00", "#ff9100", "#ffd600"],
    forest: ["#0b6e00", "#3fbf00", "#b6ff00"], party: ["#ff0040", "#ffe600", "#00a2ff"] };

  function draw(now) {
    const ms = now - t0;
    px.fill(theme ? theme.background : "#000000");
    const c = theme || { primary: "#e6e8ed", secondary: "#0080ff", accent: "#ffb000", critical: "#ff2000" };
    const s = scene || { kind: "clock", title: "" };
    if (s.kind === "scoreboard") {
      SB.render(s, ms, (x, y, col) => put(x, y, col));
    } else if (s.kind === "clock") {
      const d = new Date();
      const hh = d.getHours() % 12 || 12, mm = String(d.getMinutes()).padStart(2, "0");
      const time = `${hh}:${mm}`;
      text(time, Math.floor((W - width(time, 2)) / 2), 1, c.primary, 2);
      if (s.ticker && s.ticker.message) marquee(s.ticker.message, 24, c.accent, ms);
      else marquee(s.title || "", 24, c.secondary, ms);
    } else if (s.kind === "notification") {
      const col = s.severity === "critical" ? c.critical : s.severity === "warning" ? c.accent : c.primary;
      if (s.flashBorder && Math.floor(ms / 400) % 2 === 0) {
        for (let x = 0; x < W; x++) { put(x, 0, c.critical); put(x, H - 1, c.critical); }
        for (let y = 0; y < H; y++) { put(0, y, c.critical); put(W - 1, y, c.critical); }
      }
      marquee(s.title || "", 6, col, ms, 24);
      if (s.ticker && s.ticker.message) marquee(s.ticker.message, 22, c.accent, ms);
    } else if (s.kind === "countdown") {
      // Big digits counting down (the panel does this on its own clock), the timer's name below.
      const left = s.state === "running" ? Math.max(0, s.endsAt * 1000 - Date.now()) : (s.remaining || 0) * 1000;
      const t = Math.ceil(left / 1000), hr = Math.floor(t / 3600), mn = Math.floor((t % 3600) / 60), sc = String(t % 60).padStart(2, "0");
      const done = s.state === "done" || (s.state === "running" && left <= 0);
      const time = done ? "DONE" : hr ? `${hr}:${String(mn).padStart(2, "0")}:${sc}` : `${mn}:${sc}`;
      const k = width(time, 2) <= W ? 2 : 1;
      const blink = done && Math.floor(ms / 500) % 2 === 0;
      if (!blink) text(time, Math.floor((W - width(time, k)) / 2), 2, done ? c.accent : s.state === "paused" ? c.secondary : c.primary, k);
      marquee(s.state === "paused" ? "PAUSED" : s.title || "TIMER", 24, s.state === "paused" ? c.accent : c.secondary, ms);
    } else if (s.kind === "effect") {
      const pal = PAL[s.palette] || PAL.neon;
      for (let i = 0; i < 90; i++) {
        const x = Math.floor((Math.sin(i * 12.9898 + ms / 900) * 43758.5453 % 1 + 1) % 1 * W);
        const y = Math.floor(((i * 7 + ms / (60 - Math.min(50, s.speed || 35) / 2)) % H));
        put(x, H - 1 - y, pal[i % 3]);
      }
      if (s.text) marquee(s.text, 12, c.primary, ms);
    } else if (s.kind === "music") {
      for (let b = 0; b < 12; b++) {
        const hgt = Math.floor((Math.sin(ms / 180 + b) * 0.5 + 0.5) * 22) + 2;
        for (let y = 0; y < hgt; y++) for (let x = 0; x < 6; x++) put(b * 8 + x + 1, H - 1 - y, y > 16 ? c.critical : y > 10 ? c.accent : c.secondary);
      }
    } else {
      marquee(s.title || "UNSUPPORTED", 12, c.secondary, ms);
    }
    // LED look: round dots on black, brightness dimmed like the panel.
    g.fillStyle = "#050505";
    g.fillRect(0, 0, canvas.width, canvas.height);
    const alpha = theme ? Math.max(0.35, Math.min(1, theme.brightness / 120)) : 1;
    g.globalAlpha = alpha;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const col = px[y * W + x];
      if (!col || col === "#000000" || col === "#050605") continue;
      g.fillStyle = col;
      g.beginPath();
      g.arc(x * scale + scale / 2, y * scale + scale / 2, scale * 0.42, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);
  return {
    set(next) { if (JSON.stringify(next.scene) !== JSON.stringify(scene)) t0 = performance.now(); scene = next.scene; theme = next.theme; },
    destroy() { cancelAnimationFrame(raf); }
  };
}

// ---------- card ----------
const describe = (s) => {
  if (!s) return "—";
  if (s.kind === "clock") return `Clock · “${s.title}”${s.ticker ? ` · marquee “${s.ticker.message}”` : ""}`;
  if (s.kind === "notification") return `${s.severity === "critical" ? "Alert" : "Notification"} · “${s.title}”`;
  if (s.kind === "effect") return `Lights · ${s.effect.replace(/_/g, " ")} (${s.palette})`;
  if (s.kind === "music") return `Music · ${String(s.mode).replace(/^local_/, "").replace(/_/g, " ")}`;
  if (s.kind === "countdown") return `Timer · ${s.title} · ${s.state === "running" ? s.detail.toLowerCase() : s.state}`;
  if (s.kind === "scoreboard") return `Game · ${s.homeLabel} ${s.homeScore} – ${s.guestLabel} ${s.guestScore} · ${s.period} ${s.remainingTime}`;
  return s.kind;
};
// Compare what Studio would send with what another publisher (e.g. CoreView V1)
// last sent on the same topic (ignoring revision/time).
function sameAsOther(t) {
  if (!t.observed || !t.preview) return null;
  const strip = (x) => JSON.stringify(x || null);
  return strip(t.observed.scene) === strip(t.preview.scene) && strip(t.observed.theme) === strip(t.preview.theme);
}

export function matrixCard(t, ctx) {
  const canvas = h("canvas.led");
  const led = ledPreview(canvas);
  const status = h("span.badge");
  const who = h("div.small");
  const what = h("div.small.muted");
  const compare = h("div.small");
  const card = h("div.card.matrix-card", {}, [
    h("div.led-wrap", {}, canvas),
    h("div.card-body", {}, [
      h("div.card-title-row", {}, [h("h3", {}, t.name), status]),
      what, who, compare,
      h("div.card-actions", {}, [
        h("button.btn.small", { onclick: () => settingsDialog(card.target, ctx) }, "Settings"),
        h("button.btn.small", { onclick: () => testDialog(card.target) }, "Send a test message"),
        h("button.btn.small", { onclick: () => controlsDialog(card.target, ctx) }, "Lights / music")
      ])
    ])
  ]);
  card.update = (next) => {
    card.target = next;
    led.set({ scene: next.scene, theme: next.preview && next.preview.theme });
    status.className = "badge " + (next.online ? "green" : "amber");
    status.textContent = next.online ? "● Online" : next.lastSeen ? `Offline · seen ${ago(next.lastSeen)}` : (next.mqtt ? "No heartbeat yet" : "MQTT not connected");
    what.textContent = `Showing: ${describe(next.scene)}`;
    who.textContent = next.live
      ? `Studio drives this Matrix (revision ${next.published ? next.published.revision : next.revision}${next.ack ? `, panel confirmed ${ago(next.ack.at)}` : ""}).`
      : "Preview only: Studio isn't driving this Matrix yet (turn it on in Settings).";
    who.className = "small " + (next.live ? "" : "warn");
    const same = next.live ? null : sameAsOther(next);
    compare.textContent = same === null ? "" : same ? "✓ Studio's scene matches what the other publisher is sending" : "≠ Studio's scene differs from the other publisher's right now (see Settings)";
    compare.className = "small " + (same === false ? "warn" : "muted");
  };
  card.destroy = () => led.destroy();
  card.update(t);
  return card;
}

// ---------- dialogs ----------
async function save(t, patch) {
  const next = await api("POST", `/api/matrix/${t.id}`, patch);
  toast("Saved");
  return next;
}

function testDialog(t) {
  const kind = h("select", {}, [["alert", "Alert (red, flashing)"], ["notification", "Notification"], ["marquee", "Marquee (ticker under the clock)"]]
    .map(([v, l]) => h("option", { value: v }, l)));
  const msg = h("input", { value: "Hello from Studio", maxLength: 80 });
  const m = modal(`Test message · ${t.name}`, [
    h("p.muted", {}, t.live ? "Shows on the Matrix for 15 seconds." : "Studio is in shadow mode, so this only changes the preview here, not the panel."),
    h("label.field", {}, ["Kind", kind]), h("label.field", {}, ["Text", msg])
  ], [h("button.btn.primary", { onclick: async () => {
    try { await api("POST", `/api/matrix/${t.id}/test`, { kind: kind.value, text: msg.value }); toast("Sent for 15 seconds"); m.close(); }
    catch (ex) { toast(ex.message, "error"); }
  } }, "Send")]);
}

function controlsDialog(t, ctx) {
  const o = ctx.state.matrixOptions;
  const c = t.controls;
  const sel = (name, list, cur) => h("select", { onchange: (e) => send(name, e.target.value) },
    list.map((v) => h("option", { value: v, selected: v === cur }, v.replace(/_/g, " "))));
  const range = (name, cur) => h("input", { type: "range", min: 1, max: 100, value: cur ?? 50, onchange: (e) => send(name, e.target.value) });
  async function send(control, value) {
    try { await api("POST", `/api/matrix/${t.id}/control`, { control, value }); } catch (ex) { toast(ex.message, "error"); }
  }
  if (!t.live) {
    modal(`Lights / music · ${t.name}`, [h("p", {}, "Studio isn't driving this Matrix yet. Turn on \"Studio drives the Matrix\" in Settings to use these controls.")]);
    return;
  }
  modal(`Lights / music · ${t.name}`, [
    h("p.muted", {}, "The same controls as the Matrix card in Home Assistant. Display = clock, messages and games."),
    h("label.field", {}, ["Mode", sel("mode", ["display", "lights", "music"], c.mode)]),
    h("div.row2", {}, [h("label.field", {}, ["Effect", sel("effect", o.effects, c.effect)]), h("label.field", {}, ["Palette", sel("palette", o.palettes, c.palette || "neon")])]),
    h("label.field", {}, ["Brightness", range("brightness", c.brightness)]),
    h("div.row2", {}, [h("label.field", {}, ["Speed", range("speed", c.speed)]), h("label.field", {}, ["Intensity", range("intensity", c.intensity)])]),
    h("label.field", {}, ["Music style", sel("audio_mode", o.audioModes, c.audioMode)])
  ]);
}

function settingsDialog(t, ctx) {
  const name = h("input", { value: t.name });
  const clock = h("input", { value: t.clockTitle });
  const themeRows = t.themes.map((th) => {
    const row = {
      at: h("input", { type: "time", value: th.at }), name: h("input", { value: th.name }),
      primary: h("input", { type: "color", value: th.primary }), secondary: h("input", { type: "color", value: th.secondary }),
      accent: h("input", { type: "color", value: th.accent }), critical: h("input", { type: "color", value: th.critical }),
      brightness: h("input", { type: "number", min: 1, max: 255, value: th.brightness }), keep: th
    };
    row.el = h("div.theme-row", {}, [row.at, row.name, row.primary, row.secondary, row.accent, row.critical, row.brightness]);
    return row;
  });
  const msg = (k, label) => {
    const m = t.messages[k];
    const r = { seconds: h("input", { type: "number", min: 5, max: 3600, value: m.seconds }), cooldown: h("input", { type: "number", min: 0, max: 3600, value: m.cooldown }) };
    r.el = h("div.msg-row", {}, [h("div", {}, [h("b", {}, label), h("div.muted.small", {}, m.entity)]),
      h("label.field", {}, ["Show (s)", r.seconds]), h("label.field", {}, ["Cooldown (s)", r.cooldown])]);
    return r;
  };
  const msgs = { alert: msg("alert", "Alert"), notification: msg("notification", "Notification"), marquee: msg("marquee", "Marquee") };
  const sportsMode = h("select", {}, [["auto", "Automatic: show a watched team's live game"], ["pause", "Off"]]
    .map(([v, l]) => h("option", { value: v, selected: t.sports.mode === v }, l)));
  // Watched teams: Team Tracker sensors (sensor.<league>_<team>). Tick to watch, ✕ to remove, add new ones below.
  const teams = [];
  const teamList = h("div.team-list");
  const addTeam = (tm) => {
    const row = { tm, box: h("input", { type: "checkbox", checked: tm.enabled }) };
    row.el = h("label.chip", {}, [row.box, ` ${tm.name} `, h("button.btn.small", { type: "button", title: "Remove", onclick: (e) => {
      e.preventDefault(); teams.splice(teams.indexOf(row), 1); row.el.remove(); } }, "✕")]);
    teams.push(row); teamList.appendChild(row.el);
  };
  t.sports.teams.forEach(addTeam);
  const newEntity = h("input", { placeholder: "sensor.nfl_kansas_city_chiefs" }), newName = h("input", { placeholder: "Chiefs", maxLength: 40 });
  const addRow = h("div.field-row", {}, [h("label.field", {}, ["Team Tracker sensor", newEntity]), h("label.field", {}, ["Name", newName]),
    h("button.btn.small", { type: "button", onclick: () => {
      const id = newEntity.value.trim().toLowerCase();
      if (!/^sensor\.[a-z0-9_]+$/.test(id)) return toast("Enter a sensor entity, e.g. sensor.nfl_kansas_city_chiefs", "error");
      if (teams.some((r) => r.tm.entityId === id)) return toast("Already on the list", "error");
      addTeam({ entityId: id, name: newName.value.trim() || id.replace(/^sensor\./, ""), enabled: true });
      newEntity.value = ""; newName.value = "";
    } }, "+ Add team")]);
  // HA timers (timer.*): a running one replaces the clock with a countdown.
  const tmr = { enabled: false, entities: [], doneSeconds: 60, ...(t.timer || {}) };
  const timerOn = h("input", { type: "checkbox", checked: tmr.enabled });
  const timerDone = h("input", { type: "number", min: 0, max: 600, value: tmr.doneSeconds });
  const timerRows = [];
  let timersLoaded = false; // until the list arrives, saving keeps what's saved
  const timerList = h("div.team-list", {}, h("span.muted.small", {}, "Loading timers…"));
  api("GET", "/api/ha/entities?domain=timer").then(({ entities }) => {
    timersLoaded = true;
    timerList.replaceChildren(...(entities.length ? entities.map((e) => {
      const box = h("input", { type: "checkbox", checked: tmr.entities.includes(e.id) });
      timerRows.push({ id: e.id, box });
      return h("label.chip", {}, [box, ` ${e.name}`]);
    }) : [h("span.muted.small", {}, "No timer helpers in Home Assistant.")]));
  }).catch((ex) => {
    timerList.replaceChildren(h("span.muted.small", {}, `Couldn't load timers: ${ex.message}`));
  });
  const live = h("input", { type: "checkbox", checked: t.live });
  const v1 = t.observed;
  const same = sameAsOther(t);

  const m = modal(`Matrix · ${t.name}`, [
    h("label.field", {}, ["Name", name]),
    h("label.field", {}, ["Clock line (Home Assistant values in {{ }})", clock]),
    h("p.muted.small", {}, "Example: Out:{{sensor.openweathermap_temperature.state | round(0)}}"),
    h("h3.section", {}, "Colour themes by time of day"),
    h("div.theme-head.muted.small", {}, ["Starts", "Name", "Main", "Second", "Accent", "Alert", "Bright (1-255)"].map((x) => h("span", {}, x))),
    ...themeRows.map((r) => r.el),
    h("p.muted.small", {}, t.controls.brightness !== null ? `Note: the Home Assistant brightness slider (${t.controls.brightness}%) currently overrides theme brightness.` : ""),
    h("h3.section", {}, "Messages from Home Assistant"),
    ...Object.values(msgs).map((r) => r.el),
    h("h3.section", {}, "Timers"),
    h("label.check", {}, [timerOn, " Show a countdown while one of these Home Assistant timers runs"]),
    timerList,
    h("label.field", {}, ["Show “DONE” for (seconds, 0 = not at all)", timerDone]),
    h("p.muted.small", {}, "Alerts and notifications still win over the countdown. Needs Beacon firmware 2.1; older firmware shows the end time as text."),
    h("h3.section", {}, "Sports"),
    h("label.field", {}, ["Scoreboard", sportsMode]),
    teamList,
    addRow,
    h("p.muted.small", {}, "Needs the Team Tracker integration (HACS). A watched team's live game replaces the clock."),
    h("h3.section", {}, "Who drives the Matrix"),
    h("label.check.big", {}, [live, " Studio drives the Matrix (stop any other publisher, e.g. CoreView V1, first)"]),
    v1 ? h("div.compare", {}, [
      h("div.small", {}, `Another publisher last sent revision ${v1.revision} (${ago(v1.at)}): ${describe(v1.scene)}`),
      h("div.small", {}, `Studio would send: ${describe(t.scene)}`),
      h(`div.small.${same ? "ok" : "warn"}`, {}, same ? "Scene and colours match." : "Not identical right now: this can be timing (temperature just changed) or a real difference."),
      same ? null : h("details", {}, [h("summary.small", {}, "Show both"), h("pre.small", {}, JSON.stringify({ v1: { scene: v1.scene, theme: v1.theme }, studio: { scene: t.scene, theme: t.preview && t.preview.theme } }, null, 1))])
    ]) : h("p.muted.small", {}, "No other publisher seen on this Matrix's topic.")
  ], [h("button.btn.primary", { onclick: async () => {
    if (live.checked && !t.live && !await confirmBox("Hand the Matrix to Studio?",
      "If something else (e.g. CoreView V1) publishes to this Matrix, stop it first, or both will fight over the panel. Studio continues from the last revision it saw.", "Studio drives it")) return;
    try {
      await save(t, {
        name: name.value, clockTitle: clock.value, live: live.checked,
        themes: themeRows.map((r) => ({ ...r.keep, at: r.at.value, name: r.name.value, primary: r.primary.value, secondary: r.secondary.value,
          accent: r.accent.value, critical: r.critical.value, brightness: Number(r.brightness.value) })),
        messages: Object.fromEntries(Object.entries(msgs).map(([k, r]) => [k, { ...t.messages[k], seconds: Number(r.seconds.value), cooldown: Number(r.cooldown.value) }])),
        sports: { ...t.sports, mode: sportsMode.value, teams: teams.map(({ tm, box }) => ({ ...tm, enabled: box.checked })) },
        timer: { enabled: timerOn.checked, entities: timersLoaded ? timerRows.filter((r) => r.box.checked).map((r) => r.id) : tmr.entities, doneSeconds: Number(timerDone.value) }
      });
      m.close();
    } catch (ex) { toast(ex.message, "error"); }
  } }, "Save")]);
}
