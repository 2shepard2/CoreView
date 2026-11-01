// Small helpers shared by the Studio pages.

// h("div.card", { onclick }, [children]) -> element. Styles are set through
// el.style (the page's CSP forbids inline style attributes).
export function h(spec, props = {}, children = []) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "style") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += " " + v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export async function api(method, url, body) {
  const rsp = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Studio": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin"
  });
  let data = null;
  try { data = await rsp.json(); } catch (_e) { data = null; }
  if (!rsp.ok) {
    const err = new Error((data && data.error) || `Request failed (${rsp.status})`);
    err.status = rsp.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
export function toast(message, kind = "info") {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast hidden"; }, kind === "error" ? 6000 : 3000);
}

export function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function modal(title, body, actions = []) {
  const close = () => wrap.remove();
  const wrap = h("div.modal-wrap", { onclick: (e) => { if (e.target === wrap) close(); } }, [
    h("div.modal", {}, [
      h("div.modal-head", {}, [h("h2", {}, title), h("button.icon-btn", { onclick: close, title: "Close", "aria-label": "Close" }, "✕")]),
      h("div.modal-body", {}, body),
      actions.length ? h("div.modal-actions", {}, actions) : null
    ])
  ]);
  document.body.append(wrap);
  const first = wrap.querySelector("input, select, textarea");
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: wrap };
}

export function confirmBox(title, text, okLabel = "OK", danger = false) {
  return new Promise((resolve) => {
    const m = modal(title, [h("p", {}, text)], [
      h("button.btn", { onclick: () => { m.close(); resolve(false); } }, "Cancel"),
      h(`button.btn.${danger ? "danger" : "primary"}`, { onclick: () => { m.close(); resolve(true); } }, okLabel)
    ]);
  });
}

// Renderer options shared by every stage in Studio (thumbnails, editor, preview).
export function stageOptions(ctx, editing) {
  return {
    editing: !!editing,
    now: () => Date.now() + (ctx.skew || 0),
    tzOffsetMin: ctx.tzOffsetMin,
    photoUrl: (id) => `/api/photo/${id}`,
    cameraUrl: (cam) => `/api/camera/${cam}`,
    personUrl: (entity) => `/api/person/${entity}`,
    frigateUrl: (id, kind) => `/api/frigate/${encodeURIComponent(id)}/${kind}`,
    jellyfinUrl: (id, kind) => `/api/jellyfin/${id}/${kind}`,
    boardUrl: (name, part) => `/api/board/${name}/${part}`,
    tileUrl: (layer, z, x, y, frame, period) => `/api/tiles/${layer}/${z}/${x}/${y}.png?f=${frame || 0}&p=${period || 0}`,
    album: (albumId, cb) => api("GET", `/api/immich/album/${albumId}`).then((d) => cb(null, d.photos), (e) => cb(e))
  };
}

// A live renderer stage inside a box, scaled to fit. Used for thumbnails.
export function previewStage(container, view, ctx, opts = {}) {
  const stage = CVRender.create(container, stageOptions(ctx, opts.editing));
  stage.setStates(ctx.states || {});
  stage.setData(ctx.data || {});
  if (view) stage.setView(view);
  if (opts.theme) stage.setTheme(opts.theme);
  return stage;
}

// Every Home Assistant entity a view mentions (single fields and list rows).
export function entityIds(views) {
  const ids = new Set();
  const walk = (v) => {
    if (typeof v === "string") { if (/^[a-z_]+\.[a-z0-9_]+$/.test(v) && !v.startsWith("calendar.")) ids.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const view of views) for (const w of (view && view.widgets) || []) walk(w.props);
  return [...ids];
}

// Household data keys (lib/household.js) that a view's widgets read.
export function dataKeys(views) {
  const keys = new Set();
  for (const view of views) for (const w of (view && view.widgets) || []) {
    const p = w.props;
    if (w.type === "calendar") for (const c of p.calendars || []) keys.add(`cal:${c.entity}`);
    if (w.type === "todo" && p.entity) keys.add(`todo:${p.entity}`);
    if (w.type === "chores") for (const k of p.kids || []) keys.add(`todo:${k.entity}`);
    if (w.type === "sky" && p.entity) keys.add(`fc:${p.entity}`);
    if (w.type === "cameras" && (p.cameras || []).length) keys.add("cams");
    if (w.type === "terrarium") keys.add("lab");
    if (w.type === "nowshowing") keys.add("jellyfin");
  }
  return [...keys];
}
export async function loadHousehold(ctx, views) {
  const keys = dataKeys(views).filter((k) => !ctx.data[k]);
  if (!keys.length) return {};
  try {
    const d = (await api("GET", `/api/household?keys=${encodeURIComponent(keys.join(","))}`)).data;
    for (const k of Object.keys(d)) if (d[k]) ctx.data[k] = d[k];
    return d;
  } catch (_e) { return {}; }
}

export function screenShape(device, view) {
  if (device && device.width && device.height) return `${device.width}×${device.height}`;
  return view ? `${view.aspect.w}×${view.aspect.h}` : "";
}

// Where a view is used (the server's viewUsage): screens it is the main view
// of, screens that reach it by a link from another view, and every view that
// links to it. `all` is every screen that holds a copy.
export function viewUsage(state, viewId) {
  const u = (state.viewUsage || {})[viewId] || { screens: [], via: [], linkedFrom: [] };
  const screen = (id) => state.screens.find((s) => s.id === id);
  const view = (id) => state.views.find((v) => v.id === id);
  const direct = u.screens.map(screen).filter(Boolean);
  const via = u.via.map((x) => ({ screen: screen(x.screenId), from: view(x.from) })).filter((x) => x.screen && x.from);
  const linkedFrom = u.linkedFrom.map((l) => ({ ...l, view: view(l.viewId) })).filter((l) => l.view);
  const all = [...direct];
  for (const x of via) if (!all.includes(x.screen)) all.push(x.screen);
  return { direct, via, linkedFrom, all };
}

// "On Kitchen · Opened from “Home” on Den", or "Not on any screen".
export function usageLine(u) {
  const parts = [];
  if (u.direct.length) parts.push(`On ${u.direct.map((s) => s.name).join(", ")}`);
  const byFrom = new Map();
  for (const x of u.via) byFrom.set(x.from, [...(byFrom.get(x.from) || []), x.screen.name]);
  for (const [from, names] of byFrom) parts.push(`Opened from “${from.name}” on ${names.join(", ")}`);
  return parts.length ? parts.join(" · ") : "Not on any screen";
}
