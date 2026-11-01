const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { optionsToConfig, discoverMqtt, prepareFiles } = require("../ha-addon/run");
const { createHass } = require("../lib/hass");

const automatic = { token: "test-ha" };
const broker = { host: "core-mosquitto", port: 1883, username: "addon", password: "test-mqtt", ssl: false };

test("add-on version matches the package version", () => {
  const yaml = fs.readFileSync(path.join(__dirname, "../ha-addon/config.yaml"), "utf8");
  assert.equal(yaml.match(/^version:\s*"([^"]+)"$/m)?.[1], require("../package.json").version);
});

test("HA automatic connection uses Supervisor REST, socket and a token file", () => {
  const { env, secretFiles } = optionsToConfig({}, automatic);
  assert.equal(env.HA_URL, "http://supervisor/core");
  assert.equal(env.HA_WS_URL, "ws://supervisor/core/websocket");
  assert.equal(secretFiles[env.HA_TOKEN_FILE], automatic.token);
  assert.ok(!Object.values(env).includes(automatic.token));
  assert.throws(() => optionsToConfig({}), /Supervisor token required/);
});

test("HA auto off leaves all HA settings unset for Studio", () => {
  const result = optionsToConfig({ connect_home_assistant: false }, automatic);
  assert.equal(result.env.HA_URL, undefined);
  assert.equal(result.env.HA_WS_URL, undefined);
  assert.equal(result.env.HA_TOKEN_FILE, undefined);
  assert.deepEqual(result.secretFiles, {});
});

test("MQTT services response maps the broker and keeps its password out of env", () => {
  const { env, secretFiles } = optionsToConfig({}, { ...automatic, mqtt: broker });
  assert.equal(env.MQTT_URL, "mqtt://core-mosquitto:1883");
  assert.equal(env.MQTT_USERNAME, broker.username);
  assert.equal(secretFiles[env.MQTT_PASSWORD_FILE], broker.password);
  assert.ok(!Object.values(env).includes(broker.password));
  const ipv6 = optionsToConfig({}, { ...automatic, mqtt: { host: "::1", port: 1883 } });
  assert.equal(ipv6.env.MQTT_URL, "mqtt://[::1]:1883");
});

test("manual MQTT fully overrides service credentials; stray manual credentials don't mix", () => {
  const options = Object.freeze({ mqtt_url: " mqtt://example.local:1884 ", mqtt_username: "manual", mqtt_password: "test-manual" });
  const supervisor = Object.freeze({ ...automatic, mqtt: Object.freeze({ ...broker }) });
  const { env, secretFiles } = optionsToConfig(options, supervisor);
  assert.equal(env.MQTT_URL, "mqtt://example.local:1884");
  assert.equal(env.MQTT_USERNAME, "manual");
  assert.equal(secretFiles[env.MQTT_PASSWORD_FILE], "test-manual");
  const anonymous = optionsToConfig({ mqtt_url: "mqtt://example.local" }, supervisor);
  assert.equal(anonymous.env.MQTT_USERNAME, undefined);
  assert.equal(anonymous.env.MQTT_PASSWORD_FILE, undefined);
  const auto = optionsToConfig({ mqtt_username: "ignored", mqtt_password: "ignored" }, supervisor);
  assert.equal(auto.env.MQTT_USERNAME, broker.username);
  assert.equal(auto.secretFiles[auto.env.MQTT_PASSWORD_FILE], broker.password);
});

test("blank optional values leave integrations unset and preserve defaults", () => {
  const { env, secretFiles, messages } = optionsToConfig({ connect_home_assistant: false,
    immich_url: " ", immich_api_key: "", frigate_url: "", jellyfin_url: "", jellyfin_api_key: "",
    tomtom_api_key: "", prometheus_url: "", mqtt_url: " ", mqtt_username: "", mqtt_password: "", mqtt_topic_root: " " });
  assert.deepEqual(env, { DATA_DIR: "/data", COOKIE_SECURE: "0", SETTINGS_LOCK: "0", MQTT_TOPIC_ROOT: "home/signage" });
  assert.deepEqual(secretFiles, {});
  assert.equal(messages.length, 1);
  assert.equal(env.TZ, undefined);
});

test("other options map URLs, secret files, cookie and lock flags", () => {
  const { env, secretFiles } = optionsToConfig({ connect_home_assistant: false, cookie_secure: true, settings_lock: true,
    immich_url: "http://immich:2283", immich_api_key: "test-immich", frigate_url: "http://ccab4aaf-frigate:5000",
    jellyfin_url: "http://jellyfin:8096", jellyfin_api_key: "test-jellyfin", tomtom_api_key: "test-tomtom",
    prometheus_url: "http://prometheus:9090", mqtt_topic_root: "custom/signage" });
  assert.equal(env.COOKIE_SECURE, "1");
  assert.equal(env.SETTINGS_LOCK, "1");
  assert.equal(env.IMMICH_URL, "http://immich:2283");
  assert.equal(env.FRIGATE_URL, "http://ccab4aaf-frigate:5000");
  assert.equal(env.JELLYFIN_URL, "http://jellyfin:8096");
  assert.equal(env.PROMETHEUS_URL, "http://prometheus:9090");
  assert.equal(env.MQTT_TOPIC_ROOT, "custom/signage");
  assert.equal(secretFiles[env.IMMICH_KEY_FILE], "test-immich");
  assert.equal(secretFiles[env.JELLYFIN_KEY_FILE], "test-jellyfin");
  assert.equal(secretFiles[env.TOMTOM_KEY_FILE], "test-tomtom");
});

test("TLS MQTT is declined without handing credentials to the plain TCP client", () => {
  for (const result of [optionsToConfig({}, { ...automatic, mqtt: { ...broker, ssl: true } }),
    optionsToConfig({ mqtt_url: "mqtts://example.local:8883", mqtt_password: "test-manual" }, automatic)]) {
    assert.equal(result.env.MQTT_URL, undefined);
    assert.equal(result.env.MQTT_PASSWORD_FILE, undefined);
    assert.match(result.messages[0], /TLS MQTT is not supported/);
  }
  const malformed = optionsToConfig({}, { ...automatic, mqtt: { username: "unused", password: "unused" } });
  assert.equal(malformed.env.MQTT_USERNAME, undefined);
  assert.equal(malformed.env.MQTT_PASSWORD_FILE, undefined);
});

test("services API uses bearer auth and handles missing, bad and unavailable brokers", async () => {
  const mqtt = await discoverMqtt(automatic.token, async (url, options) => {
    assert.equal(url, "http://supervisor/services/mqtt");
    assert.equal(options.headers.Authorization, `Bearer ${automatic.token}`);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ result: "ok", data: broker }) };
  });
  assert.deepEqual(mqtt, broker);
  assert.equal(await discoverMqtt("", () => { throw new Error("must not fetch"); }), null);
  for (const fetchImpl of [async () => ({ ok: false }), async () => { throw new Error("offline"); },
    async () => ({ ok: true, json: async () => ({ result: "error" }) }),
    async () => ({ ok: true, json: async () => { throw new Error("bad JSON"); } })]) {
    assert.equal(await discoverMqtt(automatic.token, fetchImpl), null);
  }
});

test("runtime files are private, persistent secrets survive restart, option secrets rotate", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coreview-addon-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), secrets = path.join(root, "tmp-secrets");
  const first = prepareFiles(optionsToConfig({}, automatic), data, secrets);
  const before = Object.fromEntries(Object.entries(first).map(([key, file]) => [key, fs.readFileSync(file, "utf8")]));
  const second = prepareFiles(optionsToConfig({}, { token: "rotated-test-ha" }), data, secrets);
  assert.deepEqual(second, first);
  for (const [key, file] of Object.entries(first)) {
    assert.equal(fs.readFileSync(file, "utf8"), before[key]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(before[key], /^[0-9a-f]{64}$/);
  }
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(data, "secrets")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(secrets, "ha_token")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(secrets, "ha_token"), "utf8"), "rotated-test-ha");
  fs.writeFileSync(first.SETUP_CODE_FILE, "");
  assert.throws(() => prepareFiles({ secretFiles: {} }, data, secrets), /Invalid persistent secret/);
});

function socketUrl(factory, options) {
  let actual;
  class FakeSocket { constructor(url) { actual = url; } close() {} }
  const hass = factory({ url: "http://ha.local:8123/", token: "test-ha", entities: [],
    WebSocketImpl: FakeSocket, ...options }).start();
  hass.stop();
  return actual;
}

test("HA socket opt-in changes only the socket, leaving default and REST paths intact", async () => {
  assert.equal(socketUrl(createHass, { wsUrl: "" }), "ws://ha.local:8123/api/websocket");
  assert.equal(socketUrl(createHass, { wsUrl: "ws://supervisor/core/websocket" }), "ws://supervisor/core/websocket");
  let restUrl;
  const hass = createHass({ url: "http://supervisor/core", wsUrl: "ws://supervisor/core/websocket", token: "test-ha", entities: [],
    fetchImpl: async (url) => { restUrl = url; return { ok: true }; } });
  await hass.rest("/api/config");
  assert.equal(restUrl, "http://supervisor/core/api/config");
});
