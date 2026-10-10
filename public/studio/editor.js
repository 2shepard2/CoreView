// The WYSIWYG view editor.
//
// The canvas is the real display renderer (render.js) drawing the draft, so
// what you see is what the screens show. A transparent layer on top handles
// selection, dragging, resizing and snapping. Every change autosaves the
// draft; Publish sends it to the screens that use this view.
import { h, api, toast, modal, confirmBox, stageOptions, entityIds, loadHousehold } from "./lib.js";

const SHAPES = [
  ["Landscape 16:10 · 1280×800 (tablet)", 1280, 800], ["Landscape 16:9 · 1366×768 (TV, photo frame)", 1366, 768],
  ["Landscape · 1024×600 (bedroom frame)", 1024, 600], ["Landscape 16:9 · 1920×1080 (TV)", 1920, 1080],
  ["Portrait · 800×1280", 800, 1280], ["Square · 1000×1000", 1000, 1000]
];
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const round = (n) => Math.round(n * 10) / 10;
const clone = (o) => JSON.parse(JSON.stringify(o));

export function openEditor(app, view, ctx, { onClose, refresh }) {
  const catalog = ctx.state.catalog;
  let doc = clone(view.draft);
  let published = clone(view.published);
  let name = view.name;
  let selected = null;
  const history = [clone(doc)];
  let hpos = 0;
  let saveTimer = null, historyTimer = null, saving = false, unsaved = false;
  let closed = false;

  // Which displays will run this view: the oldest Chrome among them decides
  // which widgets are available.
  const screensHere = ctx.state.screens.filter((s) => s.viewId === view.id);
  const devicesHere = screensHere.map((s) => ({ s, d: ctx.state.devices.find((x) => x.screenId === s.id) })).filter((x) => x.d && x.d.chrome);
  const oldest = devicesHere.reduce((min, x) => (min && min.d.chrome <= x.d.chrome ? min : x), null);

  // ---------- layout ----------
  const nameIn = h("input.ed-name", { value: name, title: "View name", onchange: async () => {
    name = nameIn.value.trim() || name;
    await api("PATCH", `/api/views/${view.id}`, { name });
  } });
  const status = h("span.ed-status");
  const undoBtn = h("button.btn.small", { title: "Undo (Ctrl+Z)", onclick: () => undo() }, "↶");
  const redoBtn = h("button.btn.small", { title: "Redo (Ctrl+Shift+Z)", onclick: () => redo() }, "↷");
  const publishBtn = h("button.btn.primary", { onclick: () => publish() }, "Publish");
  const top = h("div.ed-top", {}, [
    h("button.btn.ghost", { onclick: () => onClose() }, "← Views"),
    nameIn, status, h("div.spacer"),
    undoBtn, redoBtn,
    h("button.btn.small", { onclick: () => fullPreview() }, "▶ Preview"),
    h("button.btn.small", { title: "Throw away unpublished changes", onclick: () => discard() }, "Discard changes"),
    publishBtn
  ]);

  const palette = h("div.ed-palette");
  const layers = h("div.ed-layers");
  const canvasWrap = h("div.ed-canvas-wrap");
  const canvas = h("div.ed-canvas");
  const overlay = h("div.ed-overlay", { tabIndex: 0 });
  canvasWrap.append(canvas, overlay);
  const inspector = h("div.ed-inspector");
  const root = h("div.editor", {}, [top, h("div.ed-body", {}, [h("div.ed-left", {}, [palette, layers]), canvasWrap, inspector])]);
  app.replaceChildren(root);

  const stage = CVRender.create(canvas, stageOptions(ctx, true));
  stage.setStates(ctx.states);
  stage.setData(ctx.data);
  // After a pick: fetch states and household data the view now needs.
  async function fetchNeeds() {
    const missing = entityIds([doc]).filter((id) => !(id in ctx.states));
    if (missing.length) {
      try { const s = await api("GET", `/api/ha/states?ids=${missing.slice(0, 100).join(",")}`); Object.assign(ctx.states, s.states); stage.setStates(s.states); } catch (_e) { /* shown as — */ }
    }
    const d = await loadHousehold(ctx, [doc]);
    if (Object.keys(d).length) stage.setData(d);
  }

  // ---------- rendering ----------
  function fitCanvas() {
    const pad = 32;
    const cw = canvasWrap.clientWidth - pad * 2, ch = canvasWrap.clientHeight - pad * 2;
    if (cw <= 0 || ch <= 0) return;
    const scale = Math.min(cw / doc.aspect.w, ch / doc.aspect.h);
    const w = Math.round(doc.aspect.w * scale), hh = Math.round(doc.aspect.h * scale);
    for (const el of [canvas, overlay]) {
      Object.assign(el.style, { width: `${w}px`, height: `${hh}px`, left: `${Math.round((canvasWrap.clientWidth - w) / 2)}px`, top: `${Math.round((canvasWrap.clientHeight - hh) / 2)}px` });
    }
    stage.resize();
    stage.setView(doc);
    drawSelection();
  }

  function render({ inspectorToo = true } = {}) {
    stage.setView(doc);
    drawSelection();
    drawLayers();
    if (inspectorToo) drawInspector();
    updateStatus();
  }

  function updateStatus() {
    const dirty = JSON.stringify(doc) !== JSON.stringify(published);
    status.textContent = saving ? "Saving…" : dirty ? `Draft saved · not on screens yet` : screensHere.length ? `Live on ${screensHere.length} screen${screensHere.length > 1 ? "s" : ""}` : "Saved";
    status.className = `ed-status ${dirty ? "dirty" : ""}`;
    publishBtn.disabled = !dirty;
    undoBtn.disabled = hpos === 0;
    redoBtn.disabled = hpos >= history.length - 1;
  }

  // ---------- persistence + history ----------
  function changed({ coalesce = false } = {}) {
    render({ inspectorToo: !coalesce });
    clearTimeout(historyTimer);
    const push = () => {
      if (JSON.stringify(history[hpos]) === JSON.stringify(doc)) return;
      history.splice(hpos + 1);
      history.push(clone(doc));
      if (history.length > 200) history.shift();
      hpos = history.length - 1;
      updateStatus();
    };
    if (coalesce) historyTimer = setTimeout(push, 500); else push();
    unsaved = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }
  async function save() {
    if (closed) return;
    unsaved = false;
    saving = true; updateStatus();
    try {
      const v = await api("PUT", `/api/views/${view.id}/draft`, { draft: doc });
      // The server may have tidied values (clamped numbers etc.).
      if (JSON.stringify(v.draft) !== JSON.stringify(doc) && !dragging) { doc = v.draft; render(); }
    } catch (ex) { toast(`Couldn't save: ${ex.message}`, "error"); }
    saving = false; updateStatus();
  }
  function undo() { if (hpos > 0) { hpos--; doc = clone(history[hpos]); fixSelection(); changedNoHistory(); } }
  function redo() { if (hpos < history.length - 1) { hpos++; doc = clone(history[hpos]); fixSelection(); changedNoHistory(); } }
  function changedNoHistory() { render(); unsaved = true; clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
  function fixSelection() { if (selected && !doc.widgets.some((w) => w.id === selected)) selected = null; }

  async function publish() {
    clearTimeout(saveTimer);
    await save();
    try {
      const v = await api("POST", `/api/views/${view.id}/publish`);
      published = clone(v.published);
      toast(v.screens ? `Published · ${v.screens} screen${v.screens > 1 ? "s" : ""} updating now` : "Published (not on any screen yet)");
      updateStatus();
      refresh();
    } catch (ex) { toast(ex.message, "error"); }
  }
  async function discard() {
    if (!await confirmBox("Discard changes?", "Go back to what the screens show now?", "Discard", true)) return;
    const v = await api("POST", `/api/views/${view.id}/revert`);
    doc = clone(v.draft);
    fixSelection();
    changed();
  }

  // ---------- widgets ----------
  const byId = (id) => doc.widgets.find((w) => w.id === id);
  const sel = () => (selected ? byId(selected) : null);
  function newId(type) {
    let i = 1;
    while (doc.widgets.some((w) => w.id === `${type}${i}`)) i++;
    return `${type}${i}`;
  }
  function defaults(type) {
    const out = {};
    for (const f of catalog.widgets[type].fields) out[f.key] = f.default;
    return out;
  }
  function addWidget(type, at) {
    if (doc.widgets.length >= catalog.maxWidgets) return toast("That's the most widgets a view can hold", "error");
    const spec = catalog.widgets[type];
    const w = spec.size.w, hh = spec.size.h;
    let x = at ? at.x - w / 2 : (100 - w) / 2, y = at ? at.y - hh / 2 : (100 - hh) / 2;
    // Clicked (not dropped): step down-right past widgets already there.
    for (let i = 0; !at && i < 12 && doc.widgets.some((o) => Math.abs(o.x - x) < 2 && Math.abs(o.y - y) < 2); i++) { x += 4; y += 4; }
    const widget = { id: newId(type), type, x: round(Math.max(0, Math.min(100 - w, x))), y: round(Math.max(0, Math.min(100 - hh, y))), w, h: hh, props: defaults(type) };
    // Photos go to the back so other widgets stay visible on top.
    if (type === "photos") doc.widgets.unshift(widget); else doc.widgets.push(widget);
    selected = widget.id;
    changed();
    if (type === "photos") pickAlbum(widget);
    if (type === "weather" || type === "entity") pickEntity("weather" === type ? "weather" : "", (id) => { widget.props.entity = id; changed(); fetchNeeds(); });
  }
  function removeSelected() {
    if (!selected) return;
    doc.widgets = doc.widgets.filter((w) => w.id !== selected);
    selected = null;
    changed();
  }
  function duplicateSelected() {
    const w = sel();
    if (!w) return;
    const copy = { ...clone(w), id: newId(w.type), x: round(Math.min(100 - w.w, w.x + 2)), y: round(Math.min(100 - w.h, w.y + 2)) };
    doc.widgets.splice(doc.widgets.indexOf(w) + 1, 0, copy);
    selected = copy.id;
    changed();
  }
  function arrange(where) {
    const w = sel();
    if (!w) return;
    const list = doc.widgets, i = list.indexOf(w);
    list.splice(i, 1);
    const j = where === "front" ? list.length : where === "back" ? 0 : where === "forward" ? Math.min(list.length, i + 1) : Math.max(0, i - 1);
    list.splice(j, 0, w);
    changed();
  }

  // ---------- palette + layers ----------
  function drawPalette() {
    palette.replaceChildren(h("div.ed-section-title", {}, "Add to the screen"));
    for (const [type, spec] of Object.entries(catalog.widgets)) {
      const blocked = oldest && spec.minChrome > oldest.d.chrome;
      const item = h(`button.ed-widget${blocked ? ".blocked" : ""}`, {
        draggable: !blocked,
        title: blocked ? `Needs a newer display: ${oldest.s.name} runs Chrome ${oldest.d.chrome} (this needs Chrome ${spec.minChrome}+)` : spec.description,
        onclick: () => { if (!blocked) addWidget(type); },
        ondragstart: (e) => { e.dataTransfer.setData("text/x-cv-widget", type); e.dataTransfer.effectAllowed = "copy"; }
      }, [h("span.ed-widget-icon", {}, spec.icon), h("span", {}, [h("b", {}, spec.name), h("small", {}, blocked ? `Needs a newer display (Chrome ${spec.minChrome}+)` : spec.description)])]);
      item.disabled = !!blocked;
      palette.append(item);
    }
    if (oldest) palette.append(h("div.muted.small.ed-hint", {}, `Checked against ${oldest.s.name} (Chrome ${oldest.d.chrome}), the oldest display using this view.`));
  }
  function drawLayers() {
    const items = [...doc.widgets].reverse().map((w) => h(`button.ed-layer${w.id === selected ? ".active" : ""}`, {
      onclick: () => { selected = w.id; render(); }
    }, [h("span", {}, catalog.widgets[w.type].icon), " ", layerLabel(w)]));
    layers.replaceChildren(h("div.ed-section-title", {}, "Layers (top first)"), ...(items.length ? items : [h("div.muted.small", {}, "Nothing yet")]));
  }
  function layerLabel(w) {
    if (w.type === "text") return (w.props.text || "Text").split("\n")[0].slice(0, 24);
    if (w.type === "photos") return `Photos${albumName(w.props.albumId) ? ` · ${albumName(w.props.albumId)}` : ""}`;
    if (w.type === "entity" || w.type === "weather") return w.props.label || (ctx.states[w.props.entity] && ctx.states[w.props.entity].attributes.friendly_name) || w.props.entity || catalog.widgets[w.type].name;
    return catalog.widgets[w.type].name;
  }

  // ---------- selection, drag, resize, snap ----------
  let dragging = null;
  function px() { return { w: overlay.clientWidth, h: overlay.clientHeight }; }
  function drawSelection(guides = []) {
    overlay.replaceChildren();
    for (const g of guides) {
      overlay.append(h("div.ed-guide", { class: g.axis === "x" ? "v" : "h", style: g.axis === "x" ? { left: `${g.at}%` } : { top: `${g.at}%` } }));
    }
    const w = sel();
    if (!w) return;
    const box = h("div.ed-sel", { style: { left: `${w.x}%`, top: `${w.y}%`, width: `${w.w}%`, height: `${w.h}%` } });
    for (const hd of HANDLES) box.append(h(`div.ed-handle.${hd}`, { dataset: { handle: hd } }));
    box.append(h("div.ed-size", {}, `${Math.round(w.w * doc.aspect.w / 100)}×${Math.round(w.h * doc.aspect.h / 100)}`));
    overlay.append(box);
  }
  function pointPct(e) {
    const r = overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  }
  function hit(p) {
    for (let i = doc.widgets.length - 1; i >= 0; i--) {
      const w = doc.widgets[i];
      if (p.x >= w.x && p.x <= w.x + w.w && p.y >= w.y && p.y <= w.y + w.h) return w;
    }
    return null;
  }
  // Snap the moving edges to the screen edges/centre and other widgets.
  function snapper(skipId) {
    const xs = [0, 50, 100], ys = [0, 50, 100];
    for (const o of doc.widgets) {
      if (o.id === skipId) continue;
      xs.push(o.x, o.x + o.w / 2, o.x + o.w);
      ys.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    const tol = { x: (7 / px().w) * 100, y: (7 / px().h) * 100 };
    return (axis, values) => {
      const cands = axis === "x" ? xs : ys;
      let best = null;
      for (const [i, v] of values.entries()) {
        for (const c of cands) {
          const d = c - v;
          if (Math.abs(d) <= tol[axis] && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c, i };
        }
      }
      return best;
    };
  }

  overlay.addEventListener("pointerdown", (e) => {
    overlay.focus();
    const p = pointPct(e);
    const handle = e.target.dataset && e.target.dataset.handle;
    const target = handle ? sel() : hit(p);
    if (!target) { selected = null; render(); return; }
    if (selected !== target.id) { selected = target.id; render(); }
    dragging = { mode: handle || "move", start: p, orig: { ...target }, snap: snapper(target.id), moved: false };
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!dragging) {
      const p = pointPct(e);
      overlay.style.cursor = e.target.dataset && e.target.dataset.handle ? "" : hit(p) ? "move" : "default";
      return;
    }
    const w = sel();
    if (!w) return;
    const p = pointPct(e), o = dragging.orig;
    const dx = p.x - dragging.start.x, dy = p.y - dragging.start.y;
    if (!dragging.moved && Math.hypot(dx * px().w / 100, dy * px().h / 100) < 3) return;
    dragging.moved = true;
    const guides = [];
    const snapOn = !e.shiftKey;
    if (dragging.mode === "move") {
      let x = o.x + dx, y = o.y + dy;
      if (snapOn) {
        const sx = dragging.snap("x", [x, x + o.w / 2, x + o.w]);
        if (sx) { x += sx.d; guides.push({ axis: "x", at: sx.at }); }
        const sy = dragging.snap("y", [y, y + o.h / 2, y + o.h]);
        if (sy) { y += sy.d; guides.push({ axis: "y", at: sy.at }); }
      }
      w.x = round(x); w.y = round(y);
    } else {
      const m = dragging.mode;
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (m.includes("w")) x1 = o.x + dx;
      if (m.includes("e")) x2 = o.x + o.w + dx;
      if (m.includes("n")) y1 = o.y + dy;
      if (m.includes("s")) y2 = o.y + o.h + dy;
      if (snapOn) {
        if (m.includes("w")) { const s = dragging.snap("x", [x1]); if (s) { x1 += s.d; guides.push({ axis: "x", at: s.at }); } }
        if (m.includes("e")) { const s = dragging.snap("x", [x2]); if (s) { x2 += s.d; guides.push({ axis: "x", at: s.at }); } }
        if (m.includes("n")) { const s = dragging.snap("y", [y1]); if (s) { y1 += s.d; guides.push({ axis: "y", at: s.at }); } }
        if (m.includes("s")) { const s = dragging.snap("y", [y2]); if (s) { y2 += s.d; guides.push({ axis: "y", at: s.at }); } }
      }
      const minW = 2, minH = 2;
      if (x2 - x1 < minW) { if (m.includes("w")) x1 = x2 - minW; else x2 = x1 + minW; }
      if (y2 - y1 < minH) { if (m.includes("n")) y1 = y2 - minH; else y2 = y1 + minH; }
      w.x = round(x1); w.y = round(y1); w.w = round(Math.min(100, x2 - x1)); w.h = round(Math.min(100, y2 - y1));
    }
    stage.setView(doc);
    drawSelection(guides);
    syncGeometryFields();
  });
  const endDrag = () => {
    if (!dragging) return;
    const moved = dragging.moved;
    dragging = null;
    drawSelection();
    if (moved) changed();
  };
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);
  overlay.addEventListener("dblclick", (e) => {
    const w = hit(pointPct(e));
    if (w && w.type === "text") { const t = inspector.querySelector("textarea"); if (t) { t.focus(); t.select(); } }
    if (w && w.type === "photos") pickAlbum(w);
  });
  overlay.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-cv-widget")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  overlay.addEventListener("drop", (e) => {
    const type = e.dataTransfer.getData("text/x-cv-widget");
    if (!type || !catalog.widgets[type]) return;
    e.preventDefault();
    addWidget(type, pointPct(e));
  });

  function onKey(e) {
    if (closed) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { if (typing) return; e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && e.key.toLowerCase() === "y") { if (typing) return; e.preventDefault(); return redo(); }
    if (typing || document.querySelector(".modal-wrap")) return;
    const w = sel();
    if (mod && e.key.toLowerCase() === "d" && w) { e.preventDefault(); return duplicateSelected(); }
    if ((e.key === "Delete" || e.key === "Backspace") && w) { e.preventDefault(); return removeSelected(); }
    if (e.key === "Escape") { selected = null; return render(); }
    const step = e.shiftKey ? 5 : 0.5;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && w) {
      e.preventDefault();
      w.x = round(w.x + moves[e.key][0]); w.y = round(w.y + moves[e.key][1]);
      changed({ coalesce: true });
    }
  }
  document.addEventListener("keydown", onKey);

  // ---------- inspector ----------
  let geomInputs = null;
  function syncGeometryFields() {
    const w = sel();
    if (!w || !geomInputs) return;
    for (const k of ["x", "y", "w", "h"]) if (document.activeElement !== geomInputs[k]) geomInputs[k].value = w[k];
  }

  function field(f, value, onChange) {
    const id = `f-${f.key}-${Math.random().toString(36).slice(2, 7)}`;
    let input;
    switch (f.kind) {
      case "number": {
        const range = h("input", { type: "range", min: f.min, max: f.max, step: f.step, value });
        const num = h("input.num", { type: "number", min: f.min, max: f.max, step: f.step, value, id });
        range.addEventListener("input", () => { num.value = range.value; onChange(Number(range.value), true); });
        num.addEventListener("input", () => { if (num.value !== "") { range.value = num.value; onChange(Number(num.value), true); } });
        input = h("div.range-row", {}, [range, num]);
        break;
      }
      case "toggle": {
        const cb = h("input", { type: "checkbox", checked: !!value, id, onchange: () => onChange(cb.checked) });
        return h("label.check.ins-row", {}, [cb, ` ${f.label}`]);
      }
      case "select":
        input = h("select", { id, onchange: (e) => onChange(e.target.value) }, f.options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
        break;
      case "color": {
        const allowBlank = f.default === "";
        const color = h("input", { type: "color", id, value: value || doc.textColor || "#ffffff", disabled: allowBlank && !value });
        color.addEventListener("input", () => onChange(color.value, true));
        if (!allowBlank) { input = color; break; }
        const useView = h("input", { type: "checkbox", checked: !value });
        useView.addEventListener("change", () => { color.disabled = useView.checked; onChange(useView.checked ? "" : color.value); });
        input = h("div.color-row", {}, [color, h("label.check.small", {}, [useView, " Same as view"])]);
        break;
      }
      case "textarea": {
        input = h("textarea", { id, rows: 3, value });
        input.addEventListener("input", () => onChange(input.value, true));
        break;
      }
      case "text": {
        input = h("input", { id, value });
        input.addEventListener("input", () => onChange(input.value, true));
        break;
      }
      case "album": {
        input = h("button.btn.wide.picker", { id, onclick: () => pickAlbum(sel()) }, albumName(value) || "Choose an album…");
        break;
      }
      case "entity": {
        const s = ctx.states[value];
        const pick = h("button.btn.wide.picker", { id, onclick: () => pickEntity(f.domain, (eid) => { onChange(eid); drawInspector(); fetchNeeds(); }) }, value ? `${(s && s.attributes.friendly_name) || value}` : "Choose…");
        input = value && f.default === "" ? h("div.color-row", {}, [pick, h("button.btn.small", { title: "Clear", onclick: () => { onChange(""); drawInspector(); } }, "✕")]) : pick;
        break;
      }
      case "view": {
        input = h("select", { id, onchange: (e) => onChange(e.target.value) }, [h("option", { value: "" }, "— none —"),
          ...ctx.state.views.filter((v) => v.id !== view.id).map((v) => h("option", { value: v.id, selected: v.id === value }, v.name))]);
        break;
      }
      case "camera": {
        input = h("button.btn.wide.picker", { id, onclick: () => pickCamera((cam) => { onChange(cam); drawInspector(); }) }, value || "Choose a camera…");
        break;
      }
      case "rows": {
        // A list of small forms (calendars, people, kids, cameras). A row is
        // only added once its main field is picked: the server drops blank rows.
        const rows = Array.isArray(value) ? value : [];
        const main = f.fields[0];
        const blank = () => { const r = {}; for (const sf of f.fields) r[sf.key] = sf.default; return r; };
        const save = () => { onChange(rows.map((r) => ({ ...r }))); drawInspector(); fetchNeeds(); };
        const cards = rows.map((r, i) => h("div.row-card", {}, [
          ...f.fields.map((sf) => field(sf, r[sf.key], (v, coalesce) => { r[sf.key] = v; onChange(rows.map((x) => ({ ...x })), coalesce); if (sf.kind === "entity" || sf.kind === "camera") { drawInspector(); fetchNeeds(); } })),
          h("div.btn-row", {}, [
            h("button.btn.small", { disabled: i === 0, onclick: () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); save(); } }, "↑"),
            h("button.btn.small", { disabled: i === rows.length - 1, onclick: () => { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); save(); } }, "↓"),
            h("button.btn.small.danger", { onclick: () => { rows.splice(i, 1); save(); } }, "Remove")
          ])
        ]));
        const add = () => {
          const done = (v) => { const r = blank(); r[main.key] = v; rows.push(r); save(); };
          if (main.kind === "camera") pickCamera(done); else pickEntity(main.domain, done);
        };
        input = h("div.rows", {}, [...cards, rows.length < (f.max || 10) ? h("button.btn.wide", { onclick: add }, `+ Add ${main.label.toLowerCase()}`) : null]);
        break;
      }
      default: input = h("span", {}, String(value));
    }
    return h("div.ins-field", {}, [h("label", { htmlFor: id }, f.label), input]);
  }

  // replaceChildren() would print a null child as the text "null".
  const setInspector = (...nodes) => inspector.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  function drawInspector() {
    geomInputs = null;
    const w = sel();
    if (!w) return drawViewSettings();
    const spec = catalog.widgets[w.type];
    const setProp = (key) => (value, coalesce) => { w.props[key] = value; changed({ coalesce }); };
    geomInputs = {};
    const geom = ["x", "y", "w", "h"].map((k) => {
      const inp = h("input.num", { type: "number", step: 0.5, value: w[k] });
      inp.addEventListener("input", () => { if (inp.value === "") return; w[k] = round(Number(inp.value)); changed({ coalesce: true }); });
      geomInputs[k] = inp;
      return h("label.geom", {}, [{ x: "Left %", y: "Top %", w: "Width %", h: "Height %" }[k], inp]);
    });
    const quick = (label, fn) => h("button.btn.small", { onclick: () => { fn(w); changed(); } }, label);
    setInspector(
      h("div.ins-head", {}, [h("span.ed-widget-icon", {}, spec.icon), h("div", {}, [h("b", {}, spec.name), h("div.muted.small", {}, spec.description)])]),
      ...spec.fields.map((f) => field(f, w.props[f.key], setProp(f.key))),
      h("div.ed-section-title", {}, "Position"),
      h("div.geom-grid", {}, geom),
      h("div.btn-row", {}, [
        quick("Fill screen", (x) => Object.assign(x, { x: 0, y: 0, w: 100, h: 100 })),
        quick("Centre", (x) => Object.assign(x, { x: round((100 - x.w) / 2), y: round((100 - x.h) / 2) })),
        quick("⇤", (x) => { x.x = 0; }), quick("⇥", (x) => { x.x = round(100 - x.w); }),
        quick("⤒", (x) => { x.y = 0; }), quick("⤓", (x) => { x.y = round(100 - x.h); })
      ]),
      h("div.ed-section-title", {}, "Arrange"),
      h("div.btn-row", {}, [
        h("button.btn.small", { onclick: () => arrange("front") }, "To front"),
        h("button.btn.small", { onclick: () => arrange("forward") }, "Forward"),
        h("button.btn.small", { onclick: () => arrange("backward") }, "Back"),
        h("button.btn.small", { onclick: () => arrange("back") }, "To back")
      ]),
      h("div.btn-row", {}, [
        h("button.btn.small", { onclick: duplicateSelected }, "Duplicate"),
        h("button.btn.small.danger", { onclick: removeSelected }, "Delete")
      ]),
      h("p.muted.small", {}, "Tip: drag to move, drag the corners to resize, hold Shift to turn off snapping, arrow keys nudge.")
    );
  }

  function drawViewSettings() {
    const shapeSel = h("select", {}, [
      ...SHAPES.map(([label, w, hh]) => h("option", { value: `${w}x${hh}`, selected: doc.aspect.w === w && doc.aspect.h === hh }, label)),
      ...devicesHere.map(({ s, d }) => h("option", { value: `${d.width}x${d.height}`, selected: false }, `Like ${s.name} · ${d.width}×${d.height}`)),
      h("option", { value: "custom", selected: !SHAPES.some(([, w, hh]) => doc.aspect.w === w && doc.aspect.h === hh) }, `Custom · ${doc.aspect.w}×${doc.aspect.h}`)
    ]);
    shapeSel.addEventListener("change", () => {
      if (shapeSel.value === "custom") return;
      const [w, hh] = shapeSel.value.split("x").map(Number);
      doc.aspect = { w, h: hh };
      changed();
      fitCanvas();
    });
    const mismatch = devicesHere.filter(({ d }) => d.width && d.height && Math.abs(d.width / d.height - doc.aspect.w / doc.aspect.h) > 0.03);
    setInspector(
      h("div.ins-head", {}, [h("span.ed-widget-icon", {}, "🎨"), h("div", {}, [h("b", {}, "View settings"), h("div.muted.small", {}, "Click something on the canvas to edit it.")])]),
      h("div.ins-field", {}, [h("label", {}, "Screen shape"), shapeSel]),
      mismatch.length ? h("p.small.warn", {}, `${mismatch.map((x) => x.s.name).join(", ")} ${mismatch.length > 1 ? "have" : "has"} a different shape (${mismatch.map((x) => `${x.d.width}×${x.d.height}`).join(", ")}). They'll show this view with bars at the sides.`) : null,
      ...catalog.viewFields.map((f) => field(f, doc[f.key], (v, coalesce) => { doc[f.key] = v; changed({ coalesce }); })),
      h("div.ed-section-title", {}, "Where it's used"),
      h("p.small", {}, screensHere.length ? screensHere.map((s) => s.name).join(", ") : "Not on any screen yet. Assign it on the Screens page.")
    );
  }

  // ---------- pickers ----------
  function albumName(id) { const a = (ctx.albums || []).find((x) => x.id === id); return a ? a.name : id ? "Album" : ""; }
  async function pickAlbum(w) {
    if (!w) return;
    let albums;
    try { albums = ctx.albums || (ctx.albums = (await api("GET", "/api/immich/albums")).albums); }
    catch (ex) { return toast(`Couldn't load albums: ${ex.message}`, "error"); }
    const m = modal("Choose an album", [h("div.album-grid", {}, albums.map((a) => h(`button.album${a.id === w.props.albumId ? ".active" : ""}`, {
      onclick: () => { w.props.albumId = a.id; m.close(); changed(); }
    }, [
      h("div.album-cover", {}, a.thumb ? h("img", { src: `/api/photo/${a.thumb}`, alt: "", loading: "lazy" }) : "🖼"),
      h("b", {}, a.name), h("small.muted", {}, `${a.count} items`)
    ])))]);
  }
  async function pickCamera(onPick) {
    let cams;
    try { cams = ctx.cameras || (ctx.cameras = (await api("GET", "/api/frigate/cameras")).cameras); }
    catch (ex) { return toast(ex.message, "error"); }
    const m = modal("Choose a camera", [h("div.entity-list", {}, cams.map((c) => h("button.entity", { onclick: () => { m.close(); onPick(c.name); } }, [h("b", {}, c.name)])))]);
  }
  async function pickEntity(domain, onPick) {
    let list;
    try { list = (await api("GET", `/api/ha/entities${domain ? `?domain=${domain}` : ""}`)).entities; }
    catch (ex) { return toast(ex.message, "error"); }
    const search = h("input", { placeholder: "Search, e.g. laundry, front door, temperature" });
    const results = h("div.entity-list");
    const draw = () => {
      const q = search.value.toLowerCase();
      const hits = list.filter((e) => !q || e.name.toLowerCase().includes(q) || e.id.includes(q)).slice(0, 80);
      results.replaceChildren(...hits.map((e) => h("button.entity", {
        onclick: () => { m.close(); onPick(e.id); }
      }, [h("b", {}, e.name), h("small.muted", {}, `${e.id} · ${e.state}${e.unit ? " " + e.unit : ""}`)])));
    };
    search.addEventListener("input", draw);
    const titles = { weather: "Choose the weather source", calendar: "Choose a calendar", todo: "Choose a list", person: "Choose a person", script: "Choose a script" };
    const m = modal(titles[domain] || "Choose a Home Assistant entity", [search, results]);
    draw();
  }

  // ---------- full preview ----------
  function fullPreview() {
    const box = h("div.preview-box");
    const wrap = h("div.preview-full", { onclick: (e) => { if (e.target === wrap || e.target === box) close(); } }, [box, h("div.preview-hint", {}, "Click outside or press Esc to close · photos cycle like on the screen")]);
    document.body.append(wrap);
    const r = doc.aspect.w / doc.aspect.h;
    const w = Math.min(window.innerWidth * 0.92, window.innerHeight * 0.85 * r);
    Object.assign(box.style, { width: `${w}px`, height: `${w / r}px` });
    const st = CVRender.create(box, stageOptions(ctx, false));
    st.setStates(ctx.states);
    st.setData(ctx.data);
    st.setView(doc);
    const esc = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc);
    function close() { st.destroy(); wrap.remove(); document.removeEventListener("keydown", esc); }
  }

  // ---------- go ----------
  const onResize = () => fitCanvas();
  window.addEventListener("resize", onResize);
  drawPalette();
  api("GET", "/api/immich/albums").then((d) => { ctx.albums = d.albums; drawLayers(); if (sel() && sel().type === "photos") drawInspector(); }).catch(() => {});
  requestAnimationFrame(() => { fitCanvas(); render(); });

  return {
    close() {
      clearTimeout(saveTimer);
      // Leaving the editor with an edit still waiting: save it now.
      if (unsaved) api("PUT", `/api/views/${view.id}/draft`, { draft: doc }).catch(() => {});
      closed = true;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      stage.destroy();
    },
    states(changes) { stage.setStates(changes); },
    data(changes) { stage.setData(changes); }
  };
}
