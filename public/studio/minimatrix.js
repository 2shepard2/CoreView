// The bedroom matrix card on the Screens page: a live 16x16 preview of the
// scene Studio is showing (exact: same renderer as the frames it sends), a
// "try a scene" button, and settings (people, doors, cameras, quiet hours...).
import { h, api, toast, modal } from "./lib.js";

const MINI = window.CoreViewMini;

function preview(canvas) {
  const N = MINI.N, Z = 12;
  canvas.width = N * Z; canvas.height = N * Z;
  const g = canvas.getContext("2d");
  let scene = null, t0 = performance.now(), timer = 0;
  function draw() {
    if (document.hidden) return;
    const px = new Array(N * N);
    MINI.render(scene, performance.now() - t0, (x, y, c) => { px[y * N + x] = c; });
    g.fillStyle = "#000"; g.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < N * N; i++) {
      g.fillStyle = px[i] || "#111311";
      g.fillRect((i % N) * Z + 2, Math.floor(i / N) * Z + 2, Z - 4, Z - 4);
    }
  }
  timer = setInterval(draw, 100);
  draw();
  return {
    set(next) { if (JSON.stringify(next) !== JSON.stringify(scene)) t0 = performance.now(); scene = next; draw(); },
    destroy() { clearInterval(timer); }
  };
}

export function miniCard(t, ctx) {
  const canvas = h("canvas.led.mini");
  const led = preview(canvas);
  const status = h("span.badge");
  const what = h("div.small");
  const how = h("div.small.muted");
  const card = h("div.card.matrix-card", {}, [
    h("div.led-wrap", {}, canvas),
    h("div.card-body", {}, [
      h("div.card-title-row", {}, [h("h3", {}, t.name), status]),
      what, how,
      h("div.card-actions", {}, [
        h("button.btn.small", { onclick: () => settingsDialog(card.target) }, "Settings"),
        h("button.btn.small", { onclick: () => tryDialog(card.target) }, "Try a scene")
      ])
    ])
  ]);
  card.update = (next) => {
    card.target = next;
    led.set(next.scene);
    status.className = "badge " + (next.enabled ? "green" : "amber");
    status.textContent = next.enabled ? "● Studio drives it" : "Off: WLED only";
    what.textContent = `Showing: ${MINI.describe(next.scene)}`;
    how.textContent = describeHow(next);
  };
  card.destroy = () => led.destroy();
  card.update(t);
  return card;
}

function describeHow(t) {
  const q = t.quiet || {};
  return `WLED at ${t.host || "?"}` + (q.enabled ? ` · quiet ${q.start}–${q.end}${t.quietNow ? " (now: alerts and cameras only, dimmed)" : ""}` : "");
}

function tryDialog(t) {
  const kinds = [["arrival", "Someone came home"], ["door", "Door open"], ["garage", "Garage door up"], ["camera", "Person on a camera"],
    ["dogs", "Dogs need out"], ["laundry", "Washer done"], ["dryer", "Dryer done"], ["notification", "Notification"], ["alert", "Alert"]];
  const m = modal(`Try a scene · ${t.name}`, [
    h("p.muted", {}, "Plays on the matrix for 10 seconds (even while it's off), then WLED goes back to its own effect."),
    h("div.chips", {}, kinds.map(([k, label]) => h("button.btn.small", { onclick: async () => {
      try { await api("POST", `/api/minimatrix/${t.id}/test`, { kind: k }); toast(`${label}: 10 seconds`); } catch (ex) { toast(ex.message, "error"); }
    } }, label)))
  ]);
  return m;
}

function settingsDialog(t) {
  const input = (value, attrs = {}) => h("input", { value: value ?? "", ...attrs });
  const enabled = h("input", { type: "checkbox", checked: t.enabled });
  const host = input(t.host);
  const bright = input(t.brightness, { type: "number", min: 5, max: 100 });
  const qOn = h("input", { type: "checkbox", checked: t.quiet.enabled });
  const qStart = input(t.quiet.start, { type: "time" }), qEnd = input(t.quiet.end, { type: "time" });
  const qDim = input(t.quiet.dim, { type: "number", min: 5, max: 100 });
  const arrival = input(t.arrivalSeconds, { type: "number", min: 5, max: 600 });
  const doorMax = input(t.doorMaxMinutes, { type: "number", min: 1, max: 240 });
  const camMin = input(t.cameraMinSeconds, { type: "number", min: 0, max: 300 });
  const dogsOn = h("input", { type: "checkbox", checked: t.dogs.enabled });
  const laundryOn = h("input", { type: "checkbox", checked: t.laundry.enabled });
  const rotate = h("select", {}, [0, 90, 180, 270].map((r) => h("option", { value: r, selected: t.rotate === r }, `${r}°`)));
  const flipX = h("input", { type: "checkbox", checked: t.flipX }), flipY = h("input", { type: "checkbox", checked: t.flipY });

  // Editable lists: each row is a set of inputs plus a remove button.
  function list(items, cols, blank) {
    const box = h("div.mini-list");
    const rows = [];
    const add = (item) => {
      const r = { inputs: cols.map((c) => c.make(item[c.key])), el: null };
      r.el = h("div.mini-row", {}, [...r.inputs, h("button.btn.small", { onclick: () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); } }, "✕")]);
      rows.push(r); box.appendChild(r.el);
    };
    items.forEach(add);
    return { el: h("div", {}, [box, h("button.btn.small", { onclick: () => add(blank) }, "+ Add")]),
      value: () => rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.key, c.read(r.inputs[i])]))) };
  }
  const txt = (key, ph, extra = {}) => ({ key, make: (v) => input(v, { placeholder: ph, ...extra }), read: (el) => el.value.trim() });
  const people = list(t.people, [txt("entityId", "person.someone"), txt("label", "DAD", { maxLength: 4, size: 4 }),
    { key: "color", make: (v) => input(v || "#ffffff", { type: "color" }), read: (el) => el.value }], { entityId: "", label: "", color: "#ffffff" });
  const doors = list(t.doors, [txt("entityId", "binary_sensor.front_door"),
    { key: "kind", make: (v) => h("select", {}, [["door", "Door (letter)"], ["garage", "Garage (icon)"]].map(([k, l]) => h("option", { value: k, selected: v === k }, l))), read: (el) => el.value },
    txt("letter", "B", { maxLength: 4, size: 4 })], { entityId: "", kind: "door", letter: "" });
  const cameras = list(t.cameras, [txt("entityId", "binary_sensor.side_yard_person_occupancy"), txt("label", "YARD", { maxLength: 4, size: 4 })],
    { entityId: "", label: "" });

  const m = modal(`Settings · ${t.name}`, [
    h("label.check.big", {}, [enabled, " Studio drives the matrix (off = WLED does its own thing)"]),
    h("div.row2", {}, [h("label.field", {}, ["WLED address", host]), h("label.field", {}, ["Brightness of scenes (%)", bright])]),
    h("h3.section", {}, "Quiet hours"),
    h("label.check", {}, [qOn, " Only alerts and people on camera, dimmed"]),
    h("div.row3", {}, [h("label.field", {}, ["From", qStart]), h("label.field", {}, ["Until", qEnd]), h("label.field", {}, ["Dim to (%)", qDim])]),
    h("h3.section", {}, "Someone came home"),
    h("p.muted.small", {}, "Up to four letters each. Shows when the person's status changes to home."),
    people.el,
    h("label.field", {}, ["Show for (seconds)", arrival]),
    h("h3.section", {}, "Doors"),
    h("p.muted.small", {}, "Doors show a letter inside the door; garage doors show the garage icon with a label."),
    doors.el,
    h("label.field", {}, ["Stop showing a door left open after (minutes)", doorMax]),
    h("h3.section", {}, "Cameras (person seen)"),
    cameras.el,
    h("label.field", {}, ["Show at least (seconds)", camMin]),
    h("h3.section", {}, "Dogs and laundry"),
    h("label.check", {}, [dogsOn, ` Dogs need out (from ${t.dogs.lastOut} and the reminder interval, ${t.dogs.from}–${t.dogs.to})`]),
    h("label.check", {}, [laundryOn, ` Laundry done (${t.laundry.machines.map((m) => m.kind).join(" + ") || "no machines"}: shaking ${t.laundry.runMinutes}+ min, then still ${t.laundry.quietMinutes} min)`]),
    h("h3.section", {}, "Panel orientation"),
    h("div.row3", {}, [h("label.field", {}, ["Rotate", rotate]), h("label.check", {}, [flipX, " Mirror left/right"]), h("label.check", {}, [flipY, " Mirror top/bottom"])])
  ], [h("button.btn.primary", { onclick: async () => {
    try {
      await api("POST", `/api/minimatrix/${t.id}`, {
        enabled: enabled.checked, host: host.value.trim(), brightness: Number(bright.value),
        quiet: { enabled: qOn.checked, start: qStart.value, end: qEnd.value, dim: Number(qDim.value) },
        arrivalSeconds: Number(arrival.value), doorMaxMinutes: Number(doorMax.value), cameraMinSeconds: Number(camMin.value),
        people: people.value(), doors: doors.value(), cameras: cameras.value(),
        dogs: { ...t.dogs, enabled: dogsOn.checked }, laundry: { ...t.laundry, enabled: laundryOn.checked },
        rotate: Number(rotate.value), flipX: flipX.checked, flipY: flipY.checked
      });
      toast("Saved"); m.close();
    } catch (ex) { toast(ex.message, "error"); }
  } }, "Save")]);
}
