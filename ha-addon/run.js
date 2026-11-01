"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const SECRET_DIR = "/tmp/secrets";
const DATA_DIR = "/data";
const text = (v) => typeof v === "string" ? v.trim() : "";

// Pure mapping: no environment reads, IO, logging or mutation of inputs.
// supervisor.mqtt is the successful /services/mqtt response's `data` object.
function optionsToConfig(options = {}, supervisor = {}) {
  const env = { DATA_DIR, COOKIE_SECURE: options.cookie_secure === true ? "1" : "0",
    SETTINGS_LOCK: options.settings_lock === true ? "1" : "0",
    MQTT_TOPIC_ROOT: text(options.mqtt_topic_root) || "home/signage" };
  const secretFiles = {};
  const messages = [];
  function secret(key, name, value) {
    if (!text(value)) return;
    const file = `${SECRET_DIR}/${name}`;
    env[key] = file;
    secretFiles[file] = text(value);
  }
  for (const [option, key] of Object.entries({ immich_url: "IMMICH_URL", frigate_url: "FRIGATE_URL",
    jellyfin_url: "JELLYFIN_URL", prometheus_url: "PROMETHEUS_URL" })) {
    if (text(options[option])) env[key] = text(options[option]);
  }
  for (const [option, key, name] of [
    ["immich_api_key", "IMMICH_KEY_FILE", "immich_key"],
    ["jellyfin_api_key", "JELLYFIN_KEY_FILE", "jellyfin_key"],
    ["tomtom_api_key", "TOMTOM_KEY_FILE", "tomtom_key"]
  ]) secret(key, name, options[option]);

  if (options.connect_home_assistant !== false) {
    if (!text(supervisor.token)) throw new Error("Supervisor token required for automatic Home Assistant connection");
    env.HA_URL = "http://supervisor/core";
    env.HA_WS_URL = "ws://supervisor/core/websocket";
    secret("HA_TOKEN_FILE", "ha_token", supervisor.token);
  }

  const manual = text(options.mqtt_url);
  const mqtt = manual ? { url: manual, username: options.mqtt_username, password: options.mqtt_password } : supervisor.mqtt;
  if (mqtt) {
    // CoreView's existing MQTT client uses net.connect, even for mqtts URLs.
    // Never pass TLS credentials to that client over an unencrypted socket.
    if (mqtt.ssl === true || (manual && !manual.startsWith("mqtt://"))) {
      messages.push("MQTT requires a plain mqtt:// broker; TLS MQTT is not supported in this version.");
    } else {
      if (manual) env.MQTT_URL = manual;
      else if (text(mqtt.host) && Number.isInteger(Number(mqtt.port)) && Number(mqtt.port) > 0 && Number(mqtt.port) <= 65535) {
        const host = mqtt.host.includes(":") && !mqtt.host.startsWith("[") ? `[${mqtt.host}]` : mqtt.host;
        env.MQTT_URL = `mqtt://${host}:${mqtt.port}`;
      }
      if (env.MQTT_URL) {
        if (text(mqtt.username)) env.MQTT_USERNAME = text(mqtt.username);
        secret("MQTT_PASSWORD_FILE", "mqtt_password", mqtt.password);
      }
    }
  }
  if (!env.MQTT_URL && !messages.length) messages.push("No MQTT broker available; configure one in add-on options or Studio.");
  return { env, secretFiles, messages };
}

async function discoverMqtt(token, fetchImpl = fetch) {
  if (!token) return null;
  try {
    const response = await fetchImpl("http://supervisor/services/mqtt", {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.result === "ok" && body.data && typeof body.data === "object" ? body.data : null;
  } catch (_e) { return null; }
}

function directory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("Expected a directory");
  fs.chmodSync(dir, 0o700);
}

function privateFile(file, value, persistent = false) {
  if (persistent && fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file, "utf8").trim()) throw new Error("Invalid persistent secret");
  } else {
    // Unlink transient files so an existing symlink is never followed.
    if (!persistent && fs.existsSync(file)) fs.unlinkSync(file);
    fs.writeFileSync(file, value, { flag: "wx", mode: 0o600 });
  }
  fs.chmodSync(file, 0o600);
}

function prepareFiles(config, dataDir = DATA_DIR, secretDir = SECRET_DIR) {
  directory(dataDir);
  directory(secretDir);
  for (const [file, value] of Object.entries(config.secretFiles)) {
    privateFile(path.join(secretDir, path.basename(file)), value);
  }
  const persistent = path.join(dataDir, "secrets");
  directory(persistent);
  for (const name of ["agent_token", "setup_code"]) {
    privateFile(path.join(persistent, name), crypto.randomBytes(32).toString("hex"), true);
  }
  return { AGENT_TOKEN_FILE: path.join(persistent, "agent_token"), SETUP_CODE_FILE: path.join(persistent, "setup_code") };
}

function ownTree(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in add-on data");
  fs.chownSync(dir, 10250, 10250);
  if (stat.isDirectory()) for (const name of fs.readdirSync(dir)) ownTree(path.join(dir, name));
}

async function main() {
  process.umask(0o077);
  const options = JSON.parse(fs.readFileSync(`${DATA_DIR}/options.json`, "utf8"));
  const token = process.env.SUPERVISOR_TOKEN;
  const mqtt = text(options.mqtt_url) ? null : await discoverMqtt(token);
  const config = optionsToConfig(options, { token, mqtt });
  const persistentEnv = prepareFiles(config);
  // Preserve TZ and ordinary runtime variables, but not Supervisor's admin token.
  const env = { ...process.env, ...config.env, ...persistentEnv };
  delete env.SUPERVISOR_TOKEN;
  delete env.HASSIO_TOKEN;
  if (process.getuid() === 0) {
    ownTree(DATA_DIR);
    ownTree(SECRET_DIR);
    process.setgroups([]);
    process.setgid(10250);
    process.setuid(10250);
  }
  for (const message of config.messages) console.log(message);
  let claimed = false;
  try { claimed = Boolean(JSON.parse(fs.readFileSync(`${DATA_DIR}/studio.json`, "utf8")).admin); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!claimed) console.log(`CoreView first sign-in setup code: ${fs.readFileSync(persistentEnv.SETUP_CODE_FILE, "utf8").trim()}`);
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { console.error("CoreView server could not start."); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code === null ? (signal === "SIGTERM" ? 0 : 1) : code; });
}

if (require.main === module) main().catch(() => {
  // Errors can contain option values or API responses: don't print them.
  console.error("CoreView add-on startup failed; check options and /data permissions.");
  process.exitCode = 1;
});

module.exports = { optionsToConfig, discoverMqtt, prepareFiles };
