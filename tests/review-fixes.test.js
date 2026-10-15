// Codex review MSG-d957fec625af: one test per finding.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createApp } = require("../server");
const { createOverlayWatcher } = require("../lib/overlay");
const { createHousehold } = require("../lib/household");
const { createMqtt } = require("../lib/mqtt");
const { createConnections } = require("../lib/connections");
const { exportBackup } = require("../lib/backup");
const { cleanTarget, BEACON_DEFAULTS } = require("../lib/matrix");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cvs-fix-"));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const quietOverlays = { start() { return this; }, stop() {}, listCameras: async () => [] };

test("1. a restore never moves the Matrix revision backwards", async () => {
  const http = require("node:http");
  const app = createApp({ DATA_DIR: tmp(), COOKIE_SECURE: "0" }, { overlays: quietOverlays });
  const srv = http.createServer(app.adminHandler).listen(0);
  await new Promise((r) => srv.once("listening", r));
  try {
    app.store.update((d) => { d.matrix = { targets: { [BEACON_DEFAULTS.id]: { ...cleanTarget(BEACON_DEFAULTS), revision: 5 } } }; });
    const old = JSON.parse(JSON.stringify(exportBackup(app.store.data))); // a backup is a file, not live objects
    app.store.update((d) => { d.matrix.targets[BEACON_DEFAULTS.id].revision = 900; });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const r = await fetch(`${base}/api/restore`, { method: "POST", body: JSON.stringify(old),
      headers: { cookie: `cv_session=${app.auth.createSession("admin")}`, "X-Studio": "1", Origin: base, "Content-Type": "application/json" } });
    assert.equal(r.status, 200);
    assert.equal(app.store.data.matrix.targets[BEACON_DEFAULTS.id].revision, 900);
  } finally { app.stop(); srv.close(); }
});

test("2. a stopped Frigate watcher ignores a late answer and polls no more", async () => {
  let release, calls = 0;
  const gate = new Promise((r) => { release = r; });
  const fired = [];
  const w = createOverlayWatcher({
    url: "http://frigate.test", pollMs: 10,
    screens: () => [{ id: "s1", overlay: { enabled: true, cameras: ["door"], labels: ["person"], zones: {}, seconds: 30, cooldown: 0, activeStart: "", activeEnd: "" } }],
    onOverlay: (id) => fired.push(id),
    fetchImpl: async () => { calls++; await gate; return { ok: true, json: async () => [{ id: "e1", camera: "door", label: "person", start_time: 1 }] }; }
  });
  w.start();
  await tick(5);
  w.stop();
  release();
  await tick(60);
  assert.deepEqual(fired, [], "no pop-up from the replaced watcher");
  assert.equal(calls, 2, "no further polls (the first poll makes two requests)");
});

test("3. data from a replaced source is dropped; screens hear about the change", async () => {
  let releaseOld;
  const oldLab = { refresh: () => new Promise((r) => { releaseOld = () => r({ ok: true, hosts: ["old"] }); }) };
  const newLab = { refresh: async () => ({ ok: true, hosts: ["new"] }) };
  const hh = createHousehold({ hass: () => null, frigateUrl: "", lab: oldLab });
  const changes = [];
  hh.on("change", (keys) => changes.push(...keys));
  hh.sync({ calendars: [], todos: [], forecasts: [], cameras: {}, lab: true, jellyfin: false });
  await tick();
  hh.setSources({ lab: newLab });
  await tick();
  releaseOld();
  await tick();
  assert.deepEqual(hh.snapshot(["lab"]).lab.hosts, ["new"]);
  assert.ok(changes.filter((k) => k === "lab").length >= 2, "emitted on switch and on the new answer");
  hh.setSources({ lab: null });
  assert.equal(hh.snapshot(["lab"]).lab.ok, false, "switched off: screens stop showing the old data");
  hh.stop && hh.stop();
});

test("4. MQTT gives up on a broker that never answers and tries again", async () => {
  let attempts = 0;
  const connectImpl = () => {
    attempts++;
    const s = new EventEmitter();
    s.setNoDelay = () => {}; s.write = () => true; s.destroy = () => {};
    setImmediate(() => s.emit("connect"));
    return s; // never sends CONNACK
  };
  const c = createMqtt({ url: "mqtt://broker.test", clientId: "t", connectTimeoutMs: 30, connectImpl });
  c.start();
  await tick(1200);
  c.stop();
  assert.ok(attempts >= 2, `retried after the silent connection (attempts: ${attempts})`);
});

test("5. a failed save changes nothing, and saving again works", () => {
  const dir = tmp();
  const c = createConnections({ env: {}, dataDir: dir });
  fs.mkdirSync(path.join(dir, "connections.json.tmp")); // the write will fail
  assert.throws(() => c.save("frigate", { url: "http://frigate.local:5000" }));
  assert.equal(c.get("frigate").source, "none");
  fs.rmdirSync(path.join(dir, "connections.json.tmp"));
  assert.equal(c.save("frigate", { url: "http://frigate.local:5000" }), true);
  assert.equal(c.get("frigate").url, "http://frigate.local:5000");
});
