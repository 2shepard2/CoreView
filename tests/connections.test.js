// Connection settings: server vs. browser, keys bound to their address.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConnections, cleanUrl, SERVICES } = require("../lib/connections");
const { createApp } = require("../server");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cvs-conn-"));

test("server settings lock the whole service; SETTINGS_LOCK locks all", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "ha_token"), "server-token");
  const c = createConnections({ env: { HA_TOKEN_FILE: path.join(dir, "ha_token") }, dataDir: dir });
  assert.equal(c.get("homeAssistant").source, "server", "a key file alone counts");
  assert.equal(c.locked("homeAssistant"), true);
  assert.throws(() => c.save("homeAssistant", { url: "http://evil.example:8123" }), /set on the server/);
  assert.equal(c.locked("immich"), false);
  const locked = createConnections({ env: { SETTINGS_LOCK: "1" }, dataDir: tmp() });
  assert.throws(() => locked.save("immich", { url: "http://immich.local:2283" }), /locked/);
});

test("a saved key stays with its address and never comes back out", () => {
  const dir = tmp();
  const c = createConnections({ env: {}, dataDir: dir });
  assert.equal(c.save("immich", { url: "http://immich.local:2283/", secret: "  key-1 " }), true);
  assert.deepEqual(c.get("immich"), { url: "http://immich.local:2283", username: "", secret: "key-1", source: "browser" });
  assert.equal((fs.statSync(path.join(dir, "connections.json")).mode & 0o777), 0o600);
  const d = c.describe("immich");
  assert.equal(d.secret.set, true);
  assert.ok(!JSON.stringify(d).includes("key-1"));
  // Same address, no key typed: the saved key stays.
  assert.equal(c.draft("immich", { url: "http://immich.local:2283" }).secret, "key-1");
  // Another address: the saved key is not used, in a draft or on save.
  assert.equal(c.draft("immich", { url: "http://other.example:2283" }).secret, "");
  c.save("immich", { url: "http://other.example:2283" });
  assert.equal(c.get("immich").secret, "");
  // Remove the key on purpose; blank address turns it off.
  c.save("immich", { url: "http://other.example:2283", secret: "key-2" });
  c.save("immich", { url: "http://other.example:2283", clearSecret: true });
  assert.equal(c.get("immich").secret, "");
  c.save("immich", { url: "" });
  assert.equal(c.get("immich").source, "none");
  // Reloads from disk.
  c.save("frigate", { url: "http://frigate.local:5000" });
  assert.equal(createConnections({ env: {}, dataDir: dir }).get("frigate").url, "http://frigate.local:5000");
});

test("addresses are checked", () => {
  assert.throws(() => cleanUrl(SERVICES.homeAssistant, "http://user:pw@ha.local:8123"), /Leave the user name/);
  assert.throws(() => cleanUrl(SERVICES.mqtt, "http://ha.local:1883"), /mqtt:\/\//);
  assert.throws(() => cleanUrl(SERVICES.immich, "immich.local"), /isn't an address/);
  assert.throws(() => cleanUrl(SERVICES.immich, "http://immich.local/?x=1"), /query/);
  assert.equal(cleanUrl(SERVICES.immich, " http://immich.local:2283/ "), "http://immich.local:2283");
});

test("Settings API: password again, tests before saving, key never sent to a new address", async () => {
  const seen = [];
  const fakeHa = (name) => http.createServer((req, res) => {
    seen.push({ name, path: req.url, auth: req.headers.authorization || "" });
    if (req.url === "/api/config") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ location_name: name, version: "2026.10" })); }
    else { res.statusCode = 404; res.end(); }
  }).listen(0);
  const a = fakeHa("Home A"), b = fakeHa("Home B");
  await Promise.all([a, b].map((s) => new Promise((r) => s.once("listening", r))));
  const urlA = `http://127.0.0.1:${a.address().port}`, urlB = `http://127.0.0.1:${b.address().port}`;

  const dir = tmp();
  fs.writeFileSync(path.join(dir, "setup_code"), "code-1");
  fs.writeFileSync(path.join(dir, "agent_token"), "agent-1");
  const fakeOverlays = { start() { return this; }, stop() {}, listCameras: async () => [] };
  const app = createApp({ DATA_DIR: dir, COOKIE_SECURE: "0", SETUP_CODE_FILE: path.join(dir, "setup_code"), AGENT_TOKEN_FILE: path.join(dir, "agent_token") },
    { overlays: fakeOverlays }).start();
  const srv = http.createServer(app.adminHandler).listen(0);
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (method, p, body, cookie) => fetch(base + p, { method, headers: { "X-Studio": "1", Origin: base, "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null), headers: r.headers }));
  const pause = () => new Promise((r) => setTimeout(r, 1100));
  try {
    const setup = await call("POST", "/api/setup", { code: "code-1", username: "admin", password: "longenough" });
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    const put = (id, body) => call("PUT", `/api/settings/connections/${id}`, body, cookie);

    // Wrong password: refused, nothing saved.
    assert.equal((await put("homeAssistant", { url: urlA, secret: "tok-A", password: "nope-nope" })).status, 403);
    await pause();
    // Right password: tested against A with the new token, then saved.
    const ok = await put("homeAssistant", { url: urlA, secret: "tok-A", password: "longenough" });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.source, "browser");
    assert.equal(ok.data.test.ok, true);
    assert.ok(!JSON.stringify(ok.data).includes("tok-A"));
    assert.deepEqual(seen.pop(), { name: "Home A", path: "/api/config", auth: "Bearer tok-A" });

    // A draft test for another address without a token: B is never called.
    const draftB = await call("POST", "/api/settings/test/homeAssistant", { draft: { url: urlB } }, cookie);
    assert.deepEqual(draftB.data, { ok: false, detail: "No access token yet" });
    assert.equal(seen.filter((x) => x.name === "Home B").length, 0);
    // Same address, no token typed: the saved one is used.
    assert.equal((await call("POST", "/api/settings/test/homeAssistant", { draft: { url: urlA } }, cookie)).data.ok, true);
    assert.equal(seen.pop().auth, "Bearer tok-A");
    // Saving another address without a token forgets the saved one.
    const moved = await put("homeAssistant", { url: urlB, password: "longenough", force: true });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.secret.set, false);
    assert.equal(seen.filter((x) => x.name === "Home B").length, 0, "the old token never reached B");

    // A failing test blocks the save until "save anyway".
    const dead = "http://127.0.0.1:9";
    const refused = await put("frigate", { url: dead, password: "longenough" });
    assert.equal(refused.status, 422);
    assert.equal(refused.data.testFailed, true);
    assert.equal((await put("frigate", { url: dead, password: "longenough", force: true })).status, 200);

    // The agent token can test but not change connections; GET never has keys.
    const agent = (method, p, body) => fetch(base + p, { method, headers: { Authorization: "Bearer agent-1", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await agent("PUT", "/api/settings/connections/frigate", { url: dead, password: "longenough", force: true })).status, 403);
    const info = await (await agent("GET", "/api/settings")).json();
    assert.equal(info.connections.find((x) => x.id === "frigate").url, dead);
    assert.ok(!JSON.stringify(info).includes("tok-A"));
    assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, "studio.json"), "utf8"))).includes("tok-A"), "keys aren't in studio.json (or backups)");
  } finally { app.stop(); srv.close(); a.close(); b.close(); }
});

// Codex review MSG-bfb92adb984e: two ways a key could reach the wrong server.
test("keys never follow a redirect or reach an old address after a change", async () => {
  const hits = [];
  const server = (name, handler) => { const s = http.createServer((req, res) => { hits.push({ name, path: req.url.split("?")[0], key: req.headers["x-api-key"] || "" }); handler(req, res); }).listen(0); return s; };
  const json = (res, v) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(v)); };
  const sink = server("sink", (req, res) => json(res, []));
  const redirector = server("redirector", (req, res) => { res.statusCode = 302; res.setHeader("Location", `http://127.0.0.1:${sink.address().port}${req.url}`); res.end(); });
  const slowOld = server("old", (req, res) => {
    if (req.url.startsWith("/api/albums/")) setTimeout(() => json(res, {}), 400); // album header, slow
    else if (req.url.startsWith("/api/search/metadata")) json(res, { assets: { items: [], nextCursor: null } });
    else json(res, []);
  });
  const fresh = server("new", (req, res) => json(res, []));
  await Promise.all([sink, redirector, slowOld, fresh].map((s) => new Promise((r) => (s.listening ? r() : s.once("listening", r)))));
  const at = (s) => `http://127.0.0.1:${s.address().port}`;

  const dir = tmp();
  fs.writeFileSync(path.join(dir, "setup_code"), "code-1");
  const app = createApp({ DATA_DIR: dir, COOKIE_SECURE: "0", SETUP_CODE_FILE: path.join(dir, "setup_code") },
    { overlays: { start() { return this; }, stop() {}, listCameras: async () => [] } }).start();
  const srv = http.createServer(app.adminHandler).listen(0);
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (method, p, body, cookie) => fetch(base + p, { method, headers: { "X-Studio": "1", Origin: base, "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null), headers: r.headers }));
  try {
    const cookie = (await call("POST", "/api/setup", { code: "code-1", username: "admin", password: "longenough" })).headers.get("set-cookie").split(";")[0];
    // 1. A redirect to another site: refused, the sink never sees the key.
    const t = await call("POST", "/api/settings/test/immich", { draft: { url: at(redirector), secret: "key-redirect" } }, cookie);
    assert.equal(t.data.ok, false);
    assert.equal(hits.filter((h) => h.name === "sink").length, 0);

    // 2. Old client mid-request while the address changes: its next request
    //    must not carry the new key to the old server.
    assert.equal((await call("PUT", "/api/settings/connections/immich", { url: at(slowOld), secret: "key-old", password: "longenough" }, cookie)).status, 200);
    const pending = call("GET", "/api/immich/album/11111111-2222-3333-4444-555555555555", null, cookie);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call("PUT", "/api/settings/connections/immich", { url: at(fresh), secret: "key-new", password: "longenough" }, cookie)).status, 200);
    await pending;
    assert.ok(hits.some((h) => h.name === "old" && h.path === "/api/search/metadata"), "the old client did continue");
    assert.deepEqual(hits.filter((h) => h.name === "old").map((h) => h.key).filter((k) => k && k !== "key-old"), [], "the new key never went to the old address");
    assert.ok(hits.some((h) => h.name === "new" && h.key === "key-new"));
  } finally { app.stop(); for (const s of [srv, sink, redirector, slowOld, fresh]) { s.closeAllConnections(); s.close(); } }
});
