// CoreView Studio: sign-in, the Screens dashboard, the Views list, Settings
// (settings.js), and routing into the editor (editor.js).
import { h, api, toast, ago, modal, confirmBox, previewStage, screenShape, entityIds, loadHousehold } from "./lib.js";
import { openEditor } from "./editor.js";
import { matrixCard } from "./matrix.js";
import { miniCard } from "./minimatrix.js";
import { settingsPage } from "./settings.js";

const app = document.getElementById("app");
const ctx = { state: null, states: {}, data: {}, skew: 0, tzOffsetMin: 0, stages: [], events: null, cameras: null, matrixCards: {}, miniCards: {} };

// ---------- boot ----------
async function boot() {
  const s = await api("GET", "/api/session");
  if (s.setup) return renderSetup();
  if (!s.user) return renderLogin();
  await refresh();
  listen();
  window.addEventListener("hashchange", route);
  route();
}

async function refresh() {
  ctx.state = await api("GET", "/api/state");
  ctx.skew = ctx.state.serverTime - Date.now();
  ctx.tzOffsetMin = ctx.state.tzOffsetMin;
  const views = ctx.state.views.flatMap((v) => [v.published, v.draft]);
  const ids = entityIds(views);
  for (let i = 0; i < ids.length; i += 100) {
    try { Object.assign(ctx.states, (await api("GET", `/api/ha/states?ids=${ids.slice(i, i + 100).join(",")}`)).states); } catch (_e) { /* HA optional */ }
  }
  await loadHousehold(ctx, views);
}

function listen() {
  const es = new EventSource("/api/events");
  ctx.events = es;
  let pending = null;
  const later = () => {
    clearTimeout(pending);
    // Settings isn't redrawn (it would wipe a half-typed password).
    pending = setTimeout(async () => { await refresh(); if (!ctx.editing && !location.hash.startsWith("#/settings")) route(); }, 300);
  };
  es.addEventListener("devices", later);
  es.addEventListener("changed", later);
  // Matrix updates arrive often (heartbeats, temperatures): update the card in place.
  es.addEventListener("matrix", (e) => {
    const t = JSON.parse(e.data);
    if (!t || !ctx.state) return;
    const i = ctx.state.matrix.findIndex((x) => x.id === t.id);
    if (i >= 0) ctx.state.matrix[i] = t; else ctx.state.matrix.push(t);
    if (ctx.matrixCards[t.id]) ctx.matrixCards[t.id].update(t);
  });
  es.addEventListener("minimatrix", (e) => {
    const t = JSON.parse(e.data);
    if (!t || !ctx.state) return;
    const list = ctx.state.minimatrix || (ctx.state.minimatrix = []);
    const i = list.findIndex((x) => x.id === t.id);
    if (i >= 0) list[i] = t; else list.push(t);
    if (ctx.miniCards[t.id]) ctx.miniCards[t.id].update(t);
  });
  es.addEventListener("data", (e) => {
    const changes = JSON.parse(e.data);
    for (const k of Object.keys(changes)) if (changes[k]) ctx.data[k] = changes[k];
    for (const st of ctx.stages) st.setData(changes);
    if (ctx.editing && ctx.editing.data) ctx.editing.data(changes);
  });
  es.addEventListener("states", (e) => {
    const changes = JSON.parse(e.data);
    Object.assign(ctx.states, changes);
    for (const st of ctx.stages) st.setStates(changes);
    if (ctx.editing) ctx.editing.states(changes);
  });
}

function clearStages() {
  for (const st of ctx.stages) st.destroy();
  ctx.stages = [];
  for (const c of Object.values(ctx.matrixCards)) c.destroy();
  ctx.matrixCards = {};
  for (const c of Object.values(ctx.miniCards)) c.destroy();
  ctx.miniCards = {};
}

// ---------- sign-in ----------
function authPage(title, sub, fields, button, submit) {
  const err = h("div.form-error");
  const form = h("form.auth-card", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      const data = Object.fromEntries(new FormData(form));
      try { await submit(data); location.reload(); } catch (ex) { err.textContent = ex.message; }
    }
  }, [
    h("div.brand.big", {}, [h("span.brand-mark", {}, "◆"), " CoreView Studio"]),
    h("h1", {}, title), h("p.muted", {}, sub),
    ...fields.map(([name, label, type]) => h("label.field", {}, [label, h("input", { name, type, required: true, autocomplete: type === "password" ? (name === "password" && title.startsWith("Welcome") ? "new-password" : "current-password") : "username" })])),
    err, h("button.btn.primary.wide", { type: "submit" }, button)
  ]);
  app.replaceChildren(h("div.auth-page", {}, form));
}
function renderSetup() {
  authPage("Welcome", "Create the household sign-in for Studio. You'll use it from any browser at home.",
    [["code", "Setup code (from the secrets/setup_code file)", "text"], ["username", "Username", "text"], ["password", "Password (8+ characters)", "password"]], "Create and sign in",
    (d) => api("POST", "/api/setup", d));
}
function renderLogin() {
  authPage("Sign in", "", [["username", "Username", "text"], ["password", "Password", "password"]], "Sign in",
    (d) => api("POST", "/api/login", d));
}

// ---------- shell + routing ----------
function shell(active, content) {
  const i = ctx.state.integrations;
  const dot = (ok, label) => h("div.integration", {}, [h(`span.dot.${ok ? "on" : "off"}`), label]);
  app.replaceChildren(h("div.shell", {}, [
    h("nav.sidebar", {}, [
      h("div.brand", {}, [h("span.brand-mark", {}, "◆"), " CoreView Studio"]),
      h(`a.nav-item${active === "screens" ? ".active" : ""}`, { href: "#/screens" }, ["🖥 ", "Screens"]),
      h(`a.nav-item${active === "views" ? ".active" : ""}`, { href: "#/views" }, ["🎨 ", "Views"]),
      h(`a.nav-item${active === "settings" ? ".active" : ""}`, { href: "#/settings" }, ["⚙ ", "Settings"]),
      h("div.spacer"),
      h("div.integrations", {}, [
        dot(i.immich, "Immich photos"),
        dot(i.homeAssistant, i.haConfigured ? "Home Assistant" : "Home Assistant (no token yet)"),
        dot(i.frigate, "Frigate cameras")
      ]),
      h("button.btn.ghost.small", { onclick: async () => { await api("POST", "/api/logout"); location.reload(); } }, "Sign out")
    ]),
    h("main.main", {}, content)
  ]));
}

function route() {
  clearStages();
  if (ctx.editing) { ctx.editing.close(); ctx.editing = null; }
  const hash = location.hash || "#/screens";
  let m;
  if ((m = /^#\/edit\/(view-[0-9a-f]+)/.exec(hash))) {
    const view = ctx.state.views.find((v) => v.id === m[1]);
    if (!view) { location.hash = "#/views"; return; }
    ctx.editing = openEditor(app, view, ctx, { onClose: () => { location.hash = "#/views"; }, refresh });
    return;
  }
  if (hash.startsWith("#/views")) return renderViews();
  if (hash.startsWith("#/settings")) return renderSettings();
  return renderScreens();
}

// ---------- screens ----------
function deviceFor(screenId) { return ctx.state.devices.find((d) => d.screenId === screenId) || null; }
function viewById(id) { return ctx.state.views.find((v) => v.id === id) || null; }

function renderScreens() {
  const waiting = ctx.state.devices.filter((d) => !d.screenId && d.online);
  const screens = [...ctx.state.screens].sort((a, b) => a.name.localeCompare(b.name));
  const content = [
    h("div.page-head", {}, [
      h("div", {}, [h("h1", {}, "Screens"), h("p.muted", {}, "Every display in the house, live. Pick what each one shows.")]),
      h("button.btn.primary", { onclick: () => pairDialog() }, "＋ Pair a display")
    ]),
    waiting.length ? h("div.waiting", {}, waiting.map((d) => h("div.waiting-row", {}, [
      h("span.pulse"), h("div", {}, [h("b", {}, "A display is waiting to be paired"), h("div.muted.small", {}, `Code ${d.code} · ${d.label} · Chrome ${d.chrome || "?"} · ${d.width || "?"}×${d.height || "?"}`)]),
      h("button.btn.primary.small", { onclick: () => pairDialog(d.code) }, "Pair it")
    ]))) : null,
    screens.length ? h("div.grid", {}, screens.map(screenCard))
      : h("div.empty", {}, [h("h2", {}, "No screens yet"), h("p", {}, "Open the display address on a screen in the house and it will appear here with a code to pair.")]),
    ctx.state.matrix.length ? h("div.section-head", {}, [h("h2", {}, "Matrix"), h("p.muted", {}, "LED panels driven over MQTT. The preview is close, not pixel-exact (scoreboards are exact).")]) : null,
    ctx.state.matrix.length ? h("div.grid", {}, ctx.state.matrix.map((t) => (ctx.matrixCards[t.id] = matrixCard(t, ctx)))) : null,
    (ctx.state.minimatrix || []).length ? h("div.section-head", {}, [h("h2", {}, "Bedroom matrix"), h("p.muted", {}, "A 16x16 WLED panel: home scenes from Studio, WLED's own effects the rest of the time. The preview is exact.")]) : null,
    (ctx.state.minimatrix || []).length ? h("div.grid", {}, ctx.state.minimatrix.map((t) => (ctx.miniCards[t.id] = miniCard(t, ctx)))) : null
  ];
  shell("screens", content);
}

function screenCard(s) {
  const dev = deviceFor(s.id);
  const view = viewById(s.viewId);
  const thumb = h("div.thumb");
  const status = !dev ? h("span.badge.grey", {}, "No display paired")
    : dev.online ? h("span.badge.green", {}, "● Online") : h("span.badge.amber", {}, `Offline · seen ${ago(dev.lastSeen)}`);
  const viewSelect = h("select.inline-select", {
    onchange: async (e) => {
      try { await api("PATCH", `/api/screens/${s.id}`, { viewId: e.target.value }); toast(`${s.name} now shows ${viewById(e.target.value).name}`); }
      catch (ex) { toast(ex.message, "error"); e.target.value = s.viewId; }
    }
  }, ctx.state.views.map((v) => h("option", { value: v.id, selected: v.id === s.viewId }, v.name)));
  const card = h("div.card.screen-card", {}, [
    thumb,
    h("div.card-body", {}, [
      h("div.card-title-row", {}, [h("h3", {}, s.name), status]),
      h("div.muted.small", {}, dev ? `${dev.label} · Chrome ${dev.chrome || "?"} · ${screenShape(dev)}` : "Pair a display to this screen"),
      h("label.inline-field", {}, ["Shows ", viewSelect]),
      s.overlay && s.overlay.enabled ? h("div.small.overlay-note", {}, `📷 Camera pop-up: ${s.overlay.cameras.length} camera(s)${s.overlay.activeStart ? `, ${s.overlay.activeStart}-${s.overlay.activeEnd}` : ""}`) : null,
      s.timer && s.timer.enabled ? h("div.small.overlay-note", {}, `⏲️ Timer pop-up: ${s.timer.entities.length} timer(s)`) : null,
      h("div.card-actions", {}, [
        view ? h("a.btn.small", { href: `#/edit/${view.id}` }, "Edit view") : null,
        h("button.btn.small", { onclick: () => overlayDialog(s) }, "Camera pop-up"),
        h("button.btn.small", { onclick: () => timerDialog(s) }, "Timer pop-up"),
        h("button.btn.small", { onclick: () => screenMenu(s, dev) }, "More…")
      ])
    ])
  ]);
  if (!view) thumb.append(h("div.thumb-empty", {}, "No view chosen"));
  requestAnimationFrame(() => {
    if (view) {
      if (dev && dev.width && dev.height) thumb.style.aspectRatio = `${dev.width} / ${dev.height}`;
      else thumb.style.aspectRatio = `${view.published.aspect.w} / ${view.published.aspect.h}`;
      ctx.stages.push(previewStage(thumb, view.published, { ...ctx, states: ctx.states }));
    }
  });
  return card;
}

function screenMenu(s, dev) {
  const name = h("input", { value: s.name });
  const nd = { on: false, from: 22, to: 6, brightness: 0.12, ...(s.nightDim || {}) };
  const hourName = (hr) => (hr === 0 ? "midnight" : hr === 12 ? "noon" : hr < 12 ? `${hr} AM` : `${hr - 12} PM`);
  const hours = (val) => { const sel = h("select", {}, Array.from({ length: 24 }, (_, hr) => h("option", { value: hr }, hourName(hr)))); sel.value = String(val); return sel; };
  const dimOn = h("input", { type: "checkbox", checked: nd.on }), dimFrom = hours(nd.from), dimTo = hours(nd.to);
  const dimLevel = h("input", { type: "number", min: 1, max: 100, step: 1, value: Math.round(nd.brightness * 100) });
  // Screen PIN: turns Grandkids mode off at the screen. Only sent when changed.
  const pin = h("input", { type: "password", inputMode: "numeric", autocomplete: "new-password", maxLength: 6,
    placeholder: s.hasPin ? `Set (${s.pinLength} digits); type a new one to change` : "4 to 6 digits" });
  const pinOff = h("input", { type: "checkbox" });
  const m = modal(s.name, [
    h("label.field", {}, ["Name", name]),
    h("label.field", {}, [h("span", {}, [dimOn, " Dim at night, after two minutes without a touch"])]),
    h("div.field-row", {}, [h("label.field", {}, ["From", dimFrom]), h("label.field", {}, ["Until", dimTo]),
      h("label.field", {}, ["Brightness % (tablet app)", dimLevel])]),
    h("label.field", {}, ["Screen PIN (turns Grandkids mode off at the screen)", pin]),
    s.hasPin ? h("label.check", {}, [pinOff, " Remove the PIN"]) : null,
    h("div.menu-list", {}, [
      dev ? h("button.btn.wide", { onclick: async () => { await api("POST", `/api/screens/${s.id}/reload`); toast("Reload sent"); m.close(); } }, "↻ Reload the display") : null,
      dev ? h("button.btn.wide", { onclick: async () => {
        if (!await confirmBox("Unpair display?", `The display will show a new pairing code. Pair it again to bring it back.`, "Unpair", true)) return;
        await api("POST", `/api/devices/${dev.id}/unpair`); toast("Display unpaired"); m.close();
      } }, "Unpair the display") : null,
      h("button.btn.wide.danger", { onclick: async () => {
        if (!await confirmBox("Delete screen?", `Delete “${s.name}”? Its display (if any) is unpaired. Views are kept.`, "Delete", true)) return;
        await api("DELETE", `/api/screens/${s.id}`); toast("Screen deleted"); m.close();
      } }, "Delete this screen")
    ])
  ], [h("button.btn.primary", { onclick: async () => {
    try {
      const patch = { name: name.value,
        nightDim: { on: dimOn.checked, from: Number(dimFrom.value), to: Number(dimTo.value), brightness: Number(dimLevel.value) / 100 } };
      if (pin.value) patch.pin = pin.value; else if (pinOff.checked) patch.pin = "";
      await api("PATCH", `/api/screens/${s.id}`, patch);
      toast("Saved"); m.close();
    } catch (ex) { toast(ex.message, "error"); }
  } }, "Save")]);
}

function pairDialog(code = "") {
  const codeIn = h("input.code-input", { value: code, maxLength: 4, placeholder: "ABCD", autocapitalize: "characters" });
  const screens = [...ctx.state.screens].sort((a, b) => a.name.localeCompare(b.name));
  const which = h("select", {}, [h("option", { value: "" }, "A new screen…"), ...screens.map((s) => h("option", { value: s.id }, `${s.name}${deviceFor(s.id) ? " (replaces its display)" : ""}`))]);
  const name = h("input", { placeholder: "e.g. Living Room Frame" });
  const nameRow = h("label.field", {}, ["New screen name", name]);
  which.addEventListener("change", () => { nameRow.style.display = which.value ? "none" : ""; });
  const m = modal("Pair a display", [
    h("p.muted", {}, "Type the code shown on the display."),
    h("label.field", {}, ["Code", codeIn]),
    h("label.field", {}, ["Which screen is it?", which]),
    nameRow
  ], [h("button.btn.primary", { onclick: async () => {
    try {
      const r = await api("POST", "/api/pair", { code: codeIn.value, screenId: which.value || undefined, name: name.value || undefined });
      toast("Paired! The display will switch over in a moment.");
      if (r.warning) toast(r.warning, "error");
      m.close();
    } catch (ex) { toast(ex.message, "error"); }
  } }, "Pair")]);
}

async function overlayDialog(s) {
  let cameras = [];
  try { cameras = ctx.cameras || (ctx.cameras = (await api("GET", "/api/frigate/cameras")).cameras); }
  catch (ex) { toast(ex.message, "error"); }
  const o = JSON.parse(JSON.stringify(s.overlay || {}));
  o.cameras = o.cameras || []; o.zones = o.zones || {};
  const enabled = h("input", { type: "checkbox", checked: !!o.enabled });
  const rows = cameras.map((c) => {
    const box = h("input", { type: "checkbox", checked: o.cameras.includes(c.name) });
    const zoneBoxes = c.zones.map((z) => h("input", { type: "checkbox", checked: (o.zones[c.name] || []).includes(z), dataset: { zone: z } }));
    return { c, box, zoneBoxes, el: h("div.cam-row", {}, [
      h("label.check", {}, [box, ` ${c.name.replace(/_/g, " ")}`]),
      zoneBoxes.length ? h("div.zones", {}, [h("span.muted.small", {}, "Only when in zone: "), ...zoneBoxes.map((zb) => h("label.chip", {}, [zb, ` ${zb.dataset.zone}`]))]) : null
    ]) };
  });
  const seconds = h("input", { type: "number", min: 10, max: 600, value: o.seconds || 90 });
  const cooldown = h("input", { type: "number", min: 0, max: 3600, value: o.cooldown ?? 45 });
  const start = h("input", { type: "time", value: o.activeStart || "" });
  const end = h("input", { type: "time", value: o.activeEnd || "" });
  const collect = () => ({
    enabled: enabled.checked, labels: ["person"],
    cameras: rows.filter((r) => r.box.checked).map((r) => r.c.name),
    zones: Object.fromEntries(rows.filter((r) => r.box.checked).map((r) => [r.c.name, r.zoneBoxes.filter((z) => z.checked).map((z) => z.dataset.zone)]).filter(([, z]) => z.length)),
    seconds: Number(seconds.value), cooldown: Number(cooldown.value),
    activeStart: start.value, activeEnd: end.value
  });
  const m = modal(`Camera pop-up · ${s.name}`, [
    h("p.muted", {}, "When Frigate sees a person on these cameras, the screen shows that camera for a while."),
    h("label.check.big", {}, [enabled, " Show the camera pop-up on this screen"]),
    h("div.cam-list", {}, rows.length ? rows.map((r) => r.el) : h("p.muted", {}, "Frigate cameras could not be loaded.")),
    h("div.row2", {}, [h("label.field", {}, ["Show for (seconds)", seconds]), h("label.field", {}, ["Then wait at least (seconds)", cooldown])]),
    h("div.row2", {}, [h("label.field", {}, ["Only between (optional)", start]), h("label.field", {}, ["and", end])])
  ], [
    h("button.btn", { onclick: async () => {
      try { await api("PATCH", `/api/screens/${s.id}`, { overlay: collect() }); await api("POST", `/api/screens/${s.id}/test-overlay`); toast("Test pop-up sent for 15 seconds"); }
      catch (ex) { toast(ex.message, "error"); }
    } }, "Save and test"),
    h("button.btn.primary", { onclick: async () => {
      try { await api("PATCH", `/api/screens/${s.id}`, { overlay: collect() }); toast("Saved"); m.close(); } catch (ex) { toast(ex.message, "error"); }
    } }, "Save")
  ]);
}

// Home Assistant timer helpers (timer.*): while one runs, the screen shows a
// countdown card over its view.
async function timerDialog(s) {
  let timers = [];
  try { timers = (await api("GET", "/api/ha/entities?domain=timer")).entities; }
  catch (ex) { toast(ex.message, "error"); }
  const t = { enabled: false, entities: [], doneSeconds: 60, ...(s.timer || {}) };
  const enabled = h("input", { type: "checkbox", checked: !!t.enabled });
  const rows = timers.map((e) => ({ e, box: h("input", { type: "checkbox", checked: t.entities.includes(e.id) }) }));
  const doneSeconds = h("input", { type: "number", min: 0, max: 600, value: t.doneSeconds });
  const collect = () => ({ enabled: enabled.checked, entities: rows.filter((r) => r.box.checked).map((r) => r.e.id), doneSeconds: Number(doneSeconds.value) });
  const m = modal(`Timer pop-up · ${s.name}`, [
    h("p.muted", {}, "While one of these Home Assistant timers runs, the screen shows a countdown card over its view. Pausing and cancelling show too."),
    h("label.check.big", {}, [enabled, " Show the timer pop-up on this screen"]),
    h("div.cam-list", {}, rows.length ? rows.map((r) => h("div.cam-row", {}, [h("label.check", {}, [r.box, ` ${r.e.name}`]), h("span.muted.small", {}, ` ${r.e.id}`)]))
      : h("p.muted", {}, "No timer helpers found in Home Assistant.")),
    h("label.field", {}, ["Show “Done!” for (seconds, 0 = not at all)", doneSeconds])
  ], [
    h("button.btn", { onclick: async () => {
      try { await api("PATCH", `/api/screens/${s.id}`, { timer: collect() }); await api("POST", `/api/screens/${s.id}/test-timer`); toast("Test timer sent: 20 seconds"); }
      catch (ex) { toast(ex.message, "error"); }
    } }, "Save and test"),
    h("button.btn.primary", { onclick: async () => {
      try { await api("PATCH", `/api/screens/${s.id}`, { timer: collect() }); toast("Saved"); m.close(); } catch (ex) { toast(ex.message, "error"); }
    } }, "Save")
  ]);
}

// ---------- settings ----------
async function renderSettings() {
  shell("settings", [h("p.muted", {}, "Loading…")]);
  try { const content = await settingsPage(renderSettings); if (location.hash.startsWith("#/settings")) shell("settings", content); }
  catch (ex) { shell("settings", [h("div.empty", {}, [h("h2", {}, "Settings could not load"), h("p", {}, ex.message)])]); }
}

// ---------- views ----------
const PRESETS = [
  ["Landscape 16:10 (tablet)", 1280, 800], ["Landscape 16:9 (TV, photo frame)", 1366, 768],
  ["Landscape 1024×600 (bedroom frame)", 1024, 600], ["Portrait 10:16", 800, 1280], ["Square", 1000, 1000]
];

function renderViews() {
  const views = [...ctx.state.views].sort((a, b) => a.name.localeCompare(b.name));
  const used = (id) => ctx.state.screens.filter((s) => s.viewId === id);
  shell("views", [
    h("div.page-head", {}, [
      h("div", {}, [h("h1", {}, "Views"), h("p.muted", {}, "A view is a screen design. Several screens can share one.")]),
      h("button.btn.primary", { onclick: newViewDialog }, "＋ New view")
    ]),
    views.length ? h("div.grid", {}, views.map((v) => {
      const thumb = h("div.thumb");
      const users = used(v.id);
      const dirty = JSON.stringify(v.draft) !== JSON.stringify(v.published);
      requestAnimationFrame(() => {
        thumb.style.aspectRatio = `${v.draft.aspect.w} / ${v.draft.aspect.h}`;
        ctx.stages.push(previewStage(thumb, v.published, { ...ctx, states: ctx.states }));
      });
      return h("div.card", {}, [
        h("a.thumb-link", { href: `#/edit/${v.id}` }, thumb),
        h("div.card-body", {}, [
          h("div.card-title-row", {}, [h("h3", {}, v.name), dirty ? h("span.badge.amber", {}, "Unpublished edits") : null]),
          h("div.muted.small", {}, users.length ? `On ${users.map((s) => s.name).join(", ")}` : "Not on any screen"),
          h("div.card-actions", {}, [
            h("a.btn.small.primary", { href: `#/edit/${v.id}` }, "Edit"),
            h("button.btn.small", { onclick: async () => { const c = await api("POST", "/api/views", { copyOf: v.id }); location.hash = `#/edit/${c.id}`; } }, "Duplicate"),
            h("button.btn.small", { onclick: async () => {
              if (!await confirmBox("Delete view?", `Delete “${v.name}”?`, "Delete", true)) return;
              try { await api("DELETE", `/api/views/${v.id}`); toast("Deleted"); } catch (ex) { toast(ex.message, "error"); }
            } }, "Delete")
          ])
        ])
      ]);
    })) : h("div.empty", {}, [h("h2", {}, "No views yet"), h("p", {}, "Create one to start designing.")])
  ]);
}

function newViewDialog() {
  const name = h("input", { placeholder: "e.g. Photo frame with clock" });
  const shape = h("select", {}, PRESETS.map(([label, w, hh], i) => h("option", { value: i }, `${label}`)));
  const m = modal("New view", [h("label.field", {}, ["Name", name]), h("label.field", {}, ["Screen shape", shape]),
    h("p.muted.small", {}, "Starts with a photo slideshow and a clock. You can change everything.")], [
    h("button.btn.primary", { onclick: async () => {
      const [, w, hh] = PRESETS[Number(shape.value)];
      const v = await api("POST", "/api/views", { name: name.value || "New view", aspect: { w, h: hh } });
      m.close();
      location.hash = `#/edit/${v.id}`;
    } }, "Create")
  ]);
}

boot().catch((err) => { app.replaceChildren(h("div.empty", {}, [h("h2", {}, "Studio could not start"), h("p", {}, err.message)])); });
