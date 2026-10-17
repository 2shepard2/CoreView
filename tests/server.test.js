// End-to-end tests of the two listeners with fake Immich and Frigate.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");
const { cleanView, blankView, unsupportedFor, WIDGETS } = require("../lib/widgets");
const { matches, activeNow, cleanOverlay } = require("../lib/overlay");
const { chromeMajor, deviceLabel } = require("../lib/devices");

const ALBUM = "11111111-2222-3333-4444-555555555555";
const PHOTO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OLD_UA = "Mozilla/5.0 (Linux; Android 6.0.1; ZN-DP1001 Build/MXC89K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/44.0.2403.119 Safari/537.36";

function fakeImmich() {
  return {
    configured: () => true,
    listAlbums: async () => [{ id: ALBUM, name: "Family", count: 1, thumb: PHOTO }],
    album: async (id) => (id === ALBUM ? [{ id: PHOTO, date: "2019-08-07T10:00:00", place: "Lisbon", portrait: false }] : []),
    preview: async (id) => (id === PHOTO ? { body: Buffer.from("jpeg"), type: "image/jpeg" } : null)
  };
}
const fakeOverlays = { start() { return this; }, stop() {}, listCameras: async () => [{ name: "front_entry", zones: [] }], latestFrame: async () => ({ body: Buffer.from("x"), type: "image/jpeg" }) };

async function start(extraDeps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvs-"));
  const tokenFile = path.join(dir, "agent_token");
  fs.writeFileSync(tokenFile, "test-agent-token");
  fs.writeFileSync(path.join(dir, "setup_code"), "letmein-123");
  const app = createApp({ DATA_DIR: dir, COOKIE_SECURE: "0", AGENT_TOKEN_FILE: tokenFile, SETUP_CODE_FILE: path.join(dir, "setup_code") }, { immich: fakeImmich(), overlays: fakeOverlays, ...extraDeps }).start();
  const d = http.createServer(app.displayHandler).listen(0);
  const a = http.createServer(app.adminHandler).listen(0);
  await Promise.all([new Promise((r) => d.once("listening", r)), new Promise((r) => a.once("listening", r))]);
  const base = (s) => `http://127.0.0.1:${s.address().port}`;
  return { app, dir, display: base(d), admin: base(a), close: () => { app.stop(); d.close(); a.close(); } };
}

const agent = (method, url, body) => fetch(url, {
  method, headers: { Authorization: "Bearer test-agent-token", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

test("widget catalog validation clamps and drops junk", () => {
  const v = cleanView({ aspect: { w: 5, h: 99999 }, background: "red", widgets: [
    { id: "a", type: "clock", x: 500, y: -500, w: 0, h: 50, props: { size: 999, format: "13", evil: "<script>" } },
    { id: "b", type: "nope", x: 0, y: 0, w: 10, h: 10, props: {} },
    { id: "a", type: "photos", x: 0, y: 0, w: 100, h: 100, props: { albumId: "../../etc", interval: 1 } }
  ] });
  assert.deepEqual(v.aspect, { w: 100, h: 8000 });
  assert.equal(v.background, "#0b0f14");
  assert.equal(v.widgets.length, 2);
  assert.equal(v.widgets[0].x, 100); assert.equal(v.widgets[0].y, -50); assert.equal(v.widgets[0].w, 1);
  assert.equal(v.widgets[0].props.size, 60); assert.equal(v.widgets[0].props.format, "12"); assert.ok(!("evil" in v.widgets[0].props));
  assert.notEqual(v.widgets[1].id, "a", "duplicate ids are renamed");
  assert.equal(v.widgets[1].props.albumId, ""); assert.equal(v.widgets[1].props.interval, 5);
});

test("a starter view exists from the first start", async () => {
  const s = await start();
  try {
    const st = (await agent("GET", `${s.admin}/api/state`)).data;
    assert.equal(st.views.length, 1);
    assert.equal(st.views[0].name, "Photo frame");
    assert.equal((await agent("DELETE", `${s.admin}/api/views/${st.views[0].id}`)).status, 409, "the last view can't be deleted");
  } finally { s.close(); }
});

test("every widget runs on Chrome 44 today", () => {
  for (const w of Object.values(WIDGETS)) assert.ok(w.minChrome <= 44);
  assert.deepEqual(unsupportedFor(blankView(), 44), []);
});

test("user agent parsing", () => {
  assert.equal(chromeMajor(OLD_UA), 44);
  assert.equal(deviceLabel(OLD_UA), "Android 6.0.1 · ZN-DP1001");
});

test("overlay rules match V1 semantics", () => {
  const o = cleanOverlay({ enabled: true, cameras: ["driveway", "front_entry"], zones: { driveway: ["property"] }, activeStart: "06:00", activeEnd: "20:30" });
  assert.ok(matches(o, { camera: "front_entry", label: "person", zones: [] }));
  assert.ok(!matches(o, { camera: "front_entry", label: "car", zones: [] }));
  assert.ok(!matches(o, { camera: "driveway", label: "person", zones: [] }), "driveway needs the property zone");
  assert.ok(matches(o, { camera: "driveway", label: "person", zones: ["property"] }));
  assert.ok(!matches(o, { camera: "back_yard", label: "person", zones: [] }));
  const at = (hh, mm) => { const d = new Date(2026, 9, 5, hh, mm); return d; };
  assert.ok(activeNow(o, at(6, 0))); assert.ok(activeNow(o, at(20, 29))); assert.ok(!activeNow(o, at(20, 30))); assert.ok(!activeNow(o, at(2, 0)));
  const night = cleanOverlay({ enabled: true, activeStart: "22:00", activeEnd: "06:00" });
  assert.ok(activeNow(night, at(23, 0))); assert.ok(activeNow(night, at(5, 0))); assert.ok(!activeNow(night, at(12, 0)));
});

test("first-run setup needs the setup code; sign-in and CSRF", async () => {
  const s = await start();
  try {
    const origin = s.admin;
    const post = (p, body, headers = {}) => fetch(`${s.admin}${p}`, { method: "POST", headers: { "X-Studio": "1", Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    let r = await fetch(`${s.admin}/api/session`).then((x) => x.json());
    assert.equal(r.setup, true);
    assert.equal((await fetch(`${s.admin}/api/state`)).status, 401);
    // No X-Studio header, no Origin, or a foreign Origin: refused.
    assert.equal((await fetch(`${s.admin}/api/setup`, { method: "POST", headers: { Origin: origin }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${s.admin}/api/setup`, { method: "POST", headers: { "X-Studio": "1" }, body: "{}" })).status, 403, "Origin is required");
    assert.equal((await post("/api/setup", { code: "letmein-123", username: "x1", password: "longenough" }, { Origin: "http://evil.example" })).status, 403);
    // Wrong or missing setup code: refused, still not set up.
    assert.equal((await post("/api/setup", { username: "admin", password: "longenough" })).status, 403);
    assert.equal((await post("/api/setup", { code: "nope", username: "admin", password: "longenough" })).status, 403);
    const setup = await post("/api/setup", { code: "letmein-123", username: "admin", password: "longenough" });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${s.admin}/api/state`, { headers: { cookie } })).status, 200);
    assert.equal((await post("/api/setup", { code: "letmein-123", username: "x", password: "longenough" })).status, 409, "only once");
    assert.equal((await post("/api/login", { username: "admin", password: "nope-nope" })).status, 401);
    // A signed-in change without Origin is refused even with the cookie.
    assert.equal((await fetch(`${s.admin}/api/screens`, { method: "POST", headers: { cookie, "X-Studio": "1" }, body: "{}" })).status, 403);
    assert.equal((await post("/api/screens", { name: "Hall" }, { cookie })).status, 200);
    const stored = JSON.parse(fs.readFileSync(path.join(s.dir, "studio.json"), "utf8"));
    assert.ok(!JSON.stringify(stored).includes("longenough"), "password is not stored in clear");
  } finally { s.close(); }
});

test("setup is locked when there is no setup code file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvs-"));
  const app = createApp({ DATA_DIR: dir, COOKIE_SECURE: "0" }, { immich: fakeImmich(), overlays: fakeOverlays });
  assert.throws(() => app.auth.setup("admin", "longenough", ""), /locked/);
  app.stop();
});

test("frigate poller re-checks in-progress events older than the window", async () => {
  const { createOverlayWatcher } = require("../lib/overlay");
  const t0 = Date.parse("2026-10-05T12:00:00-07:00");
  let now = t0;
  // An event that started 20 minutes ago, still in progress, now in the zone.
  const old = { id: "e1", camera: "driveway", label: "person", start_time: (t0 - 20 * 60000) / 1000, end_time: null, zones: ["property"] };
  const fired = [];
  const w = createOverlayWatcher({
    url: "http://frigate", now: () => now,
    screens: () => [{ id: "s1", overlay: cleanOverlay({ enabled: true, cameras: ["driveway"], zones: { driveway: ["property"] } }) }],
    onOverlay: (id, info) => fired.push([id, info.eventId]),
    fetchImpl: async (u) => ({ ok: true, json: async () => (u.includes("in_progress=1") ? [old] : []) })
  });
  await w.poll();
  assert.deepEqual(fired, [["s1", "e1"]]);
});

test("pair a display, publish a view, serve only its photos", async () => {
  const s = await start();
  try {
    // A display says hello and gets a code + cookie.
    const hello = await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "User-Agent": OLD_UA, "Content-Type": "application/json" }, body: JSON.stringify({ w: 1024, h: 600 }) });
    const first = await hello.json();
    assert.equal(first.paired, false);
    assert.match(first.code, /^[A-Z0-9]{4}$/);
    const devCookie = hello.headers.get("set-cookie").split(";")[0];
    assert.match(hello.headers.get("set-cookie"), /HttpOnly/);
    // Not paired yet: no photos.
    assert.equal((await fetch(`${s.display}/api/photo/${PHOTO}`, { headers: { cookie: devCookie } })).status, 403);
    // Unknown device cookie: refused.
    assert.equal((await fetch(`${s.display}/api/photo/${PHOTO}`, { headers: { cookie: "cv_device=dev-xxxxxxxxxxxx.nope" } })).status, 401);

    // Admin makes a view with the album and pairs the display to a new screen.
    const view = (await agent("POST", `${s.admin}/api/views`, { name: "Frame" })).data;
    const draft = { ...view.draft, widgets: view.draft.widgets.map((w) => (w.type === "photos" ? { ...w, props: { ...w.props, albumId: ALBUM } } : w)) };
    assert.equal((await agent("PUT", `${s.admin}/api/views/${view.id}/draft`, { draft })).status, 200);
    assert.equal((await agent("POST", `${s.admin}/api/views/${view.id}/publish`)).status, 200);
    const pair = await agent("POST", `${s.admin}/api/pair`, { code: first.code.toLowerCase(), name: "Bedroom" });
    assert.equal(pair.status, 200, JSON.stringify(pair.data));
    assert.equal(pair.data.warning, null);
    assert.equal((await agent("PATCH", `${s.admin}/api/screens/${pair.data.screenId}`, { viewId: view.id })).status, 200);

    // The display now gets its view and may load that album's photo.
    const again = await (await fetch(`${s.display}/api/hello`, { method: "POST", headers: { cookie: devCookie, "User-Agent": OLD_UA, "Content-Type": "application/json" }, body: "{}" })).json();
    assert.equal(again.paired, true);
    assert.equal(again.screen.name, "Bedroom");
    assert.equal(again.view.widgets.find((w) => w.type === "photos").props.albumId, ALBUM);
    const photo = await fetch(`${s.display}/api/photo/${PHOTO}`, { headers: { cookie: devCookie } });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get("content-type"), "image/jpeg");
    // But not an album that isn't on its screen.
    assert.equal((await fetch(`${s.display}/api/album/99999999-2222-3333-4444-555555555555`, { headers: { cookie: devCookie } })).status, 403);

    // The admin sees the device with its Chrome version and no key material.
    const state = (await agent("GET", `${s.admin}/api/state`)).data;
    assert.equal(state.devices[0].chrome, 44);
    assert.ok(!JSON.stringify(state).includes("keyHash"));

    // Unpair: the old cookie stops working.
    assert.equal((await agent("POST", `${s.admin}/api/devices/${state.devices[0].id}/unpair`)).status, 200);
    assert.equal((await fetch(`${s.display}/api/photo/${PHOTO}`, { headers: { cookie: devCookie } })).status, 401);
  } finally { s.close(); }
});

test("a screen's live stream receives the published view", async () => {
  const s = await start();
  try {
    const hello = await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const { code } = await hello.json();
    const cookie = hello.headers.get("set-cookie").split(";")[0];
    const view = (await agent("POST", `${s.admin}/api/views`, { name: "V" })).data;
    const pair = await agent("POST", `${s.admin}/api/pair`, { code, name: "Kitchen" });
    await agent("PATCH", `${s.admin}/api/screens/${pair.data.screenId}`, { viewId: view.id });

    const events = [];
    const ctrl = new AbortController();
    const stream = fetch(`${s.display}/api/stream`, { headers: { cookie }, signal: ctrl.signal }).then(async (r) => {
      const reader = r.body.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString();
        for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) events.push([m[1], JSON.parse(m[2])]);
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const draft = { ...view.draft, widgets: [...view.draft.widgets, { id: "t1", type: "text", x: 10, y: 10, w: 30, h: 10, props: { text: "Hi" } }] };
    await agent("PUT", `${s.admin}/api/views/${view.id}/draft`, { draft });
    await agent("POST", `${s.admin}/api/views/${view.id}/publish`);
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await stream;
    const inits = events.filter(([e]) => e === "init");
    assert.ok(inits.length >= 2, "initial view + republished view");
    assert.ok(inits.at(-1)[1].view.widgets.some((w) => w.id === "t1"));
  } finally { s.close(); }
});

test("publishing a linked view reaches screens that only link to it", async () => {
  const s = await start();
  try {
    const hello = await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const { code } = await hello.json();
    const cookie = hello.headers.get("set-cookie").split(";")[0];
    const welcome = (await agent("POST", `${s.admin}/api/views`, { name: "Welcome" })).data;
    const board = (await agent("POST", `${s.admin}/api/views`, { name: "Board" })).data;
    await agent("PUT", `${s.admin}/api/views/${welcome.id}/draft`, { draft: { ...welcome.draft, touchView: board.id } });
    await agent("POST", `${s.admin}/api/views/${welcome.id}/publish`);
    const pair = await agent("POST", `${s.admin}/api/pair`, { code, name: "Dining" });
    await agent("PATCH", `${s.admin}/api/screens/${pair.data.screenId}`, { viewId: welcome.id });

    const events = [];
    const ctrl = new AbortController();
    const stream = fetch(`${s.display}/api/stream`, { headers: { cookie }, signal: ctrl.signal }).then(async (r) => {
      const reader = r.body.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString();
        for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) events.push([m[1], JSON.parse(m[2])]);
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    // The board (not the screen's main view) gains an idle return to Welcome.
    await agent("PUT", `${s.admin}/api/views/${board.id}/draft`, { draft: { ...board.draft, idleView: welcome.id, idleSeconds: 180 } });
    const pub = await agent("POST", `${s.admin}/api/views/${board.id}/publish`);
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await stream;
    assert.equal(pub.data.screens, 1, "the linking screen counts");
    const last = events.filter(([e]) => e === "init").at(-1)[1];
    assert.equal(last.viewId, welcome.id, "main view unchanged");
    assert.equal(last.views[board.id].idleView, welcome.id, "the screen got the republished board");
  } finally { s.close(); }
});

test("a sign-in survives a restart and the store holds no usable cookie", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvs-"));
  fs.writeFileSync(path.join(dir, "setup_code"), "c0de");
  const env = { DATA_DIR: dir, COOKIE_SECURE: "0", SETUP_CODE_FILE: path.join(dir, "setup_code") };
  const a = createApp(env, { immich: fakeImmich(), overlays: fakeOverlays });
  const sid = a.auth.setup("admin", "longenough", "c0de");
  a.stop();
  const b = createApp(env, { immich: fakeImmich(), overlays: fakeOverlays });
  assert.equal(b.auth.who({ sessionId: sid }), "admin");
  assert.ok(!fs.readFileSync(path.join(dir, "studio.json"), "utf8").includes(sid));
  b.auth.logout(sid);
  assert.equal(b.auth.who({ sessionId: sid }), null);
  b.stop();
});

test("live camera: pipes Frigate's MJPEG stream and refuses anything else", async () => {
  const { createOverlayWatcher } = require("../lib/overlay");
  const fake = (type, chunks) => async (u) => {
    assert.match(u, /\/api\/back_patio\?h=720$/);
    return new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }),
      { status: 200, headers: { "content-type": type } });
  };
  async function get(watcher) {
    const srv = http.createServer(async (req, res) => {
      if (!(await watcher.liveStream("back_patio", res))) { res.writeHead(502); res.end(); }
    }).listen(0);
    const rsp = await fetch(`http://127.0.0.1:${srv.address().port}/`);
    const text = await rsp.text();
    srv.close();
    return { rsp, text };
  }
  const live = await get(createOverlayWatcher({ url: "http://frigate", screens: () => [], fetchImpl: fake("multipart/x-mixed-replace;boundary=frame", ["--frame\r\n", "jpeg"]) }));
  assert.equal(live.rsp.status, 200);
  assert.match(live.rsp.headers.get("content-type"), /^multipart\/x-mixed-replace/);
  assert.equal(live.rsp.headers.get("x-accel-buffering"), "no");
  assert.equal(live.text, "--frame\r\njpeg");
  const still = await get(createOverlayWatcher({ url: "http://frigate", screens: () => [], fetchImpl: fake("text/html", ["nope"]) }));
  assert.equal(still.rsp.status, 502);
});

// A household stand-in that records what screens asked for.
function fakeHousehold() {
  const calls = [];
  const rec = (name) => async (...args) => { calls.push([name, ...args]); };
  return {
    calls, sync() {}, onStates() {}, refreshAll() {}, start() { return this; }, stop() {}, on() {},
    snapshot: (keys) => Object.fromEntries(keys.map((k) => [k, { ok: true, items: [], events: [] }])),
    cameraMedia: async () => null,
    calendarAdd: rec("calendarAdd"), calendarErase: rec("calendarErase"), todoAdd: rec("todoAdd"), todoCheck: rec("todoCheck"), service: rec("service")
  };
}

test("household widgets: rows are cleaned and the view says what data it needs", () => {
  const v = cleanView({ widgets: [
    { id: "cal", type: "calendar", props: { calendars: [{ entity: "calendar.family", name: "Family" }, { entity: "", name: "blank" }, { entity: "light.nope" }] } },
    { id: "kids", type: "chores", props: { kids: [{ entity: "todo.sam_s_chores", name: "Sam" }] } },
    { id: "sky", type: "sky", props: { entity: "weather.forecast_home" } }
  ] });
  assert.deepEqual(v.widgets[0].props.calendars.map((c) => c.entity), ["calendar.family"]);
  const { viewNeeds } = require("../lib/widgets");
  const n = viewNeeds(v);
  assert.deepEqual(n.data.sort(), ["cal:calendar.family", "fc:weather.forecast_home", "todo:todo.sam_s_chores"]);
  assert.ok(n.entities.includes("sun.sun") && !n.entities.includes("calendar.family"));
});

test("status tile and icons: rows keep optional status entities and feed the state list", () => {
  const v = cleanView({ accentFont: "fraunces", font: "manrope", widgets: [
    { id: "laundry", type: "status", props: { items: [{ entity: "input_boolean.washer", status: "input_text.washer_status", name: "Washer" }, { entity: "input_boolean.dryer", name: "Dryer" }, { status: "input_text.orphan" }] } },
    { id: "doors", type: "icons", props: { items: [{ entity: "binary_sensor.back", name: "Back", kind: "door" }, { entity: "climate.living", kind: "oven" }] } },
    { id: "house", type: "panel", props: { title: "House" } }
  ] });
  assert.equal(v.accentFont, "fraunces");
  assert.equal(v.widgets[0].props.items.length, 2);
  assert.equal(v.widgets[0].props.items[1].status, "");
  assert.equal(v.widgets[1].props.items[1].kind, "door");
  const { viewNeeds } = require("../lib/widgets");
  const ids = viewNeeds(v).entities;
  for (const e of ["input_boolean.washer", "input_text.washer_status", "input_boolean.dryer", "binary_sensor.back", "climate.living"]) assert.ok(ids.includes(e), e);
});

test("night dim: cleaned on save and sent to the display", async () => {
  const s = await start({ household: fakeHousehold() });
  try {
    const hello = await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ w: 1080, h: 1920 }) });
    const code = (await hello.json()).code, cookie = hello.headers.get("set-cookie").split(";")[0];
    const paired = (await agent("POST", `${s.admin}/api/pair`, { code, name: "Kitchen tablet" })).data;
    const saved = (await agent("PATCH", `${s.admin}/api/screens/${paired.screenId}`, { nightDim: { on: true, from: 22, to: 99, brightness: 5 } })).data;
    assert.deepEqual(saved.nightDim, { on: true, from: 22, to: 23, brightness: 1 });
    const again = await (await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" })).json();
    assert.deepEqual(again.screen.nightDim, saved.nightDim);
  } finally { s.close(); }
});

test("whiteboard: linked views, Grandkids mode with a PIN, drawing pages", async () => {
  const s = await start({ household: fakeHousehold() });
  try {
    const hello = await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ w: 1024, h: 768 }) });
    const code = (await hello.json()).code, cookie = hello.headers.get("set-cookie").split(";")[0];
    const mk = async (name) => (await agent("POST", `${s.admin}/api/views`, { name, aspect: { w: 1024, h: 768 } })).data.id;
    const idle = await mk("Photos"), board = await mk("Board"), draw = await mk("Draw"), other = await mk("Unrelated");
    const put = async (id, draft) => { await agent("PUT", `${s.admin}/api/views/${id}/draft`, { draft: { aspect: { w: 1024, h: 768 }, ...draft } }); await agent("POST", `${s.admin}/api/views/${id}/publish`); };
    await put(idle, { touchView: board, widgets: [{ id: "st", type: "sticky", props: { calendars: [{ entity: "calendar.grandma", name: "Me" }] } }] });
    await put(board, { idleView: idle, widgets: [
      { id: "cal", type: "wbcal", props: { calendars: [{ entity: "calendar.grandma", name: "Me" }], allowAdd: true, allowErase: true } },
      { id: "tile", type: "drawtile", props: { board: "grandma", view: draw } }] });
    await put(draw, { idleView: idle, widgets: [{ id: "d", type: "drawing", props: { board: "grandma", backView: board } }] });
    await put(other, { widgets: [{ id: "x", type: "drawing", props: { board: "secret" } }] });
    const paired = (await agent("POST", `${s.admin}/api/pair`, { code, name: "Grandma" })).data;
    const scr = (await agent("PATCH", `${s.admin}/api/screens/${paired.screenId}`, { viewId: idle, pin: "2026" })).data;
    assert.equal(scr.pin, undefined); assert.equal(scr.hasPin, true);
    const dget = (u) => fetch(`${s.display}${u}`, { headers: { Cookie: cookie } });
    const dsend = (m, u, b) => fetch(`${s.display}${u}`, { method: m, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const init = await (await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" })).json();
    assert.deepEqual(Object.keys(init.views).sort(), [board, draw, idle].sort());
    assert.equal(init.viewId, idle); assert.equal(init.screen.pinLength, 4);

    const png = "data:image/png;base64,iVBORw0KGgo=";
    assert.equal((await dsend("PUT", "/api/board/grandma/notes", { img: png })).status, 200);
    assert.equal((await dget("/api/board/grandma/notes.png")).status, 200);
    assert.equal((await dsend("PUT", "/api/board/secret/notes", { img: png })).status, 403);

    assert.equal((await dsend("POST", "/api/kids", { on: true })).status, 200);
    assert.equal((await dsend("POST", "/api/act", { widget: "cal", action: "add", cal: 0, title: "x", day: "2026-10-12", min: null })).status, 423);
    assert.equal((await dsend("PUT", "/api/board/grandma/notes", { img: png })).status, 423);
    assert.equal((await dsend("PUT", "/api/board/grandma/play", { img: png })).status, 200);
    assert.equal((await dsend("POST", "/api/kids", { on: false, pin: "1111" })).status, 403);
    assert.equal((await dsend("POST", "/api/kids", { on: false, pin: "2026" })).status, 200);
    assert.equal((await dsend("POST", "/api/act", { widget: "cal", action: "add", cal: 0, title: "Hair", day: "2026-10-12", min: 630 })).status, 200);
  } finally { s.close(); }
});

test("interactive widgets: only allowed actions, on configured lists, from this screen", async () => {
  const household = fakeHousehold();
  const s = await start({ household });
  try {
    const hello = await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ w: 1080, h: 1920 }) });
    const code = (await hello.json()).code, cookie = hello.headers.get("set-cookie").split(";")[0];
    const view = (await agent("POST", `${s.admin}/api/views`, { name: "Board", aspect: { w: 1080, h: 1920 } })).data;
    const widgets = [
      { id: "shop", type: "todo", x: 0, y: 0, w: 50, h: 10, props: { entity: "todo.shopping_list", allowAdd: true, allowCheck: false } },
      { id: "cal", type: "calendar", x: 0, y: 10, w: 50, h: 30, props: { calendars: [{ entity: "calendar.family", name: "Family" }], allowAdd: false, allowErase: true } },
      { id: "kids", type: "chores", x: 0, y: 40, w: 50, h: 10, props: { kids: [{ entity: "todo.sam_s_chores", name: "Sam" }] } },
      { id: "dogs", type: "since", x: 0, y: 50, w: 50, h: 10, props: { entity: "input_datetime.dogs_out", script: "script.record_dogs_out" } },
      { id: "gary", type: "button", x: 0, y: 60, w: 50, h: 10, props: { action: "vacuum", entity: "vacuum.gary" } },
      { id: "doors", type: "icons", x: 0, y: 70, w: 50, h: 5, props: { items: [{ entity: "", name: "Matrix", kind: "matrix" }], playMinutes: 5 } },
      { id: "temps", type: "icons", x: 0, y: 75, w: 50, h: 5, props: { items: [{ entity: "climate.living", name: "Inside", kind: "temp" }] } }
    ];
    await agent("PUT", `${s.admin}/api/views/${view.id}/draft`, { draft: { ...view.draft, widgets } });
    await agent("POST", `${s.admin}/api/views/${view.id}/publish`);
    const pair = await agent("POST", `${s.admin}/api/pair`, { code, name: "Kitchen" });
    await agent("PATCH", `${s.admin}/api/screens/${pair.data.screenId}`, { viewId: view.id });
    const act = (body) => fetch(`${s.display}/api/act`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);

    assert.equal(await act({ widget: "shop", action: "add", text: "Eggs" }), 200);
    assert.equal(await act({ widget: "shop", action: "check", uid: "x", done: true }), 403);       // allowCheck off
    assert.equal(await act({ widget: "cal", action: "add", cal: 0, title: "x", date: "2026-10-10" }), 403); // allowAdd off
    assert.equal(await act({ widget: "cal", action: "erase", calendar: "calendar.family", uid: "u1" }), 200);
    assert.equal(await act({ widget: "cal", action: "erase", calendar: "calendar.other", uid: "u1" }), 400); // not configured
    assert.equal(await act({ widget: "kids", action: "check", kid: 0, uid: "k1", done: true }), 200);
    assert.equal(await act({ widget: "kids", action: "check", kid: 5, uid: "k1", done: true }), 400);
    assert.equal(await act({ widget: "dogs", action: "run" }), 200);
    assert.equal(await act({ widget: "gary", action: "press", what: "dock" }), 200);
    assert.equal(await act({ widget: "nope", action: "add" }), 403);
    assert.equal(await act({ widget: "temps", action: "matrix", what: "show", play: { line1: "hi" } }), 403); // no Matrix icon there
    // No Matrix target in this test server (no MQTT): refused, not crashed.
    assert.equal(await act({ widget: "doors", action: "matrix", what: "show", play: { line1: "hi" } }), 409);
    assert.deepEqual(household.calls.map((c) => c[0] + ":" + c[1]), [
      "todoAdd:todo.shopping_list", "calendarErase:calendar.family", "todoCheck:todo.sam_s_chores",
      "service:script", "service:vacuum"
    ]);
    assert.deepEqual(household.calls[4].slice(1), ["vacuum", "return_to_base", { entity_id: "vacuum.gary" }]);
    // Unknown device: refused outright.
    assert.equal((await fetch(`${s.display}/api/act`, { method: "POST", headers: { cookie: "cv_device=dev-xxxxxxxxxxxx.nope" }, body: "{}" })).status, 401);
  } finally { s.close(); }
});

test("settings: connection info shows no secrets; tests report what's missing", async () => {
  const s = await start();
  try {
    const r = await agent("GET", `${s.admin}/api/settings`);
    assert.equal(r.status, 200);
    assert.equal(r.data.version, require("../package.json").version);
    const ha = r.data.connections.find((c) => c.id === "homeAssistant");
    assert.equal(ha.configured, false);
    assert.ok(!JSON.stringify(r.data).includes("test-agent-token"));
    const t = await agent("POST", `${s.admin}/api/settings/test/homeAssistant`);
    assert.equal(t.data.ok, false);
    assert.match(t.data.detail, /No address yet/);
    assert.equal((await agent("POST", `${s.admin}/api/settings/test/immich`)).data.ok, true, "fake Immich answers");
    assert.equal((await agent("POST", `${s.admin}/api/settings/test/nope`)).status, 404);
    assert.equal((await fetch(`${s.admin}/api/settings`)).status, 401, "needs sign-in");
  } finally { s.close(); }
});

test("change password: needs the current one and signs out other browsers", async () => {
  const s = await start();
  try {
    const post = (p, body, headers = {}) => fetch(`${s.admin}${p}`, { method: "POST", headers: { "X-Studio": "1", Origin: s.admin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const c1 = (await post("/api/setup", { code: "letmein-123", username: "admin", password: "longenough" })).headers.get("set-cookie").split(";")[0];
    const c2 = (await post("/api/login", { username: "admin", password: "longenough" })).headers.get("set-cookie").split(";")[0];
    assert.equal((await post("/api/account/password", { current: "wrong-one", next: "evenlonger" }, { cookie: c1 })).status, 403);
    await new Promise((r) => setTimeout(r, 1100)); // one failed try per second
    assert.equal((await post("/api/account/password", { current: "longenough", next: "short" }, { cookie: c1 })).status, 400);
    assert.equal((await post("/api/account/password", { current: "longenough", next: "evenlonger" }, { cookie: c1 })).status, 200);
    assert.equal((await fetch(`${s.admin}/api/state`, { headers: { cookie: c1 } })).status, 200, "this browser stays signed in");
    assert.equal((await fetch(`${s.admin}/api/state`, { headers: { cookie: c2 } })).status, 401, "the other one is signed out");
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await post("/api/login", { username: "admin", password: "evenlonger" })).status, 200);
    assert.equal((await agent("POST", `${s.admin}/api/account/password`, { current: "evenlonger", next: "whatever123" })).status, 403, "not with the agent token");
  } finally { s.close(); }
});

test("backup and restore: round trip, junk refused, sign-in untouched", async () => {
  const s = await start();
  try {
    const post = (p, body) => fetch(`${s.admin}${p}`, { method: "POST", headers: { "X-Studio": "1", Origin: s.admin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post("/api/setup", { code: "letmein-123", username: "admin", password: "longenough" });
    const hello = await fetch(`${s.display}/api/hello`, { method: "POST", headers: { "User-Agent": OLD_UA, "Content-Type": "application/json" }, body: "{}" });
    const devCookie = hello.headers.get("set-cookie").split(";")[0];
    const { code } = await hello.json();
    const pair = await agent("POST", `${s.admin}/api/pair`, { code, name: "Hall" });
    await agent("PATCH", `${s.admin}/api/screens/${pair.data.screenId}`, { pin: "1234" });

    const dl = await fetch(`${s.admin}/api/backup`, { headers: { Authorization: "Bearer test-agent-token" } });
    assert.match(dl.headers.get("content-disposition"), /attachment; filename="coreview-studio-backup-/);
    const backup = await dl.json();
    const text = JSON.stringify(backup);
    assert.ok(!text.includes("\"admin\"") && !text.includes("sessions"), "no password or sign-ins in a backup");
    assert.equal(Object.keys(backup.data.screens).length, 1);

    // Change things, then restore.
    await agent("PATCH", `${s.admin}/api/screens/${pair.data.screenId}`, { name: "Renamed" });
    await agent("POST", `${s.admin}/api/screens`, { name: "Extra" });
    const tampered = JSON.parse(text);
    tampered.data.views["../evil"] = { name: "x" };
    tampered.data.screens[pair.data.screenId].evil = "<script>";
    const r = await agent("POST", `${s.admin}/api/restore`, tampered);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { screens: 1, views: 1, displays: 1 });
    const st = (await agent("GET", `${s.admin}/api/state`)).data;
    assert.deepEqual(st.screens.map((x) => x.name), ["Hall"]);
    assert.equal(st.screens[0].hasPin, true);
    assert.ok(!("evil" in s.app.store.data.screens[pair.data.screenId]));
    assert.ok(!s.app.store.data.views["../evil"]);
    // The display is still paired, the admin still signed up, the old file kept.
    assert.equal((await fetch(`${s.display}/api/hello`, { method: "POST", headers: { cookie: devCookie, "Content-Type": "application/json" }, body: "{}" }).then((x) => x.json())).paired, true);
    assert.equal(s.app.store.data.admin.username, "admin");
    assert.ok(fs.readdirSync(s.dir).some((f) => f.startsWith("studio.json.before-restore-")));

    assert.equal((await agent("POST", `${s.admin}/api/restore`, { kind: "something-else" })).status, 400);
    assert.equal((await agent("POST", `${s.admin}/api/restore`, { ...backup, data: { ...backup.data, views: {} } })).status, 400);
  } finally { s.close(); }
});
