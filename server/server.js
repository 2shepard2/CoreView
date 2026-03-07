const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const mqtt = require("mqtt");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { promisify } = require("node:util");
const { WebSocket, WebSocketServer } = require("ws");
const { version: APP_VERSION = "0.0.0" } = require("./package.json");

const PORT = Number(process.env.PORT || 3210);
const MQTT_URL_ENV = process.env.MQTT_URL || "";
const MQTT_USERNAME_ENV = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD_ENV = process.env.MQTT_PASSWORD || "";
const MQTT_CLIENT_ID_ENV = process.env.MQTT_CLIENT_ID || "";
const MQTT_TOPIC_ROOT = process.env.MQTT_TOPIC_ROOT || "home/signage";
const MQTT_SUBSCRIBE_PATTERN =
  process.env.MQTT_SUBSCRIBE_PATTERN || `${MQTT_TOPIC_ROOT}/+/cmd/+`;
const HA_URL_ENV = (process.env.HA_URL || "").replace(/\/+$/, "");
const HA_TOKEN_ENV = process.env.HA_TOKEN || "";
const IMMICH_URL_ENV = (process.env.IMMICH_URL || "").replace(/\/+$/, "");
const IMMICH_API_KEY_ENV = process.env.IMMICH_API_KEY || "";
const IMMICH_ALBUM_ID_ENV = process.env.IMMICH_ALBUM_ID || "";
const FRIGATE_URL_ENV = (process.env.FRIGATE_URL || "").replace(/\/+$/, "");
const BOOTSTRAP_TOKEN_ENV = String(process.env.COREVIEW_BOOTSTRAP_TOKEN || process.env.BOOTSTRAP_TOKEN || "").trim();
const TRUST_PROXY = ["1", "true", "yes", "on"].includes(String(process.env.TRUST_PROXY || "").trim().toLowerCase());
const FORCE_SECURE_COOKIES = ["1", "true", "yes", "on"].includes(String(process.env.FORCE_SECURE_COOKIES || "").trim().toLowerCase());
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const HEARTBEAT_STALE_MS = 45000;
const RUNTIME_OVERRIDE_SWEEP_MS = 5000;
const PENDING_DEVICE_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.PENDING_DEVICE_TTL_MS || 24 * 60 * 60 * 1000)
);
const PENDING_DEVICE_SWEEP_MS = 5 * 60 * 1000;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;
const MEDIA_TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const VIEW_ACCESS_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const LOGIN_LOCK_THRESHOLD = 8;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const DEVICE_ID_PATTERN = /^device-[a-z0-9]{8,64}$/;
const DEVICE_KEY_PATTERN = /^[a-f0-9]{32,128}$/;
const WS_NEW_DEVICE_WINDOW_MS = 10 * 60 * 1000;
const WS_NEW_DEVICE_MAX_PER_IP = 30;
const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "signage.db");
const BACKUP_DIR = path.join(DB_DIR, "backups");
const APP_SECRET_KEY_PATH = path.join(DB_DIR, "app-secret.key");

const app = express();
if (TRUST_PROXY) {
  app.set("trust proxy", 1);
}
app.use(express.json({ limit: "256kb" }));

if (CORS_ORIGINS.length > 0) {
  app.use(cors({ origin: CORS_ORIGINS }));
}

app.get("/", (_req, res) => {
  res.redirect(302, "/system");
});

app.use(express.static("public"));

const clients = new Map();
const onlineByTarget = new Map();
const haCache = {
  lastSyncAt: null,
  lastError: null,
  entities: []
};
const haStream = {
  ws: null,
  reconnectTimer: null,
  connected: false,
  nextMessageId: 1
};
const immichCache = {
  reachable: false,
  lastCheckedAt: null,
  lastError: null,
  version: null
};
const frigateCache = {
  reachable: false,
  lastCheckedAt: null,
  lastError: null,
  version: null,
  cameras: []
};
const mqttState = {
  connected: false,
  lastError: null
};
const ruleRuntime = new Map();
const transientRestoreTimers = new Map();
const mediaTokenCache = new Map();
const wsNewDeviceState = new Map();
const loginAttemptState = new Map();
const scryptAsync = promisify(crypto.scrypt);

function cloneOverride(override) {
  if (!override || typeof override !== "object") {
    return {};
  }
  return parseJsonOrDefault(JSON.stringify(override), {});
}
const scheduleRuleLastRunAt = new Map();
const activeRuntimeOverrides = new Map();
const lastAppliedRuleByTarget = new Map();
const TICKER_MAX_GROUPS = 6;
let appSecretKey = null;
const TICKER_MAX_ITEMS_PER_GROUP = 4;
let lastAutoBackupSlot = "";

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function sqlQuote(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqliteExec(sql) {
  return execFileSync("sqlite3", [DB_PATH, sql], { encoding: "utf8" });
}

function sqliteQuery(sql) {
  const output = execFileSync("sqlite3", ["-json", DB_PATH, sql], { encoding: "utf8" });
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  return JSON.parse(trimmed);
}

function ensureDatabase() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  sqliteExec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      pairing_code TEXT UNIQUE,
      assigned_screen_id TEXT,
      device_key_hash TEXT,
      registered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      last_ip TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS screens (
      screen_id TEXT PRIMARY KEY,
      device_id TEXT UNIQUE,
      friendly_name TEXT,
      view_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      is_secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS themes (
      theme_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS banners (
      banner_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickers (
      ticker_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS widgets (
      widget_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, screen_id)
    );
    CREATE TABLE IF NOT EXISTS rules (
      rule_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS views (
      view_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      profile_id TEXT,
      theme_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function assertFinalDatabaseSchema() {
  const screenColumns = sqliteQuery("PRAGMA table_info(screens);");
  const columnNames = new Set(screenColumns.map((col) => String(col.name || "").toLowerCase()));
  if (columnNames.has("profile_id") || columnNames.has("theme_id")) {
    throw new Error("legacy screens schema detected: remove profile_id/theme_id columns before starting");
  }
  if (!columnNames.has("view_id")) {
    throw new Error("invalid screens schema: missing required view_id column");
  }
  const deviceColumns = sqliteQuery("PRAGMA table_info(devices);");
  const deviceColumnNames = new Set(deviceColumns.map((col) => String(col.name || "").toLowerCase()));
  if (!deviceColumnNames.has("device_key_hash")) {
    throw new Error("invalid devices schema: missing required device_key_hash column");
  }
}

function ensureAppSecretKey() {
  if (appSecretKey) {
    return appSecretKey;
  }
  if (!fs.existsSync(APP_SECRET_KEY_PATH)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(APP_SECRET_KEY_PATH, key.toString("hex"), { mode: 0o600 });
  }
  try {
    fs.chmodSync(APP_SECRET_KEY_PATH, 0o600);
  } catch (_err) {
    // Best-effort permission tightening on platforms that support it.
  }
  const raw = String(fs.readFileSync(APP_SECRET_KEY_PATH, "utf8") || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error("app secret key file is invalid");
  }
  appSecretKey = Buffer.from(raw, "hex");
  return appSecretKey;
}

function isEncryptedSecretValue(value) {
  return String(value || "").startsWith("enc:v1:");
}

function encryptSecretValue(value) {
  const key = ensureAppSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(String(value || ""), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptSecretValue(value) {
  const raw = String(value || "");
  if (!isEncryptedSecretValue(raw)) {
    return raw;
  }
  const parts = raw.split(":");
  if (parts.length !== 5) {
    throw new Error("encrypted secret value is malformed");
  }
  const [scheme, version, ivPart, tagPart, dataPart] = parts;
  if (scheme !== "enc" || version !== "v1") {
    throw new Error("encrypted secret value uses an unsupported format");
  }
  const key = ensureAppSecretKey();
  const iv = Buffer.from(ivPart || "", "base64url");
  const tag = Buffer.from(tagPart || "", "base64url");
  const ciphertext = Buffer.from(dataPart || "", "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

function getSettingRow(key) {
  const rows = sqliteQuery(
    `SELECT key, value, is_secret AS isSecret, updated_at AS updatedAt
     FROM app_settings
     WHERE key = ${sqlQuote(key)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function getSetting(key, fallback = null) {
  const row = getSettingRow(key);
  if (!row || row.value === null || row.value === undefined || row.value === "") {
    return fallback;
  }
  if (Boolean(Number(row.isSecret))) {
    try {
      return decryptSecretValue(row.value);
    } catch (err) {
      console.error(`Failed to decrypt secret setting ${key}:`, err.message);
      return fallback;
    }
  }
  return row.value;
}

function setSetting(key, value, isSecret = false) {
  const now = new Date().toISOString();
  const storedValue = isSecret ? encryptSecretValue(value) : String(value || "");
  sqliteExec(
    `INSERT INTO app_settings (key, value, is_secret, updated_at)
     VALUES (${sqlQuote(key)}, ${sqlQuote(storedValue)}, ${isSecret ? 1 : 0}, ${sqlQuote(now)})
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       is_secret = excluded.is_secret,
       updated_at = excluded.updated_at;`
  );
}

function listSettingsRaw() {
  return sqliteQuery(
    `SELECT key,
            value,
            is_secret AS isSecret,
            updated_at AS updatedAt
     FROM app_settings
     ORDER BY key ASC;`
  ).map((row) => ({
    key: row.key,
    value: row.value,
    isSecret: Boolean(Number(row.isSecret)),
    updatedAt: row.updatedAt || null
  }));
}

function maskSecret(value) {
  return value ? "Configured" : "Not set";
}

function getHaConfig() {
  return {
    url: (getSetting("ha_url", HA_URL_ENV) || "").replace(/\/+$/, ""),
    token: getSetting("ha_token", HA_TOKEN_ENV) || ""
  };
}

function getImmichConfig() {
  return {
    url: (getSetting("immich_url", IMMICH_URL_ENV) || "").replace(/\/+$/, ""),
    apiKey: getSetting("immich_api_key", IMMICH_API_KEY_ENV) || "",
    albumId: getSetting("immich_album_id", IMMICH_ALBUM_ID_ENV) || ""
  };
}

function getFrigateConfig() {
  return {
    url: (getSetting("frigate_url", FRIGATE_URL_ENV) || "").replace(/\/+$/, ""),
    mqttTopic: String(getSetting("frigate_mqtt_topic") || "frigate/events").trim()
  };
}

function getMqttConfig() {
  return {
    url: getSetting("mqtt_url", MQTT_URL_ENV) || "",
    username: getSetting("mqtt_username", MQTT_USERNAME_ENV) || "",
    password: getSetting("mqtt_password", MQTT_PASSWORD_ENV) || "",
    clientId: getOrCreateMqttClientId()
  };
}

function generateMqttClientId() {
  return `coreview-${crypto.randomBytes(4).toString("hex")}`;
}

function getOrCreateMqttClientId() {
  const stored = String(getSetting("mqtt_client_id", MQTT_CLIENT_ID_ENV) || "").trim();
  if (stored && stored !== "signage-server") {
    return stored;
  }
  const next = generateMqttClientId();
  setSetting("mqtt_client_id", next);
  return next;
}

function getEventWebhookConfig() {
  return {
    token: getSetting("event_webhook_token") || ""
  };
}

function generatePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function generateUniquePairingCode() {
  let pairingCode = generatePairingCode();
  while (
    sqliteQuery(
      `SELECT pairing_code AS pairingCode FROM devices WHERE pairing_code = ${sqlQuote(pairingCode)} LIMIT 1;`
    ).length > 0
  ) {
    pairingCode = generatePairingCode();
  }
  return pairingCode;
}

function getDeviceRecord(deviceId) {
  const rows = sqliteQuery(
    `SELECT device_id AS deviceId,
            pairing_code AS pairingCode,
            assigned_screen_id AS assignedScreenId,
            device_key_hash AS deviceKeyHash,
            registered,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_seen_at AS lastSeenAt,
            last_ip AS lastIp,
            user_agent AS userAgent
     FROM devices
     WHERE device_id = ${sqlQuote(deviceId)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function getDeviceRecordByPairingCode(pairingCode) {
  const rows = sqliteQuery(
    `SELECT device_id AS deviceId,
            pairing_code AS pairingCode,
            assigned_screen_id AS assignedScreenId,
            device_key_hash AS deviceKeyHash,
            registered,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_seen_at AS lastSeenAt,
            last_ip AS lastIp,
            user_agent AS userAgent
     FROM devices
     WHERE pairing_code = ${sqlQuote(pairingCode)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function ensureDeviceRecord(deviceId, meta = {}) {
  const now = new Date().toISOString();
  let record = getDeviceRecord(deviceId);
  const ip = meta.ip || null;
  const userAgent = meta.userAgent || null;
  const deviceKeyHash = meta.deviceKeyHash || null;

  if (!record) {
    const pairingCode = generateUniquePairingCode();
    sqliteExec(
      `INSERT INTO devices (
         device_id, pairing_code, assigned_screen_id, device_key_hash, registered,
         created_at, updated_at, last_seen_at, last_ip, user_agent
       ) VALUES (
         ${sqlQuote(deviceId)}, ${sqlQuote(pairingCode)}, NULL, ${sqlQuote(deviceKeyHash)}, 0,
         ${sqlQuote(now)}, ${sqlQuote(now)}, ${sqlQuote(now)}, ${sqlQuote(ip)}, ${sqlQuote(userAgent)}
       );`
    );
    record = getDeviceRecord(deviceId);
  } else {
    const nextDeviceKeyHash = deviceKeyHash || record.deviceKeyHash || null;
    sqliteExec(
      `UPDATE devices
       SET updated_at = ${sqlQuote(now)},
           last_seen_at = ${sqlQuote(now)},
           device_key_hash = ${sqlQuote(nextDeviceKeyHash)},
           last_ip = ${sqlQuote(ip)},
           user_agent = ${sqlQuote(userAgent)}
       WHERE device_id = ${sqlQuote(deviceId)};`
    );
    record = getDeviceRecord(deviceId);
  }
  return record;
}

function registerDeviceToScreen(pairingCode, screenId, friendlyName, viewId = null) {
  const now = new Date().toISOString();
  const deviceRows = sqliteQuery(
    `SELECT device_id AS deviceId
     FROM devices
     WHERE pairing_code = ${sqlQuote(pairingCode)}
     LIMIT 1;`
  );
  if (deviceRows.length === 0) {
    return null;
  }
  const deviceId = deviceRows[0].deviceId;
  sqliteExec(`DELETE FROM screens WHERE screen_id = ${sqlQuote(screenId)};`);
  sqliteExec(
    `INSERT INTO screens (screen_id, device_id, friendly_name, view_id, created_at, updated_at)
     VALUES (
       ${sqlQuote(screenId)},
       ${sqlQuote(deviceId)},
       ${sqlQuote(friendlyName || screenId)},
       ${sqlQuote(viewId)},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     );`
  );
  sqliteExec(
    `UPDATE devices
     SET assigned_screen_id = ${sqlQuote(screenId)},
         registered = 1,
         updated_at = ${sqlQuote(now)}
     WHERE device_id = ${sqlQuote(deviceId)};`
  );
  return getDeviceRecord(deviceId);
}

function rebindScreenToPairingCode(screenId, pairingCode) {
  const screen = getScreenRecord(screenId);
  if (!screen) {
    return { error: "screen_not_found" };
  }
  const device = getDeviceRecordByPairingCode(pairingCode);
  if (!device) {
    return { error: "pairing_code_not_found" };
  }
  if (device.assignedScreenId && device.assignedScreenId !== screenId) {
    return { error: "device_assigned_to_other_screen", assignedScreenId: device.assignedScreenId };
  }
  const boundRows = sqliteQuery(
    `SELECT screen_id AS screenId
     FROM screens
     WHERE device_id = ${sqlQuote(device.deviceId)}
     LIMIT 1;`
  );
  if (boundRows.length > 0 && boundRows[0].screenId !== screenId) {
    return { error: "device_bound_to_other_screen", boundScreenId: boundRows[0].screenId };
  }

  const now = new Date().toISOString();
  sqliteExec(
    `UPDATE devices
     SET assigned_screen_id = NULL,
         registered = 0,
         updated_at = ${sqlQuote(now)}
     WHERE assigned_screen_id = ${sqlQuote(screenId)}
       AND device_id != ${sqlQuote(device.deviceId)};`
  );
  sqliteExec(
    `UPDATE screens
     SET device_id = ${sqlQuote(device.deviceId)},
         updated_at = ${sqlQuote(now)}
     WHERE screen_id = ${sqlQuote(screenId)};`
  );
  sqliteExec(
    `UPDATE devices
     SET assigned_screen_id = ${sqlQuote(screenId)},
         registered = 1,
         updated_at = ${sqlQuote(now)}
     WHERE device_id = ${sqlQuote(device.deviceId)};`
  );
  return {
    screen: getScreenRecord(screenId),
    device: getDeviceRecord(device.deviceId)
  };
}

function getScreenRecord(screenId) {
  const rows = sqliteQuery(
    `SELECT screen_id AS screenId,
            device_id AS deviceId,
            friendly_name AS friendlyName,
            view_id AS viewId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM screens
     WHERE screen_id = ${sqlQuote(screenId)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function listScreens() {
  return sqliteQuery(
    `SELECT screen_id AS screenId,
            device_id AS deviceId,
            friendly_name AS friendlyName,
            view_id AS viewId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM screens
     ORDER BY screen_id ASC;`
  );
}

function listScreensRaw() {
  return sqliteQuery(
    `SELECT screen_id AS screenId,
            device_id AS deviceId,
            friendly_name AS friendlyName,
            view_id AS viewId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM screens
     ORDER BY screen_id ASC;`
  ).map((row) => ({
    screenId: row.screenId,
    deviceId: row.deviceId || null,
    friendlyName: row.friendlyName || "",
    viewId: row.viewId || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  }));
}

function normalizeViewRecord(row = {}) {
  return {
    viewId: row.viewId,
    name: row.name,
    profileId: row.profileId || null,
    themeId: row.themeId || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listViews() {
  const rows = sqliteQuery(
    `SELECT view_id AS viewId,
            name,
            profile_id AS profileId,
            theme_id AS themeId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM views
     ORDER BY updated_at DESC, view_id ASC;`
  );
  return rows.map(normalizeViewRecord);
}

function getView(viewId) {
  const rows = sqliteQuery(
    `SELECT view_id AS viewId,
            name,
            profile_id AS profileId,
            theme_id AS themeId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM views
     WHERE view_id = ${sqlQuote(viewId)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeViewRecord(rows[0]) : null;
}

function saveView(viewId, name, profileId = null, themeId = null) {
  const now = new Date().toISOString();
  sqliteExec(
    `INSERT INTO views (view_id, name, profile_id, theme_id, created_at, updated_at)
     VALUES (
       ${sqlQuote(viewId)},
       ${sqlQuote(name)},
       ${sqlQuote(profileId)},
       ${sqlQuote(themeId)},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(view_id) DO UPDATE SET
       name = excluded.name,
       profile_id = excluded.profile_id,
       theme_id = excluded.theme_id,
       updated_at = excluded.updated_at;`
  );
  return getView(viewId);
}

function deleteView(viewId) {
  sqliteExec(`DELETE FROM views WHERE view_id = ${sqlQuote(viewId)};`);
}

function listScreensForView(viewId) {
  return sqliteQuery(
    `SELECT screen_id AS screenId,
            device_id AS deviceId,
            friendly_name AS friendlyName,
            view_id AS viewId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM screens
     WHERE view_id = ${sqlQuote(viewId)}
     ORDER BY screen_id ASC;`
  );
}

function getGroupRecord(groupId) {
  const rows = sqliteQuery(
    `SELECT group_id AS groupId,
            name,
            description,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM groups
     WHERE group_id = ${sqlQuote(groupId)}
     LIMIT 1;`
  );
  if (!rows[0]) {
    return null;
  }
  const members = sqliteQuery(
    `SELECT screen_id AS screenId
     FROM group_members
     WHERE group_id = ${sqlQuote(groupId)}
     ORDER BY screen_id ASC;`
  ).map((item) => item.screenId);
  return {
    ...rows[0],
    members
  };
}

function listGroups() {
  const rows = sqliteQuery(
    `SELECT group_id AS groupId,
            name,
            description,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM groups
     ORDER BY group_id ASC;`
  );
  return rows.map((row) => {
    const members = sqliteQuery(
      `SELECT screen_id AS screenId
       FROM group_members
       WHERE group_id = ${sqlQuote(row.groupId)}
       ORDER BY screen_id ASC;`
    ).map((item) => item.screenId);
    return {
      ...row,
      members
    };
  });
}

function saveGroup(groupId, name, description, members = []) {
  const now = new Date().toISOString();
  const uniqueMembers = Array.from(new Set((Array.isArray(members) ? members : []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)));
  sqliteExec(
    `INSERT INTO groups (group_id, name, description, created_at, updated_at)
     VALUES (
       ${sqlQuote(groupId)},
       ${sqlQuote(name)},
       ${sqlQuote(description || "")},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(group_id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       updated_at = excluded.updated_at;`
  );
  sqliteExec(`DELETE FROM group_members WHERE group_id = ${sqlQuote(groupId)};`);
  for (const screenId of uniqueMembers) {
    sqliteExec(
      `INSERT INTO group_members (group_id, screen_id, created_at)
       VALUES (${sqlQuote(groupId)}, ${sqlQuote(screenId)}, ${sqlQuote(now)});`
    );
  }
  return getGroupRecord(groupId);
}

function deleteGroup(groupId) {
  sqliteExec(`DELETE FROM group_members WHERE group_id = ${sqlQuote(groupId)};`);
  sqliteExec(`DELETE FROM groups WHERE group_id = ${sqlQuote(groupId)};`);
}

function resolveTargetScreens(target) {
  const raw = String(target || "").trim().toLowerCase();
  if (!raw) {
    return [];
  }
  if (raw === "all") {
    return listScreens().map((item) => item.screenId);
  }
  if (raw.startsWith("group:")) {
    const group = getGroupRecord(raw.slice("group:".length));
    return group ? group.members : [];
  }
  const screen = getScreenRecord(raw);
  return screen ? [screen.screenId] : [];
}

function normalizeRuleConfig(config = {}) {
  const labels = normalizeStringList(config.labels).map((item) => item.toLowerCase());
  const targets = normalizeStringList(config.targets).map((item) => item.toLowerCase());
  const rawDuration = config.duration;
  const rawCooldown = config.cooldown;
  const duration = rawDuration === "" || rawDuration === null || rawDuration === undefined
    ? null
    : Number(rawDuration);
  const cooldown = rawCooldown === "" || rawCooldown === null || rawCooldown === undefined
    ? null
    : Number(rawCooldown);
  const widgetIndexNumber = Number(config.widgetIndex);
  const widgetIndex = Number.isInteger(widgetIndexNumber) ? widgetIndexNumber : null;
  const rawWidget = config.widget && typeof config.widget === "object" && !Array.isArray(config.widget)
    ? config.widget
    : (config.widgetConfig && typeof config.widgetConfig === "object" && !Array.isArray(config.widgetConfig)
      ? config.widgetConfig
      : null);
  return {
    labels,
    targets,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    cooldown: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : null,
    snapshot: String(config.snapshot || "").trim(),
    themeId: String(config.themeId || "").trim().toLowerCase(),
    profileId: String(config.profileId || "").trim().toLowerCase(),
    bannerId: String(config.bannerId || "").trim().toLowerCase(),
    tickerId: String(config.tickerId || "").trim().toLowerCase(),
    widgetId: String(config.widgetId || "").trim().toLowerCase(),
    entityId: String(config.entityId || "").trim().toLowerCase(),
    operator: String(config.operator || "equals").trim().toLowerCase(),
    value: String(config.value ?? "").trim(),
    timeOfDay: String(config.timeOfDay || "").trim(),
    daysOfWeek: normalizeStringList(config.daysOfWeek).map((item) => item.toLowerCase()),
    widgetIndex,
    widget: rawWidget ? normalizeCustomProfileWidget(rawWidget) : null
  };
}

function normalizeRuleRecord(row = {}) {
  return {
    ruleId: row.ruleId,
    name: row.name,
    source: row.source,
    ruleType: row.ruleType,
    enabled: Boolean(Number(row.enabled)),
    config: normalizeRuleConfig(parseJsonOrDefault(row.configJson, {})),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listRules() {
  const rows = sqliteQuery(
    `SELECT rule_id AS ruleId,
            name,
            source,
            rule_type AS ruleType,
            enabled,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM rules
     ORDER BY updated_at DESC, rule_id ASC;`
  );
  return rows.map(normalizeRuleRecord);
}

function getRule(ruleId) {
  const rows = sqliteQuery(
    `SELECT rule_id AS ruleId,
            name,
            source,
            rule_type AS ruleType,
            enabled,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM rules
     WHERE rule_id = ${sqlQuote(ruleId)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeRuleRecord(rows[0]) : null;
}

function saveRule(ruleId, name, source, ruleType, enabled, config) {
  const now = new Date().toISOString();
  const normalizedConfig = normalizeRuleConfig(config);
  sqliteExec(
    `INSERT INTO rules (rule_id, name, source, rule_type, enabled, config_json, created_at, updated_at)
     VALUES (
       ${sqlQuote(ruleId)},
       ${sqlQuote(name)},
       ${sqlQuote(source)},
       ${sqlQuote(ruleType)},
       ${enabled ? 1 : 0},
       ${sqlQuote(JSON.stringify(normalizedConfig))},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(rule_id) DO UPDATE SET
       name = excluded.name,
       source = excluded.source,
       rule_type = excluded.rule_type,
       enabled = excluded.enabled,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at;`
  );
  return getRule(ruleId);
}

function deleteRule(ruleId) {
  sqliteExec(`DELETE FROM rules WHERE rule_id = ${sqlQuote(ruleId)};`);
  ruleRuntime.delete(ruleId);
  scheduleRuleLastRunAt.delete(ruleId);
}

function markRuleApplied(rule, targets) {
  const now = new Date().toISOString();
  for (const target of targets) {
    lastAppliedRuleByTarget.set(target, {
      ruleId: rule.ruleId,
      ruleName: rule.name || rule.ruleId,
      ruleType: rule.ruleType,
      source: rule.source,
      appliedAt: now
    });
  }
}

function getActiveRuntimeOverride(target) {
  const override = activeRuntimeOverrides.get(target);
  if (!override) {
    return {};
  }
  const expiresAt = Number(override.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    const existing = transientRestoreTimers.get(target);
    let restored = {};
    if (existing) {
      clearTimeout(existing.timer || existing);
      restored = cloneOverride(existing.restoreOverride || {});
      transientRestoreTimers.delete(target);
    }
    delete restored.expiresAt;
    if (Object.keys(restored).length > 0) {
      activeRuntimeOverrides.set(target, restored);
      return restored;
    }
    activeRuntimeOverrides.delete(target);
    return {};
  }
  return override;
}

function expireStaleRuntimeOverrides() {
  const now = Date.now();
  for (const [target, override] of activeRuntimeOverrides.entries()) {
    const expiresAt = Number(override?.expiresAt || 0);
    if (expiresAt > 0 && expiresAt <= now) {
      const existing = transientRestoreTimers.get(target);
      if (existing) {
        clearTimeout(existing.timer || existing);
        transientRestoreTimers.delete(target);
      }
      const next = cloneOverride(override);
      delete next.expiresAt;
      if (Object.keys(next).length > 0) {
        activeRuntimeOverrides.set(target, next);
      } else {
        activeRuntimeOverrides.delete(target);
      }
      broadcastRuntimeToScreen(target);
    }
  }
}

function scheduleRuntimeRestore(targets, seconds, restoreOverrides = {}) {
  const durationMs = Math.max(1, Number(seconds || 60)) * 1000;
  for (const target of targets) {
    const existing = transientRestoreTimers.get(target);
    if (existing) {
      clearTimeout(existing.timer || existing);
    }
    const restoreOverride = cloneOverride(restoreOverrides[target] || {});
    const timer = setTimeout(() => {
      transientRestoreTimers.delete(target);
      const previous = cloneOverride(restoreOverride);
      delete previous.expiresAt;
      if (Object.keys(previous).length > 0) {
        activeRuntimeOverrides.set(target, previous);
      } else {
        activeRuntimeOverrides.delete(target);
      }
      const runtime = getRuntimeStateForScreen(target);
      if (!runtime) {
        return;
      }
      broadcast({
        type: "screen_runtime",
        target,
        command: "screen_runtime",
        payload: runtime
      });
    }, durationMs);
    transientRestoreTimers.set(target, { timer, restoreOverride });
  }
}

function broadcastTransientRuntime(targets, override = {}, seconds) {
  const restoreOverrides = {};
  for (const target of targets) {
    if (!seconds) {
      const existingTimer = transientRestoreTimers.get(target);
      if (existingTimer) {
        clearTimeout(existingTimer.timer || existingTimer);
        transientRestoreTimers.delete(target);
      }
    }
    const existingOverride = activeRuntimeOverrides.get(target) || {};
    restoreOverrides[target] = cloneOverride(existingOverride);
    const nextOverride = {
      ...existingOverride
    };
    if (seconds) {
      nextOverride.expiresAt = Date.now() + Math.max(1, Number(seconds || 60)) * 1000;
    } else {
      delete nextOverride.expiresAt;
    }
    if (override.profile !== undefined) {
      nextOverride.profile = override.profile;
      nextOverride.widgetOverrides = {};
    }
    if (override.profile?.profileId) {
      nextOverride.profileId = override.profile.profileId;
    }
    if (override.layout !== undefined) {
      nextOverride.layout = override.layout;
      nextOverride.widgetOverrides = {};
    }
    if (override.theme !== undefined) {
      nextOverride.theme = override.theme;
    }
    if (override.theme?.themeId) {
      nextOverride.themeId = override.theme.themeId;
    }
    if (override.themeState !== undefined) {
      nextOverride.themeState = override.themeState;
    }
    if (Object.prototype.hasOwnProperty.call(override, "bannerState")) {
      nextOverride.bannerState = override.bannerState || null;
    }
    if (override.bannerState?.bannerId) {
      nextOverride.bannerId = override.bannerState.bannerId;
    }
    if (Object.prototype.hasOwnProperty.call(override, "tickerState")) {
      nextOverride.tickerState = override.tickerState || null;
    }
    if (override.tickerState?.tickerId) {
      nextOverride.tickerId = override.tickerState.tickerId;
    }
    if (Object.prototype.hasOwnProperty.call(override, "widgetOverrides")) {
      const existingWidgetOverrides = nextOverride.widgetOverrides && typeof nextOverride.widgetOverrides === "object"
        ? nextOverride.widgetOverrides
        : {};
      const incoming = override.widgetOverrides && typeof override.widgetOverrides === "object"
        ? override.widgetOverrides
        : {};
      nextOverride.widgetOverrides = {
        ...existingWidgetOverrides,
        ...incoming
      };
    }
    activeRuntimeOverrides.set(target, nextOverride);
    const payload = getRuntimeStateForScreen(target);
    if (!payload) {
      continue;
    }
    broadcast({
      type: "screen_runtime",
      target,
      command: "screen_runtime",
      payload
    });
  }
  if (seconds) {
    scheduleRuntimeRestore(targets, seconds, restoreOverrides);
  }
}

function evaluateRuleCooldown(rule) {
  const lastTriggeredAt = ruleRuntime.get(rule.ruleId) || 0;
  return !(rule.config.cooldown > 0 && Date.now() - lastTriggeredAt < rule.config.cooldown * 1000);
}

function resolveRuleTargets(rule) {
  return Array.from(
    new Set(
      rule.config.targets.flatMap((target) => resolveTargetScreens(target))
    )
  );
}

function evaluateStateCondition(entity, operator, expectedRaw) {
  const actual = String(entity?.state ?? "").trim();
  const expected = String(expectedRaw ?? "").trim();
  switch (operator) {
    case "not_equals":
      return actual !== expected;
    case "contains":
      return actual.toLowerCase().includes(expected.toLowerCase());
    case "above": {
      const actualNum = Number(actual);
      const expectedNum = Number(expected);
      return Number.isFinite(actualNum) && Number.isFinite(expectedNum) && actualNum > expectedNum;
    }
    case "below": {
      const actualNum = Number(actual);
      const expectedNum = Number(expected);
      return Number.isFinite(actualNum) && Number.isFinite(expectedNum) && actualNum < expectedNum;
    }
    case "equals":
    default:
      return actual === expected;
  }
}

function validTimeOfDay(value) {
  return /^\d{2}:\d{2}$/.test(String(value || "").trim());
}

function normalizeDayToken(value) {
  const token = String(value || "").trim().toLowerCase();
  const map = {
    sun: "sun",
    sunday: "sun",
    mon: "mon",
    monday: "mon",
    tue: "tue",
    tuesday: "tue",
    wed: "wed",
    wednesday: "wed",
    thu: "thu",
    thursday: "thu",
    fri: "fri",
    friday: "fri",
    sat: "sat",
    saturday: "sat"
  };
  return map[token] || "";
}

function currentDayToken(date = new Date()) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getDay()];
}

function parseTimeOfDayMinutes(value) {
  if (!validTimeOfDay(value)) {
    return null;
  }
  const [hourRaw, minuteRaw] = String(value).split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function scheduleSlotKeyFor(occurrence, timeOfDay) {
  return `${occurrence.getFullYear()}-${occurrence.getMonth()}-${occurrence.getDate()}-${timeOfDay}`;
}

function ruleAllowsDay(rule, dayToken) {
  const allowedDays = (Array.isArray(rule?.config?.daysOfWeek) ? rule.config.daysOfWeek : [])
    .map((item) => normalizeDayToken(item))
    .filter(Boolean);
  return allowedDays.length === 0 || allowedDays.includes(dayToken);
}

function collectPersistentScheduleCandidates(rule, now = new Date()) {
  const minutes = parseTimeOfDayMinutes(rule?.config?.timeOfDay);
  if (minutes === null) {
    return [];
  }
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const candidates = [];

  for (const dayOffset of [-1, 0]) {
    const occurrence = new Date(now);
    occurrence.setDate(occurrence.getDate() + dayOffset);
    occurrence.setHours(hour, minute, 0, 0);
    if (occurrence.getTime() > now.getTime()) {
      continue;
    }
    if (!ruleAllowsDay(rule, currentDayToken(occurrence))) {
      continue;
    }
    candidates.push({
      occurrence,
      slotKey: scheduleSlotKeyFor(occurrence, rule.config.timeOfDay)
    });
  }

  candidates.sort((a, b) => a.occurrence.getTime() - b.occurrence.getTime());
  return candidates;
}

async function executeTransientRuleAction(rule, targets) {
  if (rule.ruleType === "theme") {
    const theme = getTheme(rule.config.themeId);
    if (!theme) {
      return false;
    }
    broadcastTransientRuntime(targets, {
      theme,
      themeState: buildThemePayloadFromTheme(theme)
    }, rule.config.duration);
    return true;
  }

  if (rule.ruleType === "profile") {
    const profile = getProfile(rule.config.profileId);
    if (!profile) {
      return false;
    }
    broadcastTransientRuntime(targets, {
      profile,
      layout: buildLayoutPayloadFromProfile(profile)
    }, rule.config.duration);
    return true;
  }

  if (rule.ruleType === "banner") {
    const banner = getBanner(rule.config.bannerId);
    if (!banner) {
      return false;
    }
    broadcastTransientRuntime(targets, {
      bannerState: buildBannerPayloadFromBanner(banner)
    }, rule.config.duration);
    return true;
  }

  if (rule.ruleType === "ticker") {
    const ticker = getTicker(rule.config.tickerId);
    if (!ticker) {
      return false;
    }
    broadcastTransientRuntime(targets, {
      tickerState: buildTickerPayloadFromTicker(ticker)
    }, rule.config.duration);
    return true;
  }

  if (rule.ruleType === "widget") {
    const widgetIndex = Number(rule.config.widgetIndex);
    if (!Number.isInteger(widgetIndex) || widgetIndex < 0 || widgetIndex > 3) {
      return false;
    }
    const widget = getWidget(rule.config.widgetId);
    if (!widget) {
      return false;
    }
    for (const target of targets) {
      const runtime = getRuntimeStateForScreen(target);
      if (!runtime || runtime.layout?.template !== "custom") {
        return false;
      }
    }
    broadcastTransientRuntime(targets, {
      widgetOverrides: {
        [widgetIndex]: widget.config
      }
    }, rule.config.duration);
    return true;
  }

  return false;
}

async function runRuleNow(rule) {
  if (!rule) {
    return { applied: false, reason: "rule not found" };
  }
  const targets = resolveRuleTargets(rule);
  if (targets.length === 0) {
    return { applied: false, reason: "rule targets do not resolve to any registered screens" };
  }
  if (rule.ruleType === "overlay") {
    return { applied: false, reason: "overlay rules require a live event context" };
  }
  const applied = await executeTransientRuleAction(rule, targets);
  if (!applied) {
    return { applied: false, reason: "rule action could not be executed" };
  }
  markRuleApplied(rule, targets);
  return {
    applied: true,
    ruleId: rule.ruleId,
    ruleName: rule.name || rule.ruleId,
    resolvedTargets: targets
  };
}

function assignViewToScreen(screenId, viewId) {
  const now = new Date().toISOString();
  sqliteExec(
    `UPDATE screens
     SET view_id = ${sqlQuote(viewId)},
         updated_at = ${sqlQuote(now)}
     WHERE screen_id = ${sqlQuote(screenId)};`
  );
  return getScreenRecord(screenId);
}

function updateScreenRecord(screenId, updates = {}) {
  const screen = getScreenRecord(screenId);
  if (!screen) {
    return null;
  }
  const now = new Date().toISOString();
  const friendlyName = updates.friendlyName === undefined ? screen.friendlyName : String(updates.friendlyName || "").trim();
  const viewId = updates.viewId === undefined ? screen.viewId : (updates.viewId || null);
  sqliteExec(
    `UPDATE screens
     SET friendly_name = ${sqlQuote(friendlyName)},
         view_id = ${sqlQuote(viewId)},
         updated_at = ${sqlQuote(now)}
     WHERE screen_id = ${sqlQuote(screenId)};`
  );
  return getScreenRecord(screenId);
}

function unregisterScreen(screenId) {
  const screen = getScreenRecord(screenId);
  if (!screen) {
    return null;
  }
  const now = new Date().toISOString();
  const nextPairingCode = screen.deviceId ? generateUniquePairingCode() : null;
  if (screen.deviceId) {
    sqliteExec(
      `UPDATE devices
       SET assigned_screen_id = NULL,
           pairing_code = ${sqlQuote(nextPairingCode)},
           registered = 0,
           updated_at = ${sqlQuote(now)}
       WHERE device_id = ${sqlQuote(screen.deviceId)};`
    );
  }
  sqliteExec(`DELETE FROM group_members WHERE screen_id = ${sqlQuote(screenId)};`);
  sqliteExec(`DELETE FROM screens WHERE screen_id = ${sqlQuote(screenId)};`);
  const existingTimer = transientRestoreTimers.get(screenId);
  if (existingTimer) {
    clearTimeout(existingTimer.timer || existingTimer);
    transientRestoreTimers.delete(screenId);
  }
  activeRuntimeOverrides.delete(screenId);
  lastAppliedRuleByTarget.delete(screenId);
  onlineByTarget.delete(screenId);
  return {
    ...screen,
    pairingCode: nextPairingCode
  };
}

function listScreensForProfile(profileId) {
  return sqliteQuery(
    `SELECT screen_id AS screenId,
            device_id AS deviceId,
            friendly_name AS friendlyName,
            view_id AS viewId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM screens
     WHERE view_id IN (
       SELECT view_id
       FROM views
       WHERE profile_id = ${sqlQuote(profileId)}
     )
     ORDER BY screen_id ASC;`
  );
}

function clearProfileAssignments(profileId) {
  const now = new Date().toISOString();
  sqliteExec(
    `UPDATE views
     SET profile_id = NULL,
         updated_at = ${sqlQuote(now)}
     WHERE profile_id = ${sqlQuote(profileId)};`
  );
}

function normalizeThemeConfig(config = {}) {
  const mode = String(config.mode || "dark").trim().toLowerCase();
  const fontFamily = String(config.fontFamily || "sans").trim().toLowerCase();
  const fontColor = String(config.fontColor || "").trim();
  return {
    mode: ["light", "dark"].includes(mode) ? mode : "dark",
    fontFamily: ["sans", "serif", "mono", "humanist"].includes(fontFamily) ? fontFamily : "sans",
    fontColor: /^#[0-9a-fA-F]{6}$/.test(fontColor) ? fontColor.toLowerCase() : ""
  };
}

function normalizeThemeRecord(row = {}) {
  return {
    themeId: row.themeId,
    name: row.name,
    config: normalizeThemeConfig(parseJsonOrDefault(row.configJson, {})),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function normalizeBannerConfig(config = {}) {
  const variant = String(config.variant || "neutral").trim().toLowerCase();
  const normalizeBannerValue = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (String(value.type || "").trim().toLowerCase() === "entity") {
        const valueSource = String(value.valueSource || "state").trim().toLowerCase();
        return {
          type: "entity",
          label: String(value.label || "").trim(),
          entityId: String(value.entityId || "").trim().toLowerCase(),
          valueSource: ["state", "attribute"].includes(valueSource) ? valueSource : "state",
          attributeKey: String(value.attributeKey || "").trim(),
          appendUnit: Boolean(value.appendUnit)
        };
      }
      return {
        type: "text",
        text: String(value.text || "").trim()
      };
    }
    return {
      type: "text",
      text: String(value || "").trim()
    };
  };
  return {
    text: normalizeBannerValue(config.text),
    subtext: normalizeBannerValue(config.subtext),
    variant: ["neutral", "info", "success", "warn", "critical"].includes(variant) ? variant : "neutral"
  };
}

function normalizeBannerRecord(row = {}) {
  return {
    bannerId: row.bannerId,
    name: row.name,
    config: normalizeBannerConfig(parseJsonOrDefault(row.configJson, {})),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listBanners() {
  const rows = sqliteQuery(
    `SELECT banner_id AS bannerId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM banners
     ORDER BY updated_at DESC, banner_id ASC;`
  );
  return rows.map(normalizeBannerRecord);
}

function getBanner(bannerId) {
  const rows = sqliteQuery(
    `SELECT banner_id AS bannerId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM banners
     WHERE banner_id = ${sqlQuote(bannerId)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeBannerRecord(rows[0]) : null;
}

function saveBanner(bannerId, name, config) {
  const now = new Date().toISOString();
  const normalizedConfig = normalizeBannerConfig(config);
  sqliteExec(
    `INSERT INTO banners (banner_id, name, config_json, created_at, updated_at)
     VALUES (
       ${sqlQuote(bannerId)},
       ${sqlQuote(name)},
       ${sqlQuote(JSON.stringify(normalizedConfig))},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(banner_id) DO UPDATE SET
       name = excluded.name,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at;`
  );
  return getBanner(bannerId);
}

function deleteBanner(bannerId) {
  sqliteExec(`DELETE FROM banners WHERE banner_id = ${sqlQuote(bannerId)};`);
}

function normalizeTickerConfig(config = {}) {
  const mode = String(config.mode || "single").trim().toLowerCase();
  const speed = Number(config.speed || 45);
  const normalizeTickerItem = (rawItem) => {
    if (rawItem && typeof rawItem === "object" && !Array.isArray(rawItem)) {
      const itemType = String(rawItem.type || "static").trim().toLowerCase();
      if (itemType === "entity") {
        const valueSource = String(rawItem.valueSource || "state").trim().toLowerCase();
        return {
          type: "entity",
          label: String(rawItem.label || "").trim().slice(0, 40),
          entityId: String(rawItem.entityId || "").trim().toLowerCase(),
          valueSource: valueSource === "attribute" ? "attribute" : "state",
          attributeKey: String(rawItem.attributeKey || "").trim(),
          appendUnit: Boolean(rawItem.appendUnit)
        };
      }
      return {
        type: "static",
        text: String(rawItem.text || "").trim().slice(0, 120)
      };
    }
    return {
      type: "static",
      text: String(rawItem || "").trim().slice(0, 120)
    };
  };
  const normalizedGroups = (Array.isArray(config.groups) ? config.groups : [])
    .slice(0, TICKER_MAX_GROUPS)
    .map((rawGroup) => {
      const group = rawGroup && typeof rawGroup === "object" ? rawGroup : {};
      const label = String(group.label || "").trim().slice(0, 40);
      const level = String(group.level || "neutral").trim().toLowerCase();
      const normalizedLevel = ["neutral", "ok", "info", "warn", "critical", "success"].includes(level)
        ? level
        : "neutral";
      const items = (Array.isArray(group.items) ? group.items : [])
        .slice(0, TICKER_MAX_ITEMS_PER_GROUP)
        .map((item) => normalizeTickerItem(item))
        .filter((item) => {
          if (item.type === "entity") {
            return Boolean(item.entityId);
          }
          return Boolean(item.text);
        });
      return {
        label,
        level: normalizedLevel,
        items
      };
    })
    .filter((group) => group.label || group.items.length > 0);
  return {
    mode: ["single", "grouped"].includes(mode) ? mode : "single",
    message: String(config.message || "").trim().slice(0, 280),
    groups: normalizedGroups,
    speed: Number.isFinite(speed) && speed >= 20 ? speed : 45
  };
}

function normalizeTickerRecord(row = {}) {
  return {
    tickerId: row.tickerId,
    name: row.name,
    config: normalizeTickerConfig(parseJsonOrDefault(row.configJson, {})),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listTickers() {
  const rows = sqliteQuery(
    `SELECT ticker_id AS tickerId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM tickers
     ORDER BY updated_at DESC, ticker_id ASC;`
  );
  return rows.map(normalizeTickerRecord);
}

function getTicker(tickerId) {
  const rows = sqliteQuery(
    `SELECT ticker_id AS tickerId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM tickers
     WHERE ticker_id = ${sqlQuote(tickerId)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeTickerRecord(rows[0]) : null;
}

function saveTicker(tickerId, name, config) {
  const now = new Date().toISOString();
  const normalizedConfig = normalizeTickerConfig(config);
  sqliteExec(
    `INSERT INTO tickers (ticker_id, name, config_json, created_at, updated_at)
     VALUES (
       ${sqlQuote(tickerId)},
       ${sqlQuote(name)},
       ${sqlQuote(JSON.stringify(normalizedConfig))},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(ticker_id) DO UPDATE SET
       name = excluded.name,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at;`
  );
  return getTicker(tickerId);
}

function deleteTicker(tickerId) {
  sqliteExec(`DELETE FROM tickers WHERE ticker_id = ${sqlQuote(tickerId)};`);
}

function listThemes() {
  const rows = sqliteQuery(
    `SELECT theme_id AS themeId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM themes
     ORDER BY updated_at DESC, theme_id ASC;`
  );
  return rows.map(normalizeThemeRecord);
}

function getTheme(themeId) {
  const rows = sqliteQuery(
    `SELECT theme_id AS themeId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM themes
     WHERE theme_id = ${sqlQuote(themeId)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeThemeRecord(rows[0]) : null;
}

function saveTheme(themeId, name, config) {
  const now = new Date().toISOString();
  const normalizedConfig = normalizeThemeConfig(config);
  sqliteExec(
    `INSERT INTO themes (theme_id, name, config_json, created_at, updated_at)
     VALUES (
       ${sqlQuote(themeId)},
       ${sqlQuote(name)},
       ${sqlQuote(JSON.stringify(normalizedConfig))},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(theme_id) DO UPDATE SET
       name = excluded.name,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at;`
  );
  return getTheme(themeId);
}

function deleteTheme(themeId) {
  sqliteExec(`DELETE FROM themes WHERE theme_id = ${sqlQuote(themeId)};`);
}

function listScreensForTheme(themeId) {
  return sqliteQuery(
    `SELECT screen_id AS screenId,
            device_id AS deviceId,
            friendly_name AS friendlyName,
            view_id AS viewId,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM screens
     WHERE view_id IN (
       SELECT view_id
       FROM views
       WHERE theme_id = ${sqlQuote(themeId)}
     )
     ORDER BY screen_id ASC;`
  );
}

function clearThemeAssignments(themeId) {
  const now = new Date().toISOString();
  sqliteExec(
    `UPDATE views
     SET theme_id = NULL,
         updated_at = ${sqlQuote(now)}
     WHERE theme_id = ${sqlQuote(themeId)};`
  );
}

function getActiveUnregisteredDeviceIds() {
  const ids = new Set();
  for (const client of clients.values()) {
    if (!client || client.target || !client.deviceId) {
      continue;
    }
    ids.add(String(client.deviceId));
  }
  return ids;
}

function pendingDeviceLastSeenMs(row = {}) {
  const candidates = [row.lastSeenAt, row.updatedAt, row.createdAt];
  for (const value of candidates) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function pendingDeviceIsExpired(row = {}, activeDeviceIds = getActiveUnregisteredDeviceIds(), now = Date.now()) {
  if (!row || Boolean(Number(row.registered))) {
    return false;
  }
  if (activeDeviceIds.has(String(row.deviceId || ""))) {
    return false;
  }
  const lastSeenMs = pendingDeviceLastSeenMs(row);
  if (!lastSeenMs) {
    return true;
  }
  return now - lastSeenMs > PENDING_DEVICE_TTL_MS;
}

function pruneStalePendingDevices() {
  const rows = sqliteQuery(
    `SELECT device_id AS deviceId,
            pairing_code AS pairingCode,
            assigned_screen_id AS assignedScreenId,
            registered,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_seen_at AS lastSeenAt
     FROM devices
     WHERE registered = 0;`
  );
  if (!rows.length) {
    return 0;
  }
  const activeDeviceIds = getActiveUnregisteredDeviceIds();
  const now = Date.now();
  let removed = 0;
  for (const row of rows) {
    if (!pendingDeviceIsExpired(row, activeDeviceIds, now)) {
      continue;
    }
    sqliteExec(`DELETE FROM devices WHERE device_id = ${sqlQuote(row.deviceId)};`);
    removed += 1;
  }
  return removed;
}

function getPendingDevices() {
  pruneStalePendingDevices();
  const rows = sqliteQuery(
    `SELECT device_id AS deviceId,
            pairing_code AS pairingCode,
            assigned_screen_id AS assignedScreenId,
            registered,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_seen_at AS lastSeenAt,
            last_ip AS lastIp,
            user_agent AS userAgent
     FROM devices
     WHERE registered = 0
     ORDER BY updated_at DESC
     LIMIT 25;`
  );
  const activeDeviceIds = getActiveUnregisteredDeviceIds();
  const now = Date.now();
  return rows.filter((row) => !pendingDeviceIsExpired(row, activeDeviceIds, now));
}

function listDevicesRaw() {
  return sqliteQuery(
    `SELECT device_id AS deviceId,
            pairing_code AS pairingCode,
            assigned_screen_id AS assignedScreenId,
            registered,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_seen_at AS lastSeenAt,
            last_ip AS lastIp,
            user_agent AS userAgent
     FROM devices
     ORDER BY device_id ASC;`
  ).map((row) => ({
    deviceId: row.deviceId,
    pairingCode: row.pairingCode || null,
    assignedScreenId: row.assignedScreenId || null,
    registered: Boolean(Number(row.registered)),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    lastSeenAt: row.lastSeenAt || null,
    lastIp: row.lastIp || null,
    userAgent: row.userAgent || null
  }));
}

function parseJsonOrDefault(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeStringList(value) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function templateEntityIdsFromString(value) {
  const ids = new Set();
  const source = String(value || "");
  const pattern = /\{\{\s*([a-z0-9_]+\.[a-z0-9_]+)\.(state|attributes(?:\.[a-z0-9_]+)*)\s*\}\}/gi;
  let match = pattern.exec(source);
  while (match) {
    ids.add(String(match[1] || "").trim().toLowerCase());
    match = pattern.exec(source);
  }
  return Array.from(ids);
}

function templateEntityIdsFromValue(value) {
  if (typeof value === "string") {
    return templateEntityIdsFromString(value);
  }
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((item) => templateEntityIdsFromValue(item))));
  }
  if (value && typeof value === "object") {
    if (value.type === "entity" && value.entityId) {
      return Array.from(new Set([
        String(value.entityId || "").trim().toLowerCase(),
        ...Object.values(value).flatMap((item) => templateEntityIdsFromValue(item))
      ].filter(Boolean)));
    }
    return Array.from(
      new Set(
        Object.values(value).flatMap((item) => templateEntityIdsFromValue(item))
      )
    );
  }
  return [];
}

function resolveTemplateToken(entityId, path) {
  const entity = haCache.entities.find((item) => item.entityId === entityId);
  if (!entity) {
    return "";
  }
  if (path === "state") {
    return String(entity.state ?? "");
  }
  if (!path.startsWith("attributes.")) {
    return "";
  }
  const keys = path.slice("attributes.".length).split(".").filter(Boolean);
  let cursor = entity.attributes || {};
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) {
      return "";
    }
    cursor = cursor[key];
  }
  if (cursor === null || cursor === undefined) {
    return "";
  }
  if (typeof cursor === "object") {
    return "";
  }
  return String(cursor);
}

function renderTemplateString(value) {
  const source = String(value || "");
  if (!source.includes("{{")) {
    return source;
  }
  return source.replace(/\{\{\s*([a-z0-9_]+\.[a-z0-9_]+)\.(state|attributes(?:\.[a-z0-9_]+)*)\s*\}\}/gi, (_match, entityId, path) => {
    return resolveTemplateToken(String(entityId || "").trim().toLowerCase(), String(path || "").trim().toLowerCase());
  });
}

function renderTemplateValue(value) {
  if (typeof value === "string") {
    return renderTemplateString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item));
  }
  if (value && typeof value === "object") {
    if (value.type === "entity" && value.entityId) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item)])
    );
  }
  return value;
}

function renderTickerItemText(item = {}) {
  if (item && typeof item === "object" && item.type === "entity") {
    const entityId = String(item.entityId || "").trim().toLowerCase();
    const entity = haCache.entities.find((entry) => entry.entityId === entityId);
    let value = "Unavailable";
    if (entity) {
      if (String(item.valueSource || "state").trim().toLowerCase() === "attribute") {
        const attrKey = String(item.attributeKey || "").trim();
        const attrValue = attrKey && entity.attributes && typeof entity.attributes === "object"
          ? entity.attributes[attrKey]
          : undefined;
        if (attrValue !== null && attrValue !== undefined && typeof attrValue !== "object") {
          value = String(attrValue);
          if (item.appendUnit && entity.attributes && typeof entity.attributes === "object") {
            const unitMap = {
              temperature: "temperature_unit",
              wind_speed: "wind_speed_unit",
              pressure: "pressure_unit",
              visibility: "visibility_unit"
            };
            const unitKey = unitMap[attrKey] || "";
            const unitValue = unitKey ? entity.attributes[unitKey] : null;
            if (unitValue !== null && unitValue !== undefined && typeof unitValue !== "object" && String(unitValue).trim()) {
              value = `${value} ${String(unitValue).trim()}`;
            }
          }
        }
      } else {
        value = `${entity.state}${entity.unit ? ` ${entity.unit}` : ""}`.trim();
      }
    }
    const label = String(item.label || "").trim();
    return label ? `${label} ${value}` : value;
  }
  return renderTemplateString(item && typeof item === "object" ? item.text || "" : String(item || ""));
}

function normalizeProfileRecord(row = {}) {
  return {
    profileId: row.profileId,
    name: row.name,
    template: row.template,
    config: parseJsonOrDefault(row.configJson, {}),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listProfiles() {
  const rows = sqliteQuery(
    `SELECT profile_id AS profileId,
            name,
            template,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM profiles
     ORDER BY updated_at DESC, profile_id ASC;`
  );
  return rows.map(normalizeProfileRecord);
}

function getProfile(profileId) {
  const rows = sqliteQuery(
    `SELECT profile_id AS profileId,
            name,
            template,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM profiles
     WHERE profile_id = ${sqlQuote(profileId)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeProfileRecord(rows[0]) : null;
}

function normalizeCustomProfileWidget(widget = {}) {
  const kind = String(widget.kind || "text").trim().toLowerCase();
  const normalizedKind = ["clock", "entity", "text", "weather", "status", "photo_slideshow", "camera_stream", "map"].includes(kind) ? kind : "text";
  const verticalAlign = String(widget.verticalAlign || "top").trim().toLowerCase();
  const displayFormat = String(widget.displayFormat || "auto").trim().toLowerCase();
  const decimals = Math.max(0, Math.min(3, Number.isFinite(Number(widget.decimals)) ? Number(widget.decimals) : 1));
  const base = {
    kind: normalizedKind,
    label: String(widget.label || "").trim(),
    verticalAlign: ["top", "center", "bottom"].includes(verticalAlign) ? verticalAlign : "top"
  };
  if (normalizedKind === "entity") {
    const valueSource = String(widget.valueSource || "state").trim().toLowerCase();
    return {
      ...base,
      entityId: String(widget.entityId || "").trim().toLowerCase(),
      valueSource: ["state", "attribute"].includes(valueSource) ? valueSource : "state",
      attributeKey: String(widget.attributeKey || "").trim(),
      displayFormat: ["auto", "raw", "percent", "number", "temperature"].includes(displayFormat) ? displayFormat : "auto",
      decimals,
      showUnit: widget.showUnit === undefined ? true : Boolean(widget.showUnit),
      showMeta: widget.showMeta === undefined ? true : Boolean(widget.showMeta)
    };
  }
  if (normalizedKind === "weather") {
    const weatherField = String(widget.weatherField || "temperature").trim().toLowerCase();
    return {
      ...base,
      entityId: String(widget.entityId || "").trim().toLowerCase(),
      weatherField: ["temperature", "condition", "humidity", "wind_speed"].includes(weatherField) ? weatherField : "temperature",
      showUnit: widget.showUnit === undefined ? true : Boolean(widget.showUnit),
      showMeta: widget.showMeta === undefined ? true : Boolean(widget.showMeta)
    };
  }
  if (normalizedKind === "status") {
    const valueSource = String(widget.valueSource || "state").trim().toLowerCase();
    return {
      ...base,
      entityId: String(widget.entityId || "").trim().toLowerCase(),
      valueSource: ["state", "attribute"].includes(valueSource) ? valueSource : "state",
      attributeKey: String(widget.attributeKey || "").trim(),
      displayFormat: ["auto", "raw", "percent", "number", "temperature"].includes(displayFormat) ? displayFormat : "auto",
      decimals,
      showUnit: widget.showUnit === undefined ? true : Boolean(widget.showUnit),
      showMeta: widget.showMeta === undefined ? true : Boolean(widget.showMeta),
      healthyValues: normalizeStringList(widget.healthyValues || widget.goodStates).map((item) => item.toLowerCase()),
      degradedValues: normalizeStringList(widget.degradedValues).map((item) => item.toLowerCase()),
      errorValues: normalizeStringList(widget.errorValues).map((item) => item.toLowerCase())
    };
  }
  if (normalizedKind === "text") {
    return {
      ...base,
      text: String(widget.text || widget.value || "").trim()
    };
  }
  if (normalizedKind === "photo_slideshow") {
    return {
      ...base,
      albumId: String(widget.albumId || "").trim(),
      random: widget.random === undefined ? true : Boolean(widget.random)
    };
  }
  if (normalizedKind === "camera_stream") {
    return {
      ...base,
      camera: String(widget.camera || "").trim().toLowerCase()
    };
  }
  if (normalizedKind === "map") {
    const centerMode = String(widget.centerMode || "auto").trim().toLowerCase();
    const centerLat = Number(widget.centerLat);
    const centerLon = Number(widget.centerLon);
    const zoomRaw = Number(widget.zoom);
    const zoom = Number.isFinite(zoomRaw) ? Math.round(zoomRaw) : 12;
    const markerEntities = normalizeStringList(widget.markerEntities)
      .map((item) => item.toLowerCase())
      .slice(0, 12);
    return {
      ...base,
      centerMode: centerMode === "manual" ? "manual" : "auto",
      centerLat: Number.isFinite(centerLat) ? centerLat : null,
      centerLon: Number.isFinite(centerLon) ? centerLon : null,
      zoom: Math.max(2, Math.min(19, zoom)),
      showLabels: widget.showLabels !== false,
      markerEntities
    };
  }
  return base;
}

function normalizeWidgetRecord(row = {}) {
  return {
    widgetId: row.widgetId,
    name: row.name,
    config: normalizeCustomProfileWidget(parseJsonOrDefault(row.configJson, {})),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listWidgets() {
  const rows = sqliteQuery(
    `SELECT widget_id AS widgetId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM widgets
     ORDER BY updated_at DESC, widget_id ASC;`
  );
  return rows.map(normalizeWidgetRecord);
}

function getWidget(widgetId) {
  const rows = sqliteQuery(
    `SELECT widget_id AS widgetId,
            name,
            config_json AS configJson,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM widgets
     WHERE widget_id = ${sqlQuote(widgetId)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeWidgetRecord(rows[0]) : null;
}

function saveWidget(widgetId, name, config) {
  const now = new Date().toISOString();
  const normalizedConfig = normalizeCustomProfileWidget(config);
  sqliteExec(
    `INSERT INTO widgets (widget_id, name, config_json, created_at, updated_at)
     VALUES (
       ${sqlQuote(widgetId)},
       ${sqlQuote(name)},
       ${sqlQuote(JSON.stringify(normalizedConfig))},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(widget_id) DO UPDATE SET
       name = excluded.name,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at;`
  );
  return getWidget(widgetId);
}

function deleteWidget(widgetId) {
  sqliteExec(`DELETE FROM widgets WHERE widget_id = ${sqlQuote(widgetId)};`);
}

function profileUsesWidget(profile, widgetId) {
  if (!profile || profile.template !== "custom") {
    return false;
  }
  const widgetIds = Array.isArray(profile.config?.widgetIds) ? profile.config.widgetIds : [];
  return widgetIds.includes(widgetId);
}

function normalizeProfileConfig(template, config = {}) {
  const base = {
    title: String(config.title || "").trim(),
    bannerId: String(config.bannerId || "").trim().toLowerCase(),
    tickerId: String(config.tickerId || "").trim().toLowerCase()
  };

  const normalizeSlideshowHudCard = (value, defaultKind) => {
    const fallbackKind = defaultKind || "none";
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: fallbackKind };
    }
    const requestedKind = String(value.kind || fallbackKind).trim().toLowerCase();
    const kind = ["clock", "text", "entity", "none"].includes(requestedKind) ? requestedKind : fallbackKind;
    if (kind === "text") {
      return {
        kind,
        label: String(value.label || "").trim(),
        text: String(value.text || "").trim()
      };
    }
    if (kind === "entity") {
      const valueSource = String(value.valueSource || "state").trim().toLowerCase();
      return {
        kind,
        label: String(value.label || "").trim(),
        entityId: String(value.entityId || "").trim().toLowerCase(),
        valueSource: ["state", "attribute"].includes(valueSource) ? valueSource : "state",
        attributeKey: String(value.attributeKey || "").trim(),
        showUnit: value.showUnit === undefined ? true : Boolean(value.showUnit)
      };
    }
    return { kind };
  };

  if (template === "photo_slideshow") {
    const interval = Number(config.interval || 20);
    const showMetadata = Boolean(config.showMetadata);
    return {
      ...base,
      tickerId: showMetadata ? "" : base.tickerId,
      albumId: String(config.albumId || "").trim(),
      interval: Number.isFinite(interval) && interval > 0 ? interval : 20,
      showMetadata,
      frameHud: Boolean(config.frameHud),
      hudLeft: normalizeSlideshowHudCard(config.hudLeft, "clock"),
      hudRight: normalizeSlideshowHudCard(config.hudRight, "none"),
      random: config.random === undefined ? true : Boolean(config.random)
    };
  }

  if (template === "custom") {
    const widgetIds = (Array.isArray(config.widgetIds) ? config.widgetIds : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 4);
    return {
      ...base,
      widgetIds
    };
  }

  if (template === "map") {
    const centerMode = String(config.centerMode || "auto").trim().toLowerCase();
    const centerLat = Number(config.centerLat);
    const centerLon = Number(config.centerLon);
    const zoomRaw = Number(config.zoom);
    const zoom = Number.isFinite(zoomRaw) ? Math.round(zoomRaw) : 12;
    const markerEntities = normalizeStringList(config.markerEntities)
      .map((item) => item.toLowerCase())
      .slice(0, 24);
    return {
      ...base,
      centerMode: centerMode === "manual" ? "manual" : "auto",
      centerLat: Number.isFinite(centerLat) ? centerLat : null,
      centerLon: Number.isFinite(centerLon) ? centerLon : null,
      zoom: Math.max(2, Math.min(19, zoom)),
      showLabels: config.showLabels !== false,
      markerEntities
    };
  }

  return {
    ...base
  };
}

function saveProfile(profileId, name, template, config) {
  const now = new Date().toISOString();
  const requestedTemplate = String(template || "clock").trim() || "clock";
  const normalizedConfig = normalizeProfileConfig(requestedTemplate, config);
  sqliteExec(
    `INSERT INTO profiles (profile_id, name, template, config_json, created_at, updated_at)
     VALUES (
       ${sqlQuote(profileId)},
       ${sqlQuote(name)},
       ${sqlQuote(requestedTemplate)},
       ${sqlQuote(JSON.stringify(normalizedConfig))},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(profile_id) DO UPDATE SET
       name = excluded.name,
       template = excluded.template,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at;`
  );
  return getProfile(profileId);
}

function deleteProfile(profileId) {
  sqliteExec(`DELETE FROM profiles WHERE profile_id = ${sqlQuote(profileId)};`);
}

function buildLayoutPayloadFromProfile(profile) {
  if (!profile) {
    return null;
  }
  const config = profile.config || {};
  const payload = {
    template: profile.template
  };

  if (profile.template === "clock") {
    payload.title = String(config.title || "");
  }

  if (profile.template === "photo_slideshow") {
    if (config.albumId) {
      payload.albumId = config.albumId;
    }
    payload.template = "photo_slideshow";
    payload.interval = Number(config.interval || 20);
    payload.showMetadata = config.showMetadata === true;
    payload.frameHud = Boolean(config.frameHud);
    payload.hudLeft = config.hudLeft || { kind: "clock" };
    payload.hudRight = config.hudRight || { kind: "none" };
    payload.random = config.random === undefined ? true : Boolean(config.random);
    const entityIds = Array.from(
      new Set(
        [config.hudLeft, config.hudRight]
          .filter((item) => item && typeof item === "object" && String(item.kind || "").toLowerCase() === "entity")
          .map((item) => String(item.entityId || "").trim())
          .filter(Boolean)
      )
    );
    if (entityIds.length > 0) {
      const entityMap = new Map(haCache.entities.map((item) => [item.entityId, item]));
      payload.entityStates = Object.fromEntries(
        entityIds
          .filter((entityId) => entityMap.has(entityId))
          .map((entityId) => [entityId, entityMap.get(entityId)])
      );
    }
  }

  if (profile.template === "custom") {
    const widgetIds = (Array.isArray(config.widgetIds) ? config.widgetIds : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 4);
    const widgets = widgetIds
      .map((widgetId) => getWidget(widgetId))
      .filter(Boolean)
      .map((widget) => widget.config);
    payload.widgets = widgets;
    payload.widgetIds = widgetIds;
    const entityIds = collectEntityIdsFromCustomWidgets(widgets);
    if (entityIds.length > 0) {
      payload.entityStates = buildEntityStateMap(entityIds);
    }
  }

  if (profile.template === "map") {
    payload.template = "map";
    payload.centerMode = config.centerMode === "manual" ? "manual" : "auto";
    payload.centerLat = Number.isFinite(Number(config.centerLat)) ? Number(config.centerLat) : null;
    payload.centerLon = Number.isFinite(Number(config.centerLon)) ? Number(config.centerLon) : null;
    payload.zoom = Math.max(2, Math.min(19, Math.round(Number(config.zoom || 12))));
    payload.showLabels = config.showLabels !== false;
    payload.markerEntities = (Array.isArray(config.markerEntities) ? config.markerEntities : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 24);
    if (payload.markerEntities.length > 0) {
      payload.entityStates = buildEntityStateMap(payload.markerEntities);
    }
  }

  return payload;
}

function collectEntityIdsFromCustomWidgets(widgets = []) {
  return Array.from(
    new Set(
      (Array.isArray(widgets) ? widgets : [])
        .filter((widget) => {
          if (!widget || typeof widget !== "object") {
            return false;
          }
          const kind = String(widget.kind || "").toLowerCase();
          return ["entity", "weather", "status", "map"].includes(kind);
        })
        .flatMap((widget) => {
          const kind = String(widget.kind || "").toLowerCase();
          if (kind === "map") {
            return normalizeStringList(widget.markerEntities).map((item) => item.toLowerCase());
          }
          return [String(widget.entityId || "").trim()];
        })
        .filter(Boolean)
    )
  );
}

function buildEntityStateMap(entityIds = []) {
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    return {};
  }
  const entityMap = new Map(haCache.entities.map((item) => [item.entityId, item]));
  return Object.fromEntries(
    entityIds
      .filter((entityId) => entityMap.has(entityId))
      .map((entityId) => [entityId, entityMap.get(entityId)])
  );
}

function applyWidgetOverridesToLayout(layout, widgetOverrides) {
  if (!layout || layout.template !== "custom" || !Array.isArray(layout.widgets)) {
    return layout;
  }
  if (!widgetOverrides || typeof widgetOverrides !== "object") {
    return layout;
  }
  const entries = Object.entries(widgetOverrides)
    .map(([key, value]) => [Number(key), value])
    .filter(([index, value]) => Number.isInteger(index) && index >= 0 && index <= 3 && value && typeof value === "object");
  if (entries.length === 0) {
    return layout;
  }
  const widgets = [...layout.widgets];
  for (const [index, value] of entries) {
    widgets[index] = normalizeCustomProfileWidget(value);
  }
  const entityIds = collectEntityIdsFromCustomWidgets(widgets);
  const existingEntityStates = layout.entityStates && typeof layout.entityStates === "object"
    ? layout.entityStates
    : {};
  const nextEntityStates = {
    ...existingEntityStates,
    ...buildEntityStateMap(entityIds)
  };
  return {
    ...layout,
    widgets,
    entityStates: nextEntityStates
  };
}

function buildThemePayloadFromTheme(theme) {
  if (!theme) {
    return null;
  }
  const config = theme.config || {};
  return {
    mode: config.mode || "dark",
    fontFamily: config.fontFamily || "sans",
    fontColor: config.fontColor || ""
  };
}

function buildBannerPayloadFromBanner(banner) {
  if (!banner) {
    return null;
  }
  return {
    bannerId: banner.bannerId,
    text: renderTickerItemText(banner.config?.text || ""),
    subtext: renderTickerItemText(banner.config?.subtext || ""),
    variant: banner.config?.variant || "neutral"
  };
}

function buildTickerPayloadFromTicker(ticker) {
  if (!ticker) {
    return null;
  }
  const config = ticker.config || {};
  return {
    tickerId: ticker.tickerId,
    mode: config.mode || "single",
    message: renderTemplateString(config.message || ""),
    groups: (Array.isArray(config.groups) ? config.groups : []).map((group) => ({
      label: String(group.label || ""),
      level: String(group.level || "neutral"),
      items: (Array.isArray(group.items) ? group.items : []).map((item) => renderTickerItemText(item)).filter(Boolean)
    })),
    speed: Number(config.speed || 45)
  };
}

function broadcastRuntimeToScreen(screenId) {
  const runtime = getRuntimeStateForScreen(screenId);
  if (!runtime) {
    return false;
  }
  broadcast({
    type: "screen_runtime",
    target: screenId,
    command: "screen_runtime",
    payload: runtime
  });
  return true;
}

function refreshTemplatedRuntimeForEntity(entityId) {
  const targetEntityId = String(entityId || "").trim().toLowerCase();
  if (!targetEntityId) {
    return;
  }
  for (const screen of listScreens()) {
    const view = screen.viewId ? getView(screen.viewId) : null;
    const profile = view?.profileId ? getProfile(view.profileId) : null;
    if (!profile || !profile.config) {
      continue;
    }
    let affected = false;
    if (profile.config.bannerId) {
      const banner = getBanner(profile.config.bannerId);
      affected = templateEntityIdsFromValue(banner?.config || {}).includes(targetEntityId);
    }
    if (!affected && profile.config.tickerId) {
      const ticker = getTicker(profile.config.tickerId);
      affected = templateEntityIdsFromValue(ticker?.config || {}).includes(targetEntityId);
    }
    if (affected) {
      broadcastRuntimeToScreen(screen.screenId);
    }
  }
}

function getRuntimeStateForScreen(screenId) {
  const screen = getScreenRecord(screenId);
  if (!screen) {
    return null;
  }
  const override = getActiveRuntimeOverride(screenId);
  const assignedView = screen.viewId ? getView(screen.viewId) : null;
  const assignedProfile = assignedView?.profileId ? getProfile(assignedView.profileId) : null;
  const assignedTheme = assignedView?.themeId ? getTheme(assignedView.themeId) : null;
  const profile = override.profile || (override.profileId ? getProfile(override.profileId) : assignedProfile);
  const theme = override.theme || (override.themeId ? getTheme(override.themeId) : assignedTheme);
  const banner = profile?.config?.bannerId ? getBanner(profile.config.bannerId) : null;
  const ticker = profile?.config?.tickerId ? getTicker(profile.config.tickerId) : null;
  const baseLayout = Object.prototype.hasOwnProperty.call(override, "layout")
    ? override.layout
    : (profile ? buildLayoutPayloadFromProfile(profile) : null);
  const layoutWithWidgetOverrides = applyWidgetOverridesToLayout(baseLayout, override.widgetOverrides);
  return {
    screen,
    view: assignedView,
    profile,
    theme,
    layout: layoutWithWidgetOverrides,
    themeState: Object.prototype.hasOwnProperty.call(override, "themeState")
      ? override.themeState
      : (theme ? buildThemePayloadFromTheme(theme) : null),
    bannerState: Object.prototype.hasOwnProperty.call(override, "bannerState")
      ? override.bannerState
      : (banner ? buildBannerPayloadFromBanner(banner) : null),
    tickerState: Object.prototype.hasOwnProperty.call(override, "tickerState")
      ? override.tickerState
      : (ticker ? buildTickerPayloadFromTicker(ticker) : null)
  };
}

function getRuntimeStateForView(viewId) {
  const view = getView(viewId);
  if (!view) {
    return null;
  }
  const profile = view.profileId ? getProfile(view.profileId) : null;
  const theme = view.themeId ? getTheme(view.themeId) : null;
  const banner = profile?.config?.bannerId ? getBanner(profile.config.bannerId) : null;
  const ticker = profile?.config?.tickerId ? getTicker(profile.config.tickerId) : null;
  return {
    view,
    profile,
    theme,
    layout: profile ? buildLayoutPayloadFromProfile(profile) : { template: "clock", title: view.name || view.viewId },
    themeState: theme ? buildThemePayloadFromTheme(theme) : null,
    bannerState: banner ? buildBannerPayloadFromBanner(banner) : null,
    tickerState: ticker ? buildTickerPayloadFromTicker(ticker) : null
  };
}

function publishCommandToResolvedTargets(targets, command, payload, options = {}) {
  const qos = options.qos === undefined ? 1 : Number(options.qos);
  const retain = Boolean(options.retain);
  const resolvedTargets = Array.from(new Set((Array.isArray(targets) ? targets : []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)));

  if (resolvedTargets.length === 0) {
    return Promise.reject(new Error("target does not resolve to any registered screens"));
  }
  if (!mqttClient || !mqttState.connected) {
    return Promise.reject(new Error("MQTT broker is not connected"));
  }

  const data = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  const topics = resolvedTargets.map((target) => toTopic(target, "cmd", String(command)));

  return new Promise((resolve, reject) => {
    let pending = topics.length;
    let finished = false;
    for (const topic of topics) {
      mqttClient.publish(topic, data, { qos, retain }, (err) => {
        if (finished) {
          return;
        }
        if (err) {
          finished = true;
          reject(err);
          return;
        }
        pending -= 1;
        if (pending === 0) {
          finished = true;
          resolve({ topics, resolvedTargets, qos, retain });
        }
      });
    }
  });
}

async function processFrigateEvent(eventPayload = {}) {
  const label = String(eventPayload.label || eventPayload.object || "").trim().toLowerCase();
  const camera = String(eventPayload.camera || eventPayload.cameraName || "camera").trim();
  const snapshot = String(eventPayload.snapshot || eventPayload.snapshotUrl || "").trim();
  const when = eventPayload.time || eventPayload.ts || new Date().toISOString();
  const matched = [];

  for (const rule of listRules()) {
    if (!rule.enabled || rule.source !== "frigate") {
      continue;
    }
    if (rule.config.labels.length > 0 && !rule.config.labels.includes(label)) {
      continue;
    }
    if (!evaluateRuleCooldown(rule)) {
      continue;
    }
    const targets = resolveRuleTargets(rule);
    if (targets.length === 0) {
      continue;
    }

    if (rule.ruleType === "overlay") {
      const overlayPayload = {
        type: "frigate",
        label: label || "event",
        camera,
        duration: rule.config.duration,
        snapshot: snapshot
          || rule.config.snapshot
          || (camera ? `/api/frigate/cameras/${encodeURIComponent(camera)}/snapshot` : undefined),
        time: when
      };

      await publishCommandToResolvedTargets(targets, "overlay", overlayPayload, { retain: false, qos: 1 });
    } else {
      const applied = await executeTransientRuleAction(rule, targets);
      if (!applied) {
        continue;
      }
    }

    markRuleApplied(rule, targets);
    ruleRuntime.set(rule.ruleId, Date.now());
    matched.push({
      ruleId: rule.ruleId,
      targets
    });
  }

  return {
    matchedCount: matched.length,
    matched
  };
}

async function processHaStateEvent(newState) {
  const entityId = String(newState?.entity_id || "").trim().toLowerCase();
  if (!entityId) {
    return { matchedCount: 0, matched: [] };
  }

  const matched = [];
  for (const rule of listRules()) {
    if (!rule.enabled || rule.source !== "home_assistant") {
      continue;
    }
    if (rule.config.entityId && rule.config.entityId !== entityId) {
      continue;
    }
    if (!evaluateRuleCooldown(rule)) {
      continue;
    }
    if (!evaluateStateCondition(newState, rule.config.operator, rule.config.value)) {
      continue;
    }

    const targets = resolveRuleTargets(rule);
    if (targets.length === 0) {
      continue;
    }

    const applied = await executeTransientRuleAction(rule, targets);
    if (!applied) {
      continue;
    }

    markRuleApplied(rule, targets);
    ruleRuntime.set(rule.ruleId, Date.now());
    matched.push({
      ruleId: rule.ruleId,
      targets
    });
  }

  return {
    matchedCount: matched.length,
    matched
  };
}

async function processScheduleRules(now = new Date()) {
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const pending = [];

  for (const rule of listRules()) {
    if (!rule.enabled || rule.source !== "schedule") {
      continue;
    }
    if (!validTimeOfDay(rule.config.timeOfDay)) {
      continue;
    }
    const isPersistent = rule.config.duration === null;
    if (isPersistent) {
      for (const candidate of collectPersistentScheduleCandidates(rule, now)) {
        pending.push({
          rule,
          slotKey: candidate.slotKey,
          runAt: candidate.occurrence.getTime()
        });
      }
      continue;
    }
    if (rule.config.timeOfDay !== currentTime || !ruleAllowsDay(rule, currentDayToken(now))) {
      continue;
    }
    const occurrence = new Date(now);
    occurrence.setSeconds(0, 0);
    const slotKey = scheduleSlotKeyFor(occurrence, currentTime);
    pending.push({
      rule,
      slotKey,
      runAt: occurrence.getTime()
    });
  }

  pending.sort((a, b) => a.runAt - b.runAt);

  for (const item of pending) {
    const lastRunAt = Number(scheduleRuleLastRunAt.get(item.rule.ruleId) || 0);
    if (item.runAt <= lastRunAt) {
      continue;
    }
    const targets = resolveRuleTargets(item.rule);
    if (targets.length === 0) {
      continue;
    }
    const applied = await executeTransientRuleAction(item.rule, targets);
    if (!applied) {
      continue;
    }
    console.log(
      `[schedule] applied ${item.rule.ruleId} (${item.rule.config.timeOfDay}) slot=${item.slotKey} targets=${targets.join(",")}`
    );
    markRuleApplied(item.rule, targets);
    scheduleRuleLastRunAt.set(item.rule.ruleId, item.runAt);
    ruleRuntime.set(item.rule.ruleId, Date.now());
  }
}

function normalizeFrigateMqttEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const eventType = String(payload.type || "").trim().toLowerCase();
  if (eventType === "end") {
    return null;
  }

  const source = payload.after && typeof payload.after === "object"
    ? payload.after
    : payload;
  const label = String(source.label || payload.label || source.sub_label || payload.object || "").trim().toLowerCase();
  const camera = String(source.camera || payload.camera || "").trim();
  if (!label || !camera) {
    return null;
  }

  const tsRaw = source.start_time ?? source.frame_time ?? payload.ts ?? payload.time;
  let time = new Date().toISOString();
  if (typeof tsRaw === "number" && Number.isFinite(tsRaw)) {
    const millis = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
    time = new Date(millis).toISOString();
  } else if (typeof tsRaw === "string" && tsRaw.trim()) {
    const parsed = new Date(tsRaw);
    if (!Number.isNaN(parsed.getTime())) {
      time = parsed.toISOString();
    }
  }

  return {
    label,
    camera,
    time
  };
}

async function proxyFrigateSnapshot(camera, res, mode = "auto") {
  const frigate = getFrigateConfig();
  if (!frigate.url) {
    return res.status(503).json({ error: "Frigate is not configured" });
  }
  if (!camera) {
    return res.status(400).json({ error: "camera is required" });
  }

  if (mode !== "still") {
    const streamed = await proxyFrigateLive(camera, res, frigate.url);
    if (streamed) {
      return null;
    }
  }

  const attempts = [`${frigate.url}/api/${encodeURIComponent(camera)}/latest.jpg`];

  let lastError = null;
  for (const url of attempts) {
    try {
      const upstream = await fetch(url);
      if (!upstream.ok || !upstream.body) {
        lastError = `Frigate snapshot error (${upstream.status})`;
        continue;
      }

      const contentType = upstream.headers.get("content-type") || "image/jpeg";
      const contentLength = upstream.headers.get("content-length");
      const cacheControl = upstream.headers.get("cache-control") || "no-store";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", cacheControl);
      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }
      Readable.fromWeb(upstream.body).pipe(res);
      return null;
    } catch (err) {
      lastError = err.message || "Frigate snapshot request failed";
    }
  }

  return res.status(502).json({ error: lastError || "Frigate snapshot unavailable" });
}

function proxyFrigateLive(camera, res, frigateUrl) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(`${frigateUrl}/api/${encodeURIComponent(camera)}`);
    } catch {
      resolve(false);
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const upstreamReq = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: `${target.pathname}${target.search}`,
      headers: {
        Accept: "multipart/x-mixed-replace, image/jpeg, */*"
      }
    }, (upstreamRes) => {
      const statusCode = Number(upstreamRes.statusCode || 0);
      if (statusCode < 200 || statusCode >= 300 || !upstreamRes.headers["content-type"]) {
        upstreamRes.resume();
        resolve(false);
        return;
      }

      res.setHeader("Content-Type", upstreamRes.headers["content-type"]);
      res.setHeader("Cache-Control", upstreamRes.headers["cache-control"] || "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      if (upstreamRes.headers["content-length"]) {
        res.setHeader("Content-Length", upstreamRes.headers["content-length"]);
      }

      const cleanup = () => {
        upstreamReq.destroy();
        upstreamRes.destroy();
      };
      res.on("close", cleanup);
      upstreamRes.pipe(res);
      resolve(true);
    });

    upstreamReq.on("error", () => {
      resolve(false);
    });

    upstreamReq.end();
  });
}

ensureDatabase();
assertFinalDatabaseSchema();
ensureBootstrapToken();

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      out[key] = decodeURIComponent(value);
    }
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

function getBootstrapToken() {
  return String(getSetting("bootstrap_token", BOOTSTRAP_TOKEN_ENV) || "").trim();
}

function ensureBootstrapToken() {
  if (adminConfigured()) {
    return;
  }
  const current = getBootstrapToken();
  if (BOOTSTRAP_TOKEN_ENV) {
    if (current !== BOOTSTRAP_TOKEN_ENV) {
      setSetting("bootstrap_token", BOOTSTRAP_TOKEN_ENV, true);
    }
    return;
  }
  if (!current) {
    const next = crypto.randomBytes(18).toString("base64url");
    setSetting("bootstrap_token", next, true);
    console.log(`[setup] bootstrap token: ${next}`);
    console.log("[setup] use this token once in the onboarding form to claim the instance");
  }
}

function bootstrapTokenValid(supplied) {
  const expected = getBootstrapToken();
  const token = String(supplied || "").trim();
  if (!expected) {
    return true;
  }
  const suppliedBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(suppliedBuf, expectedBuf);
}

function passwordPolicyError(password) {
  const value = String(password || "");
  if (value.length < 12) {
    return "password must be at least 12 characters";
  }
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /\d/.test(value);
  if (!hasLower || !hasUpper || !hasDigit) {
    return "password must include uppercase, lowercase, and a number";
  }
  return "";
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt:")) {
    return false;
  }
  const [, salt, expected] = stored.split(":");
  if (!salt || !expected) {
    return false;
  }
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

async function verifyPasswordAsync(password, stored) {
  if (!stored || !stored.startsWith("scrypt:")) {
    return false;
  }
  const [, salt, expected] = stored.split(":");
  if (!salt || !expected) {
    return false;
  }
  try {
    const derived = await scryptAsync(password, salt, 64);
    const actual = Buffer.from(derived).toString("hex");
    const actualBuf = Buffer.from(actual, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function hashDeviceKey(deviceKey) {
  return crypto.createHash("sha256").update(String(deviceKey || "")).digest("hex");
}

function deviceKeyValid(deviceKey) {
  return DEVICE_KEY_PATTERN.test(String(deviceKey || "").trim().toLowerCase());
}

function constantTimeHexEqual(a, b) {
  const aHex = String(a || "");
  const bHex = String(b || "");
  if (!/^[a-f0-9]+$/i.test(aHex) || !/^[a-f0-9]+$/i.test(bHex)) {
    return false;
  }
  const aBuf = Buffer.from(aHex, "hex");
  const bBuf = Buffer.from(bHex, "hex");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getWsClientIp(req, ws) {
  if (TRUST_PROXY) {
    const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return req?.socket?.remoteAddress || ws?._socket?.remoteAddress || "unknown";
}

function pruneWsNewDeviceWindow(entry, now = Date.now()) {
  if (!entry || !Array.isArray(entry.timestamps)) {
    return;
  }
  entry.timestamps = entry.timestamps.filter((ts) => now - ts <= WS_NEW_DEVICE_WINDOW_MS);
}

function allowWsNewDevice(ip, now = Date.now()) {
  const key = String(ip || "unknown");
  const entry = wsNewDeviceState.get(key) || { timestamps: [] };
  pruneWsNewDeviceWindow(entry, now);
  if (entry.timestamps.length >= WS_NEW_DEVICE_MAX_PER_IP) {
    wsNewDeviceState.set(key, entry);
    return false;
  }
  entry.timestamps.push(now);
  wsNewDeviceState.set(key, entry);
  return true;
}

function pruneLoginAttempts(entry, now = Date.now()) {
  if (!entry || !Array.isArray(entry.failures)) {
    return;
  }
  entry.failures = entry.failures.filter((ts) => now - ts <= LOGIN_RATE_WINDOW_MS);
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    entry.lockedUntil = 0;
  }
}

function loginAttemptStatus(key, now = Date.now()) {
  const entry = loginAttemptState.get(key) || { failures: [], lockedUntil: 0 };
  pruneLoginAttempts(entry, now);
  loginAttemptState.set(key, entry);
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return {
      allowed: false,
      reason: "locked",
      retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000))
    };
  }
  if (entry.failures.length >= LOGIN_MAX_ATTEMPTS) {
    const oldest = Math.min(...entry.failures);
    const retryAt = oldest + LOGIN_RATE_WINDOW_MS;
    return {
      allowed: false,
      reason: "rate_limit",
      retryAfterSec: Math.max(1, Math.ceil((retryAt - now) / 1000))
    };
  }
  return { allowed: true };
}

function recordLoginFailure(key, now = Date.now()) {
  const entry = loginAttemptState.get(key) || { failures: [], lockedUntil: 0 };
  pruneLoginAttempts(entry, now);
  entry.failures.push(now);
  if (entry.failures.length >= LOGIN_LOCK_THRESHOLD) {
    entry.lockedUntil = now + LOGIN_LOCK_MS;
  }
  loginAttemptState.set(key, entry);
}

function clearLoginFailures(key) {
  loginAttemptState.delete(key);
}

function adminConfigured() {
  return Boolean(getSetting("admin_password_hash"));
}

function createSessionToken() {
  const sessionSecret = getSetting("session_secret");
  if (!sessionSecret) {
    return null;
  }
  const payload = {
    exp: Date.now() + SESSION_MAX_AGE_MS
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", sessionSecret)
    .update(payloadEncoded)
    .digest("base64url");
  return `${payloadEncoded}.${sig}`;
}

function createMediaToken(screenId, expiresAt = Date.now() + MEDIA_TOKEN_MAX_AGE_MS) {
  const sessionSecret = getSetting("session_secret");
  const normalizedScreen = String(screenId || "").trim().toLowerCase();
  if (!sessionSecret || !normalizedScreen) {
    return null;
  }
  const payload = {
    typ: "media",
    sid: normalizedScreen,
    exp: Number(expiresAt)
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", sessionSecret)
    .update(payloadEncoded)
    .digest("base64url");
  return `${payloadEncoded}.${sig}`;
}

function createViewAccessToken(viewId, expiresAt = Date.now() + VIEW_ACCESS_MAX_AGE_MS) {
  const sessionSecret = getSetting("session_secret");
  const normalizedView = String(viewId || "").trim().toLowerCase();
  if (!sessionSecret || !normalizedView) {
    return null;
  }
  const payload = {
    typ: "view_access",
    vid: normalizedView,
    exp: Number(expiresAt)
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", sessionSecret)
    .update(payloadEncoded)
    .digest("base64url");
  return `${payloadEncoded}.${sig}`;
}

function mediaSecretFingerprint() {
  const sessionSecret = getSetting("session_secret");
  if (!sessionSecret) {
    return "";
  }
  return crypto.createHash("sha256").update(String(sessionSecret)).digest("hex").slice(0, 16);
}

function getOrCreateMediaToken(screenId) {
  const normalizedScreen = String(screenId || "").trim().toLowerCase();
  if (!normalizedScreen) {
    return null;
  }
  const now = Date.now();
  const fingerprint = mediaSecretFingerprint();
  const cached = mediaTokenCache.get(normalizedScreen);
  if (
    cached
    && cached.token
    && cached.secretFingerprint === fingerprint
    && Number(cached.expiresAt || 0) > now + 5 * 60 * 1000
  ) {
    return cached.token;
  }
  const expiresAt = now + MEDIA_TOKEN_MAX_AGE_MS;
  const token = createMediaToken(normalizedScreen, expiresAt);
  if (!token) {
    return null;
  }
  mediaTokenCache.set(normalizedScreen, {
    token,
    expiresAt,
    secretFingerprint: fingerprint
  });
  return token;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) {
    return false;
  }
  const sessionSecret = getSetting("session_secret");
  if (!sessionSecret) {
    return false;
  }
  const [payloadEncoded, sig] = token.split(".");
  const expected = crypto
    .createHmac("sha256", sessionSecret)
    .update(payloadEncoded)
    .digest("base64url");
  if (sig !== expected) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString("utf8"));
    return Number(payload.exp || 0) > Date.now();
  } catch {
    return false;
  }
}

function verifyMediaToken(token) {
  if (!token || !token.includes(".")) {
    return null;
  }
  const sessionSecret = getSetting("session_secret");
  if (!sessionSecret) {
    return null;
  }
  const [payloadEncoded, sig] = String(token).split(".");
  const expected = crypto
    .createHmac("sha256", sessionSecret)
    .update(payloadEncoded)
    .digest("base64url");
  if (sig !== expected) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString("utf8"));
    if (payload.typ !== "media" || Number(payload.exp || 0) <= Date.now()) {
      return null;
    }
    const sid = String(payload.sid || "").trim().toLowerCase();
    if (!sid) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function verifyViewAccessToken(token) {
  if (!token || !token.includes(".")) {
    return null;
  }
  const sessionSecret = getSetting("session_secret");
  if (!sessionSecret) {
    return null;
  }
  const [payloadEncoded, sig] = String(token).split(".");
  const expected = crypto
    .createHmac("sha256", sessionSecret)
    .update(payloadEncoded)
    .digest("base64url");
  if (sig !== expected) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString("utf8"));
    if (payload.typ !== "view_access" || Number(payload.exp || 0) <= Date.now()) {
      return null;
    }
    const vid = String(payload.vid || "").trim().toLowerCase();
    if (!vid) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function isSecureRequest(req) {
  if (FORCE_SECURE_COOKIES) {
    return true;
  }
  if (req.secure) {
    return true;
  }
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return forwardedProto === "https";
}

function setSessionCookie(req, res, token) {
  const parts = [
    `signage_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`
  ];
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [
    "signage_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies.signage_session);
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "authentication required" });
  }
  return next();
}

function requestedMediaScope(req) {
  return String(
    req.query?.sid
    || req.headers["x-coreview-screen-id"]
    || ""
  ).trim().toLowerCase();
}

function mediaAuthorized(req) {
  if (isAuthenticated(req)) {
    return true;
  }
  const token = String(req.query?.st || req.headers["x-coreview-media-token"] || "").trim();
  const payload = verifyMediaToken(token);
  if (!payload) {
    return false;
  }
  const scope = requestedMediaScope(req);
  if (!scope) {
    return false;
  }
  return scope === String(payload.sid || "").trim().toLowerCase();
}

function requireMediaAuth(req, res, next) {
  if (!mediaAuthorized(req)) {
    return res.status(401).json({ error: "media authentication required" });
  }
  return next();
}

function readViewAccessToken(req) {
  const queryToken = String(req.query?.vt || "").trim();
  const headerToken = String(req.headers["x-coreview-view-token"] || "").trim();
  return queryToken || headerToken;
}

function viewRequestAuthorized(req, viewId) {
  if (isAuthenticated(req)) {
    return true;
  }
  const payload = verifyViewAccessToken(readViewAccessToken(req));
  if (!payload) {
    return false;
  }
  return String(payload.vid || "").trim().toLowerCase() === String(viewId || "").trim().toLowerCase();
}

function eventWebhookAuthorized(req) {
  const config = getEventWebhookConfig();
  if (!config.token) {
    return false;
  }
  const headerToken = String(req.headers["x-coreview-token"] || "").trim();
  const authHeader = String(req.headers.authorization || "").trim();
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const supplied = headerToken || bearer;
  if (!supplied) {
    return false;
  }
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(config.token);
  if (suppliedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(suppliedBuf, expectedBuf);
}

function requireEventWebhookAuth(req, res, next) {
  if (!eventWebhookAuthorized(req)) {
    return res.status(401).json({ error: "event authentication required" });
  }
  return next();
}

function immichConfigured() {
  const config = getImmichConfig();
  return Boolean(config.url && config.apiKey);
}

async function immichFetch(pathname) {
  const config = getImmichConfig();
  const url = `${config.url}${pathname}`;
  return fetch(url, {
    headers: {
      Accept: "application/json",
      "x-api-key": config.apiKey
    }
  });
}

function broadcast(message) {
  const outbound = message && typeof message === "object" ? { ...message } : message;
  if (outbound && outbound.type === "screen_runtime" && outbound.target && !outbound.mediaToken) {
    outbound.mediaToken = getOrCreateMediaToken(outbound.target);
  }
  const serialized = JSON.stringify(outbound);
  for (const ws of wss.clients) {
    if (outbound && outbound.type === "screen_runtime" && outbound.target) {
      const clientId = ws._coreviewClientId || null;
      const client = clientId ? clients.get(clientId) : null;
      const clientTarget = String(client?.target || "").trim().toLowerCase();
      const messageTarget = String(outbound.target || "").trim().toLowerCase();
      if (!clientTarget || !messageTarget || clientTarget !== messageTarget) {
        continue;
      }
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(serialized);
    }
  }
}

function toTopic(target, type, key) {
  return `${MQTT_TOPIC_ROOT}/${target}/${type}/${key}`;
}

function safeJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return { raw: payload };
  }
}

function haConfigured() {
  const config = getHaConfig();
  return Boolean(config.url && config.token);
}

function normalizeHaEntity(entity = {}) {
  const attrs = entity.attributes || {};
  return {
    entityId: entity.entity_id,
    domain: String(entity.entity_id || "").split(".")[0] || "unknown",
    state: entity.state,
    friendlyName: attrs.friendly_name || entity.entity_id,
    unit: attrs.unit_of_measurement || attrs.temperature_unit || null,
    deviceClass: attrs.device_class || null,
    icon: attrs.icon || null,
    attributes: attrs
  };
}

async function refreshHaEntities() {
  if (!haConfigured()) {
    haCache.entities = [];
    haCache.lastError = null;
    haCache.lastSyncAt = null;
    return;
  }

  try {
    const config = getHaConfig();
    const rsp = await fetch(`${config.url}/api/states`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json"
      }
    });
    if (!rsp.ok) {
      throw new Error(`Home Assistant API error (${rsp.status})`);
    }
    const data = await rsp.json();
    haCache.entities = Array.isArray(data)
      ? data.map(normalizeHaEntity).sort((a, b) => a.entityId.localeCompare(b.entityId))
      : [];
    haCache.lastSyncAt = new Date().toISOString();
    haCache.lastError = null;
  } catch (err) {
    haCache.lastError = err.message || "unknown error";
  }
}

function haConnected() {
  return haConfigured() && haStream.connected && Boolean(haCache.lastSyncAt) && !haCache.lastError;
}

function setHaEntityState(entity) {
  const normalized = normalizeHaEntity(entity);
  const next = new Map(haCache.entities.map((item) => [item.entityId, item]));
  next.set(normalized.entityId, normalized);
  haCache.entities = Array.from(next.values()).sort((a, b) => a.entityId.localeCompare(b.entityId));
  haCache.lastSyncAt = new Date().toISOString();
  haCache.lastError = null;
  broadcast({
    type: "ha_state",
    command: "ha_state",
    payload: normalized
  });
  refreshTemplatedRuntimeForEntity(normalized.entityId);
}

function removeHaEntityState(entityId) {
  const next = new Map(haCache.entities.map((item) => [item.entityId, item]));
  next.delete(entityId);
  haCache.entities = Array.from(next.values()).sort((a, b) => a.entityId.localeCompare(b.entityId));
  haCache.lastSyncAt = new Date().toISOString();
  haCache.lastError = null;
  broadcast({
    type: "ha_removed",
    command: "ha_removed",
    payload: { entityId }
  });
  refreshTemplatedRuntimeForEntity(entityId);
}

function scheduleHaReconnect() {
  if (haStream.reconnectTimer) {
    clearTimeout(haStream.reconnectTimer);
  }
  if (!haConfigured()) {
    return;
  }
  haStream.reconnectTimer = setTimeout(() => {
    connectHaStream(true);
  }, 3000);
}

function handleHaWsMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }

  const ws = haStream.ws;
  if (!ws) {
    return;
  }

  if (message.type === "auth_required") {
    const config = getHaConfig();
    ws.send(JSON.stringify({
      type: "auth",
      access_token: config.token
    }));
    return;
  }

  if (message.type === "auth_ok") {
    haStream.connected = true;
    haCache.lastError = null;
    refreshHaEntities().catch((err) => {
      haCache.lastError = err.message || "Home Assistant refresh failed";
    });
    ws.send(JSON.stringify({
      id: haStream.nextMessageId++,
      type: "subscribe_events",
      event_type: "state_changed"
    }));
    return;
  }

  if (message.type === "auth_invalid") {
    haStream.connected = false;
    haCache.lastError = message.message || "Home Assistant authentication failed";
    return;
  }

  if (message.type === "event" && message.event?.event_type === "state_changed") {
    const eventData = message.event?.data || {};
    const entityId = String(eventData.entity_id || "").trim();
    const newState = eventData.new_state || null;
    const oldState = eventData.old_state || null;
    if (newState && typeof newState === "object") {
      setHaEntityState(newState);
      if (String(newState.state ?? "") !== String(oldState?.state ?? "")) {
        processHaStateEvent(newState).catch((err) => {
          console.error("HA state rule processing error:", err.message);
        });
      }
    } else if (entityId) {
      removeHaEntityState(entityId);
    }
  }
}

function connectHaStream(force = false) {
  if (!haConfigured()) {
    haStream.connected = false;
    if (haStream.reconnectTimer) {
      clearTimeout(haStream.reconnectTimer);
      haStream.reconnectTimer = null;
    }
    if (haStream.ws) {
      haStream.ws.close();
      haStream.ws = null;
    }
    haCache.entities = [];
    haCache.lastSyncAt = null;
    haCache.lastError = null;
    return;
  }

  if (!force && haStream.ws && (haStream.ws.readyState === WebSocket.OPEN || haStream.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (haStream.reconnectTimer) {
    clearTimeout(haStream.reconnectTimer);
    haStream.reconnectTimer = null;
  }

  if (haStream.ws) {
    try {
      haStream.ws.close();
    } catch {
      // ignore shutdown errors
    }
    haStream.ws = null;
  }

  const config = getHaConfig();
  const wsUrl = `${config.url.replace(/^http/i, "ws")}/api/websocket`;
  const ws = new WebSocket(wsUrl);
  haStream.ws = ws;
  haStream.connected = false;

  ws.on("message", handleHaWsMessage);
  ws.on("close", () => {
    haStream.connected = false;
    haStream.ws = null;
    if (haConfigured()) {
      haCache.lastError = "Home Assistant stream disconnected";
      scheduleHaReconnect();
    }
  });
  ws.on("error", (err) => {
    haStream.connected = false;
    haCache.lastError = err.message || "Home Assistant stream error";
  });
}

async function refreshImmichStatus() {
  if (!immichConfigured()) {
    immichCache.reachable = false;
    immichCache.lastCheckedAt = null;
    immichCache.lastError = null;
    immichCache.version = null;
    return;
  }

  try {
    const config = getImmichConfig();
    const probePath = config.albumId
      ? `/api/albums/${encodeURIComponent(config.albumId)}`
      : "/api/albums";
    const rsp = await immichFetch(probePath);
    if (!rsp.ok) {
      throw new Error(`Immich API error (${rsp.status})`);
    }
    const body = await rsp.text();
    let version = "ok";
    try {
      const parsed = JSON.parse(body);
      version = parsed.version || parsed.albumName || parsed.id || parsed.total || version;
    } catch {
      version = body.trim() || version;
    }
    immichCache.reachable = true;
    immichCache.lastCheckedAt = new Date().toISOString();
    immichCache.lastError = null;
    immichCache.version = version || "ok";
  } catch (err) {
    immichCache.reachable = false;
    immichCache.lastCheckedAt = new Date().toISOString();
    immichCache.lastError = err.message || "unknown error";
    immichCache.version = null;
  }
}

async function refreshFrigateStatus() {
  const config = getFrigateConfig();
  if (!config.url) {
    frigateCache.reachable = false;
    frigateCache.lastCheckedAt = null;
    frigateCache.lastError = null;
    frigateCache.version = null;
    frigateCache.cameras = [];
    return;
  }

  try {
    const rsp = await fetch(`${config.url}/api/version`, {
      headers: {
        Accept: "text/plain, application/json"
      }
    });
    if (!rsp.ok) {
      throw new Error(`Frigate API error (${rsp.status})`);
    }
    const body = (await rsp.text()).trim();
    frigateCache.reachable = true;
    frigateCache.lastCheckedAt = new Date().toISOString();
    frigateCache.lastError = null;
    frigateCache.version = body || "ok";
    try {
      const configRsp = await fetch(`${config.url}/api/config`, {
        headers: {
          Accept: "application/json"
        }
      });
      if (configRsp.ok) {
        const parsed = await configRsp.json();
        const cameras = parsed && parsed.cameras && typeof parsed.cameras === "object"
          ? Object.keys(parsed.cameras)
          : [];
        frigateCache.cameras = cameras.sort((a, b) => a.localeCompare(b));
      } else {
        frigateCache.cameras = [];
      }
    } catch {
      frigateCache.cameras = [];
    }
  } catch (err) {
    frigateCache.reachable = false;
    frigateCache.lastCheckedAt = new Date().toISOString();
    frigateCache.lastError = err.message || "unknown error";
    frigateCache.version = null;
    frigateCache.cameras = [];
  }
}

function screenStateFor(target, info = {}) {
  const lastSeen = Number(info.lastSeen || 0);
  const ageMs = lastSeen > 0 ? Date.now() - lastSeen : null;
  let status = "offline";
  if (info.connected) {
    status = ageMs !== null && ageMs <= HEARTBEAT_STALE_MS ? "online" : "stale";
  }
  const screen = getScreenRecord(target);
  const assignedView = screen?.viewId ? getView(screen.viewId) : null;
  const override = getActiveRuntimeOverride(target);
  const currentViewId = assignedView?.viewId || screen?.viewId || null;
  const effectiveProfileId = override.profileId || assignedView?.profileId || null;
  const currentThemeId = override.themeId || assignedView?.themeId || null;
  const currentWidgetOverrideCount = override.widgetOverrides && typeof override.widgetOverrides === "object"
    ? Object.keys(override.widgetOverrides).length
    : 0;
  const effectiveProfile = effectiveProfileId ? getProfile(effectiveProfileId) : null;
  const currentBannerId = override.bannerId || effectiveProfile?.config?.bannerId || null;
  const currentTickerId = override.tickerId || effectiveProfile?.config?.tickerId || null;
  const lastRule = lastAppliedRuleByTarget.get(target) || null;
  return {
    target,
    clientId: info.clientId || null,
    connected: Boolean(info.connected),
    lastSeen: lastSeen > 0 ? new Date(lastSeen).toISOString() : null,
    ageMs,
    status,
    userAgent: info.userAgent || null,
    connectedAt: info.connectedAt ? new Date(info.connectedAt).toISOString() : null,
    disconnectedAt: info.disconnectedAt ? new Date(info.disconnectedAt).toISOString() : null,
    currentViewId,
    currentProfileId: effectiveProfileId,
    currentThemeId,
    currentBannerId,
    currentTickerId,
    currentWidgetOverrideCount,
    lastRule
  };
}

function getScreenStates() {
  const targets = Array.from(
    new Set([
      ...listScreens().map((item) => item.screenId),
      ...Array.from(onlineByTarget.keys())
    ])
  );
  return targets
    .map((target) => screenStateFor(target, onlineByTarget.get(target) || {}))
    .sort((a, b) => a.target.localeCompare(b.target));
}

function resetVolatileRuntimeState() {
  for (const timer of transientRestoreTimers.values()) {
    clearTimeout(timer);
  }
  transientRestoreTimers.clear();
  activeRuntimeOverrides.clear();
  lastAppliedRuleByTarget.clear();
  ruleRuntime.clear();
  scheduleRuleLastRunAt.clear();
}

function buildConfigSnapshot() {
  return {
    format: "coreview-config",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: listSettingsRaw(),
    devices: listDevicesRaw(),
    screens: listScreensRaw(),
    widgets: listWidgets(),
    profiles: listProfiles(),
    views: listViews(),
    themes: listThemes(),
    banners: listBanners(),
    tickers: listTickers(),
    groups: listGroups(),
    rules: listRules()
  };
}

function backupFilename(stamp = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `coreview-backup-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.json`;
}

function writeBackupFile(snapshot, reason = "manual") {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const payload = {
    ...snapshot,
    backupReason: reason
  };
  const filename = backupFilename(new Date());
  const fullPath = path.join(BACKUP_DIR, filename);
  fs.writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  try {
    fs.chmodSync(fullPath, 0o600);
  } catch (_err) {
    // Best-effort permission hardening for backup files.
  }
  return {
    filename,
    path: fullPath
  };
}

function listBackupFiles() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs.readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(fullPath);
      return {
        filename: name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
    .slice(0, 20);
}

function importConfigSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("snapshot must be an object");
  }
  if (snapshot.format !== "coreview-config") {
    throw new Error("unsupported snapshot format");
  }

  const normalizedSettings = (Array.isArray(snapshot.settings) ? snapshot.settings : []).map((row) => {
    if (!row || !row.key) {
      return null;
    }
    const isSecret = Boolean(row.isSecret);
    let value = row.value === undefined || row.value === null ? "" : String(row.value);
    if (isSecret && isEncryptedSecretValue(value)) {
      try {
        value = decryptSecretValue(value);
      } catch (err) {
        throw new Error(`failed to import secret setting ${row.key}: ${err.message}`);
      }
    }
    return {
      key: String(row.key),
      value,
      isSecret
    };
  }).filter(Boolean);

  sqliteExec(`
    DELETE FROM group_members;
    DELETE FROM groups;
    DELETE FROM rules;
    DELETE FROM views;
    DELETE FROM banners;
    DELETE FROM tickers;
    DELETE FROM themes;
    DELETE FROM profiles;
    DELETE FROM screens;
    DELETE FROM devices;
    DELETE FROM app_settings;
  `);

  for (const row of normalizedSettings) {
    setSetting(row.key, row.value, row.isSecret);
  }

  for (const row of Array.isArray(snapshot.devices) ? snapshot.devices : []) {
    if (!row || !row.deviceId) {
      continue;
    }
    const now = new Date().toISOString();
    sqliteExec(
      `INSERT INTO devices (
         device_id, pairing_code, assigned_screen_id, registered, created_at, updated_at, last_seen_at, last_ip, user_agent
       ) VALUES (
         ${sqlQuote(String(row.deviceId).trim())},
         ${sqlQuote(row.pairingCode || null)},
         ${sqlQuote(row.assignedScreenId || null)},
         ${row.registered ? 1 : 0},
         ${sqlQuote(row.createdAt || now)},
         ${sqlQuote(row.updatedAt || now)},
         ${sqlQuote(row.lastSeenAt || null)},
         ${sqlQuote(row.lastIp || null)},
         ${sqlQuote(row.userAgent || null)}
       );`
    );
  }

  for (const row of Array.isArray(snapshot.profiles) ? snapshot.profiles : []) {
    if (!row || !row.profileId) {
      continue;
    }
    saveProfile(String(row.profileId).trim().toLowerCase(), String(row.name || row.profileId), String(row.template || "clock"), row.config || {});
  }

  for (const row of Array.isArray(snapshot.views) ? snapshot.views : []) {
    if (!row || !row.viewId) {
      continue;
    }
    saveView(
      String(row.viewId).trim().toLowerCase(),
      String(row.name || row.viewId),
      row.profileId ? String(row.profileId).trim().toLowerCase() : null,
      row.themeId ? String(row.themeId).trim().toLowerCase() : null
    );
  }

  for (const row of Array.isArray(snapshot.themes) ? snapshot.themes : []) {
    if (!row || !row.themeId) {
      continue;
    }
    saveTheme(String(row.themeId).trim().toLowerCase(), String(row.name || row.themeId), row.config || {});
  }

  for (const row of Array.isArray(snapshot.banners) ? snapshot.banners : []) {
    if (!row || !row.bannerId) {
      continue;
    }
    saveBanner(String(row.bannerId).trim().toLowerCase(), String(row.name || row.bannerId), row.config || {});
  }

  for (const row of Array.isArray(snapshot.tickers) ? snapshot.tickers : []) {
    if (!row || !row.tickerId) {
      continue;
    }
    saveTicker(String(row.tickerId).trim().toLowerCase(), String(row.name || row.tickerId), row.config || {});
  }

  for (const row of Array.isArray(snapshot.widgets) ? snapshot.widgets : []) {
    if (!row || !row.widgetId) {
      continue;
    }
    saveWidget(
      String(row.widgetId).trim().toLowerCase(),
      String(row.name || row.widgetId),
      row.config || {}
    );
  }

  for (const row of Array.isArray(snapshot.screens) ? snapshot.screens : []) {
    if (!row || !row.screenId) {
      continue;
    }
    let resolvedViewId = String(row.viewId || "").trim().toLowerCase() || null;
    if (!resolvedViewId) {
      const legacyProfileId = row.profileId ? String(row.profileId).trim().toLowerCase() : null;
      const legacyThemeId = row.themeId ? String(row.themeId).trim().toLowerCase() : null;
      const fallbackViewId = buildUniqueViewId(`screen-${String(row.screenId).trim().toLowerCase()}`);
      saveView(
        fallbackViewId,
        `${String(row.friendlyName || row.screenId)} Default`,
        legacyProfileId && getProfile(legacyProfileId) ? legacyProfileId : null,
        legacyThemeId && getTheme(legacyThemeId) ? legacyThemeId : null
      );
      resolvedViewId = fallbackViewId;
    }
    const now = new Date().toISOString();
    sqliteExec(
      `INSERT INTO screens (
         screen_id, device_id, friendly_name, view_id, created_at, updated_at
       ) VALUES (
         ${sqlQuote(String(row.screenId).trim().toLowerCase())},
         ${sqlQuote(row.deviceId || null)},
         ${sqlQuote(String(row.friendlyName || ""))},
         ${sqlQuote(resolvedViewId)},
         ${sqlQuote(row.createdAt || now)},
         ${sqlQuote(row.updatedAt || now)}
       );`
    );
  }

  for (const row of Array.isArray(snapshot.groups) ? snapshot.groups : []) {
    if (!row || !row.groupId) {
      continue;
    }
    saveGroup(
      String(row.groupId).trim().toLowerCase(),
      String(row.name || row.groupId),
      String(row.description || ""),
      Array.isArray(row.members) ? row.members : []
    );
  }

  for (const row of Array.isArray(snapshot.rules) ? snapshot.rules : []) {
    if (!row || !row.ruleId) {
      continue;
    }
    saveRule(
      String(row.ruleId).trim().toLowerCase(),
      String(row.name || row.ruleId),
      String(row.source || "frigate"),
      String(row.ruleType || "overlay"),
      row.enabled !== false,
      row.config || {}
    );
  }

  migrateScreensSchemaToViewOnly();
  resetVolatileRuntimeState();
  onlineByTarget.clear();
  connectMqttClient(true);
  connectHaStream(true);
  refreshImmichStatus().catch((err) => {
    immichCache.lastError = err.message || "Immich status refresh failed";
  });
  refreshFrigateStatus().catch((err) => {
    frigateCache.lastError = err.message || "Frigate status refresh failed";
  });
}

function maybeRunNightlyBackup(now = new Date()) {
  const slot = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (lastAutoBackupSlot === slot) {
    return;
  }
  if (now.getHours() !== 2 || now.getMinutes() !== 0) {
    return;
  }
  const snapshot = buildConfigSnapshot();
  writeBackupFile(snapshot, "nightly");
  lastAutoBackupSlot = slot;
}

function buildUniqueViewId(baseId) {
  const normalizedBase = String(baseId || "view")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "view";
  if (!getView(normalizedBase)) {
    return normalizedBase;
  }
  let index = 2;
  while (getView(`${normalizedBase}-${index}`)) {
    index += 1;
  }
  return `${normalizedBase}-${index}`;
}

function migrateScreensSchemaToViewOnly() {
  const screenColumns = sqliteQuery("PRAGMA table_info(screens);");
  const hasLegacyProfileId = screenColumns.some((col) => col.name === "profile_id");
  const hasLegacyThemeId = screenColumns.some((col) => col.name === "theme_id");
  const hasViewId = screenColumns.some((col) => col.name === "view_id");
  if (!hasLegacyProfileId && !hasLegacyThemeId) {
    return 0;
  }
  if (!hasViewId) {
    sqliteExec("ALTER TABLE screens ADD COLUMN view_id TEXT;");
  }

  const rows = sqliteQuery(
    `SELECT screen_id AS screenId,
            friendly_name AS friendlyName,
            view_id AS viewId,
            profile_id AS profileId,
            theme_id AS themeId
     FROM screens
     ORDER BY screen_id ASC;`
  );
  let migratedViewBindings = 0;
  for (const row of rows) {
    const existingViewId = String(row.viewId || "").trim().toLowerCase();
    if (existingViewId && getView(existingViewId)) {
      continue;
    }
    const legacyProfileId = String(row.profileId || "").trim().toLowerCase();
    const legacyThemeId = String(row.themeId || "").trim().toLowerCase();
    const viewId = buildUniqueViewId(`screen-${row.screenId}`);
    const viewName = row.friendlyName
      ? `${row.friendlyName} Default`
      : `${row.screenId} Default`;
    saveView(
      viewId,
      viewName,
      legacyProfileId && getProfile(legacyProfileId) ? legacyProfileId : null,
      legacyThemeId && getTheme(legacyThemeId) ? legacyThemeId : null
    );
    sqliteExec(
      `UPDATE screens
       SET view_id = ${sqlQuote(viewId)}
       WHERE screen_id = ${sqlQuote(row.screenId)};`
    );
    migratedViewBindings += 1;
  }

  sqliteExec("ALTER TABLE screens RENAME TO screens_legacy;");
  sqliteExec(`
    CREATE TABLE screens (
      screen_id TEXT PRIMARY KEY,
      device_id TEXT UNIQUE,
      friendly_name TEXT,
      view_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sqliteExec(`
    INSERT INTO screens (screen_id, device_id, friendly_name, view_id, created_at, updated_at)
    SELECT screen_id, device_id, friendly_name, view_id, created_at, updated_at
    FROM screens_legacy;
  `);
  sqliteExec("DROP TABLE screens_legacy;");

  if (migratedViewBindings > 0) {
    console.log(`[migration] created and assigned ${migratedViewBindings} view binding(s) from legacy screen profile/theme data`);
  }
  console.log("[migration] screens table migrated to view-only schema");
  return migratedViewBindings;
}

const SERVER_STATE_TOPIC = toTopic("server", "state", "online");
let mqttClient = null;

function setLwtState(client = mqttClient) {
  if (!client || !client.connected) {
    return;
  }
  client.publish(SERVER_STATE_TOPIC, JSON.stringify({ online: true }), {
    qos: 1,
    retain: true
  });
}

function attachMqttClientHandlers(client) {
  client.on("connect", () => {
    mqttState.connected = true;
    mqttState.lastError = null;
    const topics = [MQTT_SUBSCRIBE_PATTERN];
    const frigateTopic = getFrigateConfig().mqttTopic;
    if (frigateTopic) {
      topics.push(frigateTopic);
    }
    client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        mqttState.lastError = err.message;
        console.error("MQTT subscribe failed:", err.message);
        return;
      }
      console.log(`Subscribed to: ${topics.join(", ")}`);
    });
    setLwtState(client);
  });

  client.on("reconnect", () => {
    mqttState.connected = false;
  });

  client.on("offline", () => {
    mqttState.connected = false;
  });

  client.on("close", () => {
    mqttState.connected = false;
  });

  client.on("error", (err) => {
    mqttState.connected = false;
    mqttState.lastError = err.message || "unknown error";
    console.error("MQTT error:", err.message);
  });

  client.on("message", (topic, payloadBuffer, packet) => {
    const payload = payloadBuffer.toString("utf8");
    const parsed = safeJson(payload);
    const frigateTopic = getFrigateConfig().mqttTopic;

    if (frigateTopic && topic === frigateTopic) {
      const eventPayload = normalizeFrigateMqttEvent(parsed);
      if (!eventPayload) {
        return;
      }
      processFrigateEvent(eventPayload).catch((err) => {
        console.error("Frigate MQTT event processing failed:", err.message);
      });
      return;
    }

    const parts = topic.split("/");
    if (parts.length < 5) {
      return;
    }

    const target = parts[2];
    const channel = parts[3];
    const command = parts[4];

    if (channel === "cmd") {
      const message = {
        ts: new Date().toISOString(),
        target,
        command,
        payload: parsed,
        topic,
        retain: Boolean(packet?.retain)
      };

      broadcast(message);
    }
  });
}

function connectMqttClient(force = false) {
  const config = getMqttConfig();
  if (!config.url) {
    mqttState.connected = false;
    mqttState.lastError = "MQTT URL is not configured";
    if (mqttClient) {
      mqttClient.end(true);
      mqttClient = null;
    }
    return;
  }

  if (!force && mqttClient) {
    return;
  }

  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }

  mqttClient = mqtt.connect(config.url, {
    username: config.username || undefined,
    password: config.password || undefined,
    clientId: config.clientId,
    clean: true,
    reconnectPeriod: 3000,
    will: {
      topic: SERVER_STATE_TOPIC,
      payload: JSON.stringify({ online: false }),
      qos: 1,
      retain: true
    }
  });

  attachMqttClientHandlers(mqttClient);
}

wss.on("connection", (ws, req) => {
  const clientId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  ws._coreviewClientId = clientId;
  const remoteIp = getWsClientIp(req, ws);
  clients.set(clientId, { connectedAt: Date.now(), target: null, remoteIp });

  ws.send(
    JSON.stringify({
      type: "hello",
      clientId,
      now: new Date().toISOString(),
      topicRoot: MQTT_TOPIC_ROOT,
      subscribePattern: MQTT_SUBSCRIBE_PATTERN
    })
  );

  ws.on("message", (raw) => {
    const parsed = safeJson(String(raw));
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    if (parsed.type !== "client_status") {
      return;
    }
    const rawDeviceId = String(parsed.deviceId || "").trim().toLowerCase();
    const rawDeviceKey = String(parsed.deviceKey || "").trim().toLowerCase();
    if (!DEVICE_ID_PATTERN.test(rawDeviceId)) {
      return;
    }
    const deviceId = rawDeviceId;
    const userAgent = parsed.userAgent ? String(parsed.userAgent) : null;
    let deviceRecord = getDeviceRecord(deviceId);
    const hasValidDeviceKey = deviceKeyValid(rawDeviceKey);
    const deviceKeyHash = hasValidDeviceKey ? hashDeviceKey(rawDeviceKey) : null;
    if (!deviceRecord) {
      if (!hasValidDeviceKey) {
        return;
      }
      if (!allowWsNewDevice(remoteIp)) {
        return;
      }
      deviceRecord = ensureDeviceRecord(deviceId, {
        ip: remoteIp || null,
        userAgent,
        deviceKeyHash
      });
    } else {
      if (deviceRecord.deviceKeyHash) {
        if (!hasValidDeviceKey) {
          return;
        }
        if (!constantTimeHexEqual(deviceRecord.deviceKeyHash, deviceKeyHash)) {
          return;
        }
      } else if (!hasValidDeviceKey) {
        // Legacy compatibility path: allow already-known devices without deviceKey only if source IP matches.
        // This keeps existing displays visible as online until they refresh to the latest client.
        if (!deviceRecord.lastIp || String(deviceRecord.lastIp) !== String(remoteIp || "")) {
          return;
        }
      } else if (deviceRecord.assignedScreenId && deviceRecord.lastIp && String(deviceRecord.lastIp) !== String(remoteIp || "")) {
        // Do not allow first key enrollment for a registered device from a new source IP.
        return;
      }
      deviceRecord = ensureDeviceRecord(deviceId, {
        ip: remoteIp || null,
        userAgent,
        deviceKeyHash
      });
    }

    const claimedTarget = deviceRecord?.assignedScreenId || null;
    const target = claimedTarget;

    const now = Date.now();
    const currentClient = clients.get(clientId) || { connectedAt: now, target: null };
    const previousTarget = currentClient.target || null;
    if (previousTarget && previousTarget !== target) {
      const previousState = onlineByTarget.get(previousTarget);
      if (previousState && previousState.clientId === clientId) {
        onlineByTarget.set(previousTarget, {
          ...previousState,
          connected: false,
          disconnectedAt: now
        });
      }
    }
    currentClient.target = target || null;
    currentClient.lastSeen = now;
    currentClient.deviceId = deviceId || null;
    clients.set(clientId, currentClient);

    if (deviceRecord) {
      const nextScreenId = deviceRecord.assignedScreenId || null;
      const nextPairingCode = deviceRecord.pairingCode || null;
      const nextRegistered = Boolean(deviceRecord.registered);
      const nextMediaToken = nextScreenId ? getOrCreateMediaToken(nextScreenId) : null;
      const shouldSendProvisioning =
        !currentClient.provisioned ||
        currentClient.provisionedScreenId !== nextScreenId ||
        currentClient.provisionedPairingCode !== nextPairingCode ||
        currentClient.provisionedRegistered !== nextRegistered ||
        currentClient.provisionedMediaToken !== nextMediaToken;

      if (shouldSendProvisioning) {
        const runtime = nextScreenId
          ? getRuntimeStateForScreen(nextScreenId)
          : null;
        ws.send(JSON.stringify({
          type: "provisioning",
          registered: nextRegistered,
          deviceId: deviceRecord.deviceId,
          pairingCode: nextPairingCode,
          screenId: nextScreenId,
          runtime,
          mediaToken: nextMediaToken
        }));
        currentClient.provisioned = true;
        currentClient.provisionedScreenId = nextScreenId;
        currentClient.provisionedPairingCode = nextPairingCode;
        currentClient.provisionedRegistered = nextRegistered;
        currentClient.provisionedMediaToken = nextMediaToken;
        clients.set(clientId, currentClient);
      }
    }

    if (!target) {
      return;
    }

    const existing = onlineByTarget.get(target) || {};
    onlineByTarget.set(target, {
      ...existing,
      target,
      clientId,
      connected: true,
      connectedAt: existing.connectedAt || now,
      lastSeen: now,
      disconnectedAt: null,
      userAgent: userAgent || existing.userAgent || null
    });
  });

  ws.on("close", () => {
    ws._coreviewClientId = null;
    const existingClient = clients.get(clientId);
    if (existingClient?.target) {
      const target = existingClient.target;
      const current = onlineByTarget.get(target);
      if (current && current.clientId === clientId) {
        onlineByTarget.set(target, {
          ...current,
          connected: false,
          disconnectedAt: Date.now()
        });
      }
    }
    clients.delete(clientId);
  });
});

app.get("/health", (_req, res) => {
  res.json({
    version: APP_VERSION,
    status: "ok",
    uptime: process.uptime(),
    websocketClients: wss.clients.size
  });
});

app.get("/api/state", requireAdmin, (_req, res) => {
  const screenStates = getScreenStates();
  const pendingDevices = getPendingDevices();
  const knownTargets = Array.from(
    new Set([
      ...screenStates.map((item) => item.target),
      ...listScreens().map((item) => item.screenId)
    ])
  ).sort();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    mqttConnected: mqttState.connected,
    mqttLastError: mqttState.lastError,
    websocketClients: wss.clients.size,
    immichConfigured: immichConfigured(),
    immichReachable: immichCache.reachable,
    immichLastCheckedAt: immichCache.lastCheckedAt,
    immichLastError: immichCache.lastError,
    haConfigured: haConfigured(),
    haConnected: haConnected(),
    haEntityCount: haCache.entities.length,
    haLastSyncAt: haCache.lastSyncAt,
    haLastError: haCache.lastError,
    frigateConfigured: Boolean(getFrigateConfig().url),
    frigateReachable: frigateCache.reachable,
    frigateLastCheckedAt: frigateCache.lastCheckedAt,
    frigateLastError: frigateCache.lastError,
    knownTargets,
    banners: listBanners(),
    groups: listGroups(),
    profiles: listProfiles(),
    views: listViews(),
    themes: listThemes(),
    tickers: listTickers(),
    widgets: listWidgets(),
    rules: listRules(),
    screens: listScreens(),
    screenStates,
    pendingDevices
  });
});

app.get("/api/config/export", requireAdmin, (_req, res) => {
  const snapshot = buildConfigSnapshot();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(snapshot);
});

app.post("/api/config/import", requireAdmin, (req, res) => {
  const snapshot = req.body?.snapshot && typeof req.body.snapshot === "object"
    ? req.body.snapshot
    : req.body;
  try {
    importConfigSnapshot(snapshot);
    return res.json({
      imported: true,
      summary: {
        settings: Array.isArray(snapshot.settings) ? snapshot.settings.length : 0,
        devices: Array.isArray(snapshot.devices) ? snapshot.devices.length : 0,
        screens: Array.isArray(snapshot.screens) ? snapshot.screens.length : 0,
        profiles: Array.isArray(snapshot.profiles) ? snapshot.profiles.length : 0,
        views: Array.isArray(snapshot.views) ? snapshot.views.length : 0,
        themes: Array.isArray(snapshot.themes) ? snapshot.themes.length : 0,
        banners: Array.isArray(snapshot.banners) ? snapshot.banners.length : 0,
        tickers: Array.isArray(snapshot.tickers) ? snapshot.tickers.length : 0,
        widgets: Array.isArray(snapshot.widgets) ? snapshot.widgets.length : 0,
        groups: Array.isArray(snapshot.groups) ? snapshot.groups.length : 0,
        rules: Array.isArray(snapshot.rules) ? snapshot.rules.length : 0
      }
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "config import failed" });
  }
});

app.get("/api/backups", requireAdmin, (_req, res) => {
  return res.json({
    backups: listBackupFiles(),
    backupDir: BACKUP_DIR
  });
});

app.post("/api/backups/run", requireAdmin, (_req, res) => {
  const snapshot = buildConfigSnapshot();
  const backup = writeBackupFile(snapshot, "manual");
  return res.json({
    created: true,
    backup
  });
});

app.get("/api/ha/entities", requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const domain = String(req.query.domain || "").trim().toLowerCase();
  let items = haCache.entities;
  if (domain) {
    items = items.filter((item) => item.domain === domain);
  }
  if (q) {
    items = items.filter((item) => {
      const haystack = [
        item.entityId,
        item.friendlyName,
        item.state,
        item.unit,
        item.deviceClass
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }
  return res.json({
    configured: haConfigured(),
    lastSyncAt: haCache.lastSyncAt,
    lastError: haCache.lastError,
    count: items.length,
    entities: items
  });
});

app.get("/api/ha/entities/:entityId", requireAdmin, (req, res) => {
  const entityId = String(req.params.entityId || "");
  const item = haCache.entities.find((entry) => entry.entityId === entityId);
  if (!item) {
    return res.status(404).json({ error: "entity not found" });
  }
  return res.json(item);
});

function integrationStatusPayload() {
  const ha = getHaConfig();
  const immich = getImmichConfig();
  const frigate = getFrigateConfig();
  const mqttConfig = getMqttConfig();
  const eventWebhook = getEventWebhookConfig();
  return {
    ha: {
      configured: Boolean(ha.url && ha.token),
      url: ha.url || "",
      tokenStatus: maskSecret(ha.token),
      connected: haConnected(),
      entityCount: haCache.entities.length,
      lastSyncAt: haCache.lastSyncAt,
      lastError: haCache.lastError
    },
    immich: {
      configured: Boolean(immich.url && immich.apiKey),
      url: immich.url || "",
      apiKeyStatus: maskSecret(immich.apiKey),
      albumId: immich.albumId || "",
      connected: Boolean(immich.url && immich.apiKey) && immichCache.reachable,
      lastCheckedAt: immichCache.lastCheckedAt,
      lastError: immichCache.lastError,
      version: immichCache.version
    },
    frigate: {
      configured: Boolean(frigate.url),
      url: frigate.url || "",
      mqttTopic: frigate.mqttTopic || "",
      cameras: Array.isArray(frigateCache.cameras) ? frigateCache.cameras : [],
      reachable: Boolean(frigate.url) && frigateCache.reachable,
      lastCheckedAt: frigateCache.lastCheckedAt,
      lastError: frigateCache.lastError,
      version: frigateCache.version
    },
    mqtt: {
      configured: Boolean(mqttConfig.url),
      url: mqttConfig.url || "",
      username: mqttConfig.username || "",
      usernameStatus: maskSecret(mqttConfig.username),
      passwordStatus: maskSecret(mqttConfig.password),
      connected: mqttState.connected,
      lastError: mqttState.lastError
    },
    eventWebhook: {
      configured: Boolean(eventWebhook.token),
      tokenStatus: maskSecret(eventWebhook.token),
      endpoint: "/api/events/frigate"
    }
  };
}

app.get("/api/setup/status", (req, res) => {
  const authenticated = isAuthenticated(req);
  const needsSetup = !adminConfigured();
  return res.json({
    version: APP_VERSION,
    needsSetup,
    authenticated,
    bootstrapRequired: needsSetup && Boolean(getBootstrapToken()),
    integrations: authenticated ? integrationStatusPayload() : null
  });
});

app.post("/api/setup/bootstrap", async (req, res) => {
  if (adminConfigured()) {
    return res.status(409).json({ error: "setup already completed" });
  }
  const bootstrapToken = String(req.body?.bootstrapToken || req.headers["x-bootstrap-token"] || "").trim();
  if (!bootstrapTokenValid(bootstrapToken)) {
    return res.status(403).json({ error: "invalid bootstrap token" });
  }
  const password = String(req.body?.password || "");
  const haUrl = String(req.body?.haUrl || "").trim();
  const haToken = String(req.body?.haToken || "").trim();
  const immichUrl = String(req.body?.immichUrl || "").trim();
  const immichApiKey = String(req.body?.immichApiKey || "").trim();
  const immichAlbumId = String(req.body?.immichAlbumId || "").trim();
  const frigateUrl = String(req.body?.frigateUrl || "").trim();
  const frigateMqttTopic = String(req.body?.frigateMqttTopic || "").trim();
  const mqttUrl = String(req.body?.mqttUrl || "").trim();
  const mqttUsername = String(req.body?.mqttUsername || "").trim();
  const mqttPassword = String(req.body?.mqttPassword || "").trim();

  const passwordError = passwordPolicyError(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  setSetting("admin_password_hash", hashPassword(password), true);
  setSetting("session_secret", crypto.randomBytes(32).toString("hex"), true);
  setSetting("event_webhook_token", crypto.randomBytes(24).toString("hex"), true);
  setSetting("bootstrap_token", "", true);
  if (haUrl) {
    setSetting("ha_url", haUrl);
  }
  if (haToken) {
    setSetting("ha_token", haToken, true);
  }
  if (immichUrl) {
    setSetting("immich_url", immichUrl);
  }
  if (immichApiKey) {
    setSetting("immich_api_key", immichApiKey, true);
  }
  if (immichAlbumId) {
    setSetting("immich_album_id", immichAlbumId);
  }
  if (frigateUrl) {
    setSetting("frigate_url", frigateUrl);
  }
  setSetting("frigate_mqtt_topic", frigateMqttTopic || "frigate/events");
  if (mqttUrl) {
    setSetting("mqtt_url", mqttUrl);
  }
  if (mqttUsername) {
    setSetting("mqtt_username", mqttUsername);
  }
  if (mqttPassword) {
    setSetting("mqtt_password", mqttPassword, true);
  }

  await refreshHaEntities();
  connectHaStream(true);
  await refreshImmichStatus();
  await refreshFrigateStatus();
  connectMqttClient(true);
  const token = createSessionToken();
  if (token) {
    setSessionCookie(req, res, token);
  }
  return res.json({
    bootstrapped: true,
    integrations: integrationStatusPayload()
  });
});

app.post("/api/auth/login", async (req, res) => {
  const password = String(req.body?.password || "");
  const ip = getClientIp(req);
  const status = loginAttemptStatus(ip);
  if (!status.allowed) {
    if (status.retryAfterSec) {
      res.setHeader("Retry-After", String(status.retryAfterSec));
    }
    return res.status(429).json({ error: "too many login attempts" });
  }
  const stored = getSetting("admin_password_hash");
  const ok = await verifyPasswordAsync(password, stored);
  if (!ok) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: "invalid password" });
  }
  clearLoginFailures(ip);
  const token = createSessionToken();
  if (!token) {
    return res.status(500).json({ error: "session configuration missing" });
  }
  setSessionCookie(req, res, token);
  return res.json({ authenticated: true });
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(req, res);
  return res.json({ authenticated: false });
});

app.get("/api/settings/integrations", requireAdmin, (req, res) => {
  return res.json({
    authenticated: true,
    integrations: integrationStatusPayload()
  });
});

app.post("/api/settings/event-webhook/rotate", requireAdmin, (req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  setSetting("event_webhook_token", token, true);
  return res.json({
    rotated: true,
    token,
    integrations: integrationStatusPayload()
  });
});

app.get("/api/profiles", requireAdmin, (_req, res) => {
  return res.json({
    profiles: listProfiles()
  });
});

app.get("/api/profiles/:profileId", requireAdmin, (req, res) => {
  const profileId = String(req.params.profileId || "").trim();
  const profile = getProfile(profileId);
  if (!profile) {
    return res.status(404).json({ error: "profile not found" });
  }
  return res.json({ profile });
});

app.get("/api/views", requireAdmin, (_req, res) => {
  return res.json({
    views: listViews()
  });
});

app.get("/api/views/:viewId", requireAdmin, (req, res) => {
  const viewId = String(req.params.viewId || "").trim().toLowerCase();
  const view = getView(viewId);
  if (!view) {
    return res.status(404).json({ error: "view not found" });
  }
  return res.json({ view });
});

app.get("/api/themes", requireAdmin, (_req, res) => {
  return res.json({
    themes: listThemes()
  });
});

app.get("/api/themes/:themeId", requireAdmin, (req, res) => {
  const themeId = String(req.params.themeId || "").trim();
  const theme = getTheme(themeId);
  if (!theme) {
    return res.status(404).json({ error: "theme not found" });
  }
  return res.json({ theme });
});

app.get("/api/banners", requireAdmin, (_req, res) => {
  return res.json({
    banners: listBanners()
  });
});

app.get("/api/tickers", requireAdmin, (_req, res) => {
  return res.json({
    tickers: listTickers()
  });
});

app.get("/api/widgets", requireAdmin, (_req, res) => {
  return res.json({
    widgets: listWidgets()
  });
});

app.get("/api/screens", requireAdmin, (_req, res) => {
  return res.json({
    screens: listScreens()
  });
});

app.get("/api/screens/:screenId/runtime", requireAdmin, (req, res) => {
  const screenId = String(req.params.screenId || "").trim().toLowerCase();
  const runtime = getRuntimeStateForScreen(screenId);
  if (!runtime) {
    return res.status(404).json({ error: "screen not found" });
  }
  return res.json(runtime);
});

app.get("/api/views/:viewId/runtime", (req, res) => {
  const viewId = String(req.params.viewId || "").trim().toLowerCase();
  if (!viewId || !/^[a-z0-9_-]+$/.test(viewId)) {
    return res.status(400).json({ error: "invalid view id" });
  }
  if (!viewRequestAuthorized(req, viewId)) {
    return res.status(401).json({ error: "view authentication required" });
  }
  const runtime = getRuntimeStateForView(viewId);
  if (!runtime) {
    return res.status(404).json({ error: "view not found" });
  }
  const mediaScope = `view:${viewId}`;
  const mediaToken = getOrCreateMediaToken(mediaScope);
  return res.json({
    runtime,
    mediaToken,
    mediaScope
  });
});

app.get("/api/groups", requireAdmin, (_req, res) => {
  return res.json({
    groups: listGroups()
  });
});

app.get("/api/rules", requireAdmin, (_req, res) => {
  return res.json({
    rules: listRules()
  });
});

app.post("/api/profiles", requireAdmin, (req, res) => {
  const profileId = String(req.body?.profileId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const template = String(req.body?.template || "clock").trim();
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};

  if (!profileId || !/^[a-z0-9_-]+$/.test(profileId)) {
    return res.status(400).json({ error: "profileId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!["clock", "photo_slideshow", "custom", "map"].includes(template)) {
    return res.status(400).json({ error: "unsupported template" });
  }
  if (config.bannerId && !getBanner(String(config.bannerId).trim().toLowerCase())) {
    return res.status(400).json({ error: "unknown bannerId" });
  }
  if (config.tickerId && !getTicker(String(config.tickerId).trim().toLowerCase())) {
    return res.status(400).json({ error: "unknown tickerId" });
  }
  if (template === "custom") {
    const widgetIds = (Array.isArray(config.widgetIds) ? config.widgetIds : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 4);
    for (const widgetId of widgetIds) {
      if (!getWidget(widgetId)) {
        return res.status(400).json({ error: `unknown widgetId: ${widgetId}` });
      }
    }
  }

  const profile = saveProfile(profileId, name, template, config);
  for (const screen of listScreensForProfile(profile.profileId)) {
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: getRuntimeStateForScreen(screen.screenId)
    });
  }
  return res.json({
    saved: true,
    profile
  });
});

app.post("/api/views", requireAdmin, (req, res) => {
  const viewId = String(req.body?.viewId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const profileId = String(req.body?.profileId || "").trim().toLowerCase();
  const themeId = String(req.body?.themeId || "").trim().toLowerCase();
  if (!viewId || !/^[a-z0-9_-]+$/.test(viewId)) {
    return res.status(400).json({ error: "viewId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (profileId && !getProfile(profileId)) {
    return res.status(404).json({ error: "profile not found" });
  }
  if (themeId && !getTheme(themeId)) {
    return res.status(404).json({ error: "theme not found" });
  }
  const view = saveView(viewId, name, profileId || null, themeId || null);
  for (const screen of listScreensForView(view.viewId)) {
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: getRuntimeStateForScreen(screen.screenId)
    });
  }
  return res.json({ saved: true, view });
});

app.post("/api/views/:viewId/publish", requireAdmin, (req, res) => {
  const viewId = String(req.params.viewId || "").trim().toLowerCase();
  if (!viewId || !/^[a-z0-9_-]+$/.test(viewId)) {
    return res.status(400).json({ error: "invalid view id" });
  }
  const view = getView(viewId);
  if (!view) {
    return res.status(404).json({ error: "view not found" });
  }
  const expiresInDaysRaw = Number(req.body?.expiresInDays);
  const expiresInDays = Number.isFinite(expiresInDaysRaw) ? Math.max(1, Math.min(365, Math.round(expiresInDaysRaw))) : 30;
  const expiresAt = Date.now() + expiresInDays * 24 * 60 * 60 * 1000;
  const token = createViewAccessToken(viewId, expiresAt);
  if (!token) {
    return res.status(500).json({ error: "failed to generate view token" });
  }
  const proto = TRUST_PROXY
    ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || req.protocol || "http"
    : (req.protocol || "http");
  const host = TRUST_PROXY
    ? String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim()
    : String(req.headers.host || "");
  const pathPart = `/v/${encodeURIComponent(viewId)}?vt=${encodeURIComponent(token)}`;
  const url = host ? `${proto}://${host}${pathPart}` : pathPart;
  return res.json({
    published: true,
    viewId,
    expiresAt: new Date(expiresAt).toISOString(),
    token,
    path: pathPart,
    url
  });
});

app.post("/api/themes", requireAdmin, (req, res) => {
  const themeId = String(req.body?.themeId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};

  if (!themeId || !/^[a-z0-9_-]+$/.test(themeId)) {
    return res.status(400).json({ error: "themeId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const theme = saveTheme(themeId, name, config);
  for (const screen of listScreensForTheme(theme.themeId)) {
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: getRuntimeStateForScreen(screen.screenId)
    });
  }
  return res.json({
    saved: true,
    theme
  });
});

app.post("/api/banners", requireAdmin, (req, res) => {
  const bannerId = String(req.body?.bannerId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};

  if (!bannerId || !/^[a-z0-9_-]+$/.test(bannerId)) {
    return res.status(400).json({ error: "bannerId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const banner = saveBanner(bannerId, name, config);
  for (const screen of listScreens()) {
    const runtime = getRuntimeStateForScreen(screen.screenId);
    if (runtime?.profile?.config?.bannerId === banner.bannerId) {
      broadcast({
        type: "screen_runtime",
        target: screen.screenId,
        command: "screen_runtime",
        payload: runtime
      });
    }
  }
  return res.json({
    saved: true,
    banner
  });
});

app.post("/api/tickers", requireAdmin, (req, res) => {
  const tickerId = String(req.body?.tickerId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};

  if (!tickerId || !/^[a-z0-9_-]+$/.test(tickerId)) {
    return res.status(400).json({ error: "tickerId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const ticker = saveTicker(tickerId, name, config);
  for (const screen of listScreens()) {
    const runtime = getRuntimeStateForScreen(screen.screenId);
    if (runtime?.profile?.config?.tickerId === ticker.tickerId) {
      broadcast({
        type: "screen_runtime",
        target: screen.screenId,
        command: "screen_runtime",
        payload: runtime
      });
    }
  }
  return res.json({
    saved: true,
    ticker
  });
});

app.post("/api/widgets", requireAdmin, (req, res) => {
  const widgetId = String(req.body?.widgetId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};

  if (!widgetId || !/^[a-z0-9_-]+$/.test(widgetId)) {
    return res.status(400).json({ error: "widgetId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const widget = saveWidget(widgetId, name, config);
  for (const screen of listScreens()) {
    const runtime = getRuntimeStateForScreen(screen.screenId);
    const profile = runtime?.profile || null;
    if (!profileUsesWidget(profile, widget.widgetId)) {
      continue;
    }
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: runtime
    });
  }
  return res.json({
    saved: true,
    widget
  });
});

app.delete("/api/profiles/:profileId", requireAdmin, (req, res) => {
  const profileId = String(req.params.profileId || "").trim();
  const profile = getProfile(profileId);
  if (!profile) {
    return res.status(404).json({ error: "profile not found" });
  }
  const impactedScreens = listScreensForProfile(profileId);
  clearProfileAssignments(profileId);
  deleteProfile(profileId);
  for (const screen of impactedScreens) {
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: getRuntimeStateForScreen(screen.screenId)
    });
  }
  return res.json({
    deleted: true,
    profileId
  });
});

app.delete("/api/themes/:themeId", requireAdmin, (req, res) => {
  const themeId = String(req.params.themeId || "").trim();
  const theme = getTheme(themeId);
  if (!theme) {
    return res.status(404).json({ error: "theme not found" });
  }
  const impactedScreens = listScreensForTheme(themeId);
  clearThemeAssignments(themeId);
  deleteTheme(themeId);
  for (const screen of impactedScreens) {
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: getRuntimeStateForScreen(screen.screenId)
    });
  }
  return res.json({
    deleted: true,
    themeId
  });
});

app.delete("/api/banners/:bannerId", requireAdmin, (req, res) => {
  const bannerId = String(req.params.bannerId || "").trim();
  const banner = getBanner(bannerId);
  if (!banner) {
    return res.status(404).json({ error: "banner not found" });
  }
  deleteBanner(bannerId);
  for (const screen of listScreens()) {
    const runtime = getRuntimeStateForScreen(screen.screenId);
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: runtime
    });
  }
  return res.json({
    deleted: true,
    bannerId
  });
});

app.delete("/api/tickers/:tickerId", requireAdmin, (req, res) => {
  const tickerId = String(req.params.tickerId || "").trim();
  const ticker = getTicker(tickerId);
  if (!ticker) {
    return res.status(404).json({ error: "ticker not found" });
  }
  deleteTicker(tickerId);
  for (const screen of listScreens()) {
    const runtime = getRuntimeStateForScreen(screen.screenId);
    broadcast({
      type: "screen_runtime",
      target: screen.screenId,
      command: "screen_runtime",
      payload: runtime
    });
  }
  return res.json({
    deleted: true,
    tickerId
  });
});

app.delete("/api/widgets/:widgetId", requireAdmin, (req, res) => {
  const widgetId = String(req.params.widgetId || "").trim().toLowerCase();
  const widget = getWidget(widgetId);
  if (!widget) {
    return res.status(404).json({ error: "widget not found" });
  }
  const profileRefs = listProfiles()
    .filter((profile) => profileUsesWidget(profile, widgetId))
    .map((profile) => profile.profileId);
  const ruleRefs = listRules()
    .filter((rule) => rule.ruleType === "widget" && rule.config.widgetId === widgetId)
    .map((rule) => rule.ruleId);
  if (profileRefs.length > 0 || ruleRefs.length > 0) {
    return res.status(409).json({
      error: "widget is still in use",
      profileRefs,
      ruleRefs
    });
  }
  deleteWidget(widgetId);
  return res.json({
    deleted: true,
    widgetId
  });
});

app.delete("/api/views/:viewId", requireAdmin, (req, res) => {
  const viewId = String(req.params.viewId || "").trim().toLowerCase();
  const view = getView(viewId);
  if (!view) {
    return res.status(404).json({ error: "view not found" });
  }
  const assignedScreens = listScreensForView(viewId).map((item) => item.screenId);
  if (assignedScreens.length > 0) {
    return res.status(409).json({ error: "view is still assigned to screens", screenRefs: assignedScreens });
  }
  deleteView(viewId);
  return res.json({
    deleted: true,
    viewId
  });
});

app.post("/api/groups", requireAdmin, (req, res) => {
  const groupId = String(req.body?.groupId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const description = String(req.body?.description || "").trim();
  const members = Array.isArray(req.body?.members) ? req.body.members : [];

  if (!groupId || !/^[a-z0-9_-]+$/.test(groupId)) {
    return res.status(400).json({ error: "groupId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  for (const member of members) {
    if (!getScreenRecord(String(member || "").trim().toLowerCase())) {
      return res.status(400).json({ error: `unknown screen in members: ${member}` });
    }
  }

  return res.json({
    saved: true,
    group: saveGroup(groupId, name, description, members)
  });
});

app.delete("/api/groups/:groupId", requireAdmin, (req, res) => {
  const groupId = String(req.params.groupId || "").trim().toLowerCase();
  if (!getGroupRecord(groupId)) {
    return res.status(404).json({ error: "group not found" });
  }
  deleteGroup(groupId);
  return res.json({
    deleted: true,
    groupId
  });
});

app.post("/api/rules", requireAdmin, (req, res) => {
  const ruleId = String(req.body?.ruleId || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const source = String(req.body?.source || "frigate").trim().toLowerCase();
  const ruleType = String(req.body?.ruleType || "overlay").trim().toLowerCase();
  const enabled = req.body?.enabled !== false;
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};

  if (!ruleId || !/^[a-z0-9_-]+$/.test(ruleId)) {
    return res.status(400).json({ error: "ruleId must use lowercase letters, numbers, dashes, or underscores" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!["frigate", "home_assistant", "schedule"].includes(source)) {
    return res.status(400).json({ error: "unsupported source" });
  }
  if (!["overlay", "theme", "profile", "banner", "ticker", "widget"].includes(ruleType)) {
    return res.status(400).json({ error: "unsupported rule type" });
  }
  if (source === "frigate" && !["overlay", "theme", "banner", "ticker", "widget"].includes(ruleType)) {
    return res.status(400).json({ error: "Frigate rules support overlay, theme, banner, ticker, or widget actions only" });
  }
  if (source === "home_assistant" && !["theme", "profile", "banner", "ticker", "widget"].includes(ruleType)) {
    return res.status(400).json({ error: "Home Assistant rules support theme, profile, banner, ticker, or widget actions only" });
  }
  if (source === "schedule" && !["theme", "profile", "banner", "ticker", "widget"].includes(ruleType)) {
    return res.status(400).json({ error: "Scheduled rules support theme, profile, banner, ticker, or widget actions only" });
  }
  const normalized = normalizeRuleConfig(config);
  if (normalized.targets.length === 0) {
    return res.status(400).json({ error: "at least one target is required" });
  }
  if (source === "home_assistant") {
    if (!normalized.entityId) {
      return res.status(400).json({ error: "entityId is required for Home Assistant rules" });
    }
    if (!["equals", "not_equals", "contains", "above", "below"].includes(normalized.operator)) {
      return res.status(400).json({ error: "unsupported state operator" });
    }
  }
  if (source === "schedule") {
    if (!validTimeOfDay(normalized.timeOfDay)) {
      return res.status(400).json({ error: "timeOfDay must be in HH:MM format" });
    }
    const invalidDay = normalized.daysOfWeek.find((item) => !normalizeDayToken(item));
    if (invalidDay) {
      return res.status(400).json({ error: `invalid day token: ${invalidDay}` });
    }
  }
  if (ruleType === "theme") {
    if (!normalized.themeId) {
      return res.status(400).json({ error: "themeId is required for theme rules" });
    }
    if (!getTheme(normalized.themeId)) {
      return res.status(400).json({ error: `unknown theme: ${normalized.themeId}` });
    }
  }
  if (ruleType === "profile") {
    if (!normalized.profileId) {
      return res.status(400).json({ error: "profileId is required for profile rules" });
    }
    if (!getProfile(normalized.profileId)) {
      return res.status(400).json({ error: `unknown profile: ${normalized.profileId}` });
    }
  }
  if (ruleType === "banner") {
    if (!normalized.bannerId) {
      return res.status(400).json({ error: "bannerId is required for banner rules" });
    }
    if (!getBanner(normalized.bannerId)) {
      return res.status(400).json({ error: `unknown banner: ${normalized.bannerId}` });
    }
  }
  if (ruleType === "ticker") {
    if (!normalized.tickerId) {
      return res.status(400).json({ error: "tickerId is required for ticker rules" });
    }
    if (!getTicker(normalized.tickerId)) {
      return res.status(400).json({ error: `unknown ticker: ${normalized.tickerId}` });
    }
  }
  if (ruleType === "widget") {
    if (!Number.isInteger(normalized.widgetIndex) || normalized.widgetIndex < 0 || normalized.widgetIndex > 3) {
      return res.status(400).json({ error: "widgetIndex must be an integer from 0 to 3" });
    }
    if (!normalized.widgetId) {
      return res.status(400).json({ error: "widgetId is required for widget rules" });
    }
    if (!getWidget(normalized.widgetId)) {
      return res.status(400).json({ error: `unknown widget: ${normalized.widgetId}` });
    }
    const invalidWidgetTargets = normalized.targets.filter((target) => {
      const screens = resolveTargetScreens(target);
      if (screens.length === 0) {
        return true;
      }
      return screens.some((screenId) => {
        const runtime = getRuntimeStateForScreen(screenId);
        return runtime?.layout?.template !== "custom";
      });
    });
    if (invalidWidgetTargets.length > 0) {
      return res.status(400).json({
        error: `widget rules require custom-layout targets only: ${invalidWidgetTargets.join(", ")}`
      });
    }
  }
  for (const target of normalized.targets) {
    const resolved = resolveTargetScreens(target);
    if (resolved.length === 0) {
      return res.status(400).json({ error: `rule target does not resolve: ${target}` });
    }
  }

  return res.json({
    saved: true,
    rule: saveRule(ruleId, name, source, ruleType, enabled, normalized)
  });
});

app.delete("/api/rules/:ruleId", requireAdmin, (req, res) => {
  const ruleId = String(req.params.ruleId || "").trim().toLowerCase();
  if (!getRule(ruleId)) {
    return res.status(404).json({ error: "rule not found" });
  }
  deleteRule(ruleId);
  return res.json({
    deleted: true,
    ruleId
  });
});

app.post("/api/rules/:ruleId/run", requireAdmin, async (req, res) => {
  const ruleId = String(req.params.ruleId || "").trim().toLowerCase();
  const rule = getRule(ruleId);
  if (!rule) {
    return res.status(404).json({ error: "rule not found" });
  }
  try {
    const result = await runRuleNow(rule);
    if (!result.applied) {
      return res.status(400).json({ error: result.reason || "rule could not be applied" });
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || "failed to run rule" });
  }
});

app.post("/api/events/frigate", requireEventWebhookAuth, async (req, res) => {
  try {
    const result = await processFrigateEvent(req.body || {});
    return res.json({
      accepted: true,
      ...result
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "frigate event processing failed" });
  }
});

app.post("/api/events/frigate/test", requireAdmin, async (req, res) => {
  try {
    const result = await processFrigateEvent(req.body || {});
    return res.json({
      accepted: true,
      ...result
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "frigate test event processing failed" });
  }
});

app.get("/api/frigate/cameras/:camera/snapshot", requireMediaAuth, async (req, res) => {
  const mode = String(req.query?.mode || "auto").trim().toLowerCase();
  return proxyFrigateSnapshot(
    String(req.params.camera || "").trim(),
    res,
    mode === "still" ? "still" : "auto"
  );
});

app.post("/api/screens/register", requireAdmin, (req, res) => {
  const pairingCode = String(req.body?.pairingCode || "").trim().toUpperCase();
  const screenId = String(req.body?.screenId || "").trim().toLowerCase();
  const friendlyName = String(req.body?.friendlyName || screenId).trim();
  const viewId = String(req.body?.viewId || "").trim().toLowerCase();
  if (!pairingCode || !screenId) {
    return res.status(400).json({ error: "pairingCode and screenId are required" });
  }
  if (!viewId) {
    return res.status(400).json({ error: "viewId is required" });
  }
  if (!getView(viewId)) {
    return res.status(404).json({ error: "view not found" });
  }
  const record = registerDeviceToScreen(pairingCode, screenId, friendlyName, viewId);
  if (!record) {
    return res.status(404).json({ error: "pairing code not found" });
  }
  const runtime = getRuntimeStateForScreen(record.assignedScreenId);
  broadcast({
    type: "screen_runtime",
    target: record.assignedScreenId,
    command: "screen_runtime",
    payload: runtime
  });
  return res.json({
    registered: true,
    deviceId: record.deviceId,
    screenId: record.assignedScreenId,
    pairingCode: record.pairingCode,
    runtime
  });
});

app.post("/api/screens/:screenId/rebind", requireAdmin, (req, res) => {
  const screenId = String(req.params.screenId || "").trim().toLowerCase();
  const pairingCode = String(req.body?.pairingCode || "").trim().toUpperCase();
  if (!screenId || !pairingCode) {
    return res.status(400).json({ error: "screenId and pairingCode are required" });
  }
  const result = rebindScreenToPairingCode(screenId, pairingCode);
  if (result.error === "screen_not_found") {
    return res.status(404).json({ error: "screen not found" });
  }
  if (result.error === "pairing_code_not_found") {
    return res.status(404).json({ error: "pairing code not found" });
  }
  if (result.error === "device_assigned_to_other_screen") {
    return res.status(409).json({ error: `pairing code is assigned to ${result.assignedScreenId}` });
  }
  if (result.error === "device_bound_to_other_screen") {
    return res.status(409).json({ error: `device is already bound to ${result.boundScreenId}` });
  }

  const runtime = getRuntimeStateForScreen(screenId);
  broadcast({
    type: "screen_runtime",
    target: screenId,
    command: "screen_runtime",
    payload: runtime
  });
  return res.json({
    saved: true,
    screen: result.screen,
    device: result.device,
    runtime
  });
});

app.post("/api/screens/:screenId", requireAdmin, (req, res) => {
  const screenId = String(req.params.screenId || "").trim().toLowerCase();
  const screen = getScreenRecord(screenId);
  if (!screen) {
    return res.status(404).json({ error: "screen not found" });
  }
  const friendlyName = String(req.body?.friendlyName === undefined ? screen.friendlyName : req.body.friendlyName).trim();
  const viewId = String(req.body?.viewId || "").trim().toLowerCase();
  if (!viewId) {
    return res.status(400).json({ error: "viewId is required" });
  }
  if (!getView(viewId)) {
    return res.status(404).json({ error: "view not found" });
  }
  const updated = updateScreenRecord(screenId, {
    friendlyName,
    viewId
  });
  const runtime = getRuntimeStateForScreen(screenId);
  broadcast({
    type: "screen_runtime",
    target: screenId,
    command: "screen_runtime",
    payload: runtime
  });
  return res.json({
    saved: true,
    screen: updated,
    runtime
  });
});

app.delete("/api/screens/:screenId", requireAdmin, (req, res) => {
  const screenId = String(req.params.screenId || "").trim().toLowerCase();
  const removed = unregisterScreen(screenId);
  if (!removed) {
    return res.status(404).json({ error: "screen not found" });
  }
  broadcast({
    type: "screen_removed",
    target: screenId,
    payload: {
      pairingCode: removed.pairingCode || null
    }
  });
  return res.json({
    deleted: true,
    screen: {
      screenId: removed.screenId,
      deviceId: removed.deviceId,
      pairingCode: removed.pairingCode || null
    }
  });
});

app.post("/api/settings/integrations", requireAdmin, async (req, res) => {
  const haUrl = String(req.body?.haUrl || "").trim();
  const haToken = String(req.body?.haToken || "").trim();
  const immichUrl = String(req.body?.immichUrl || "").trim();
  const immichApiKey = String(req.body?.immichApiKey || "").trim();
  const immichAlbumId = String(req.body?.immichAlbumId || "").trim();
  const frigateUrl = String(req.body?.frigateUrl || "").trim();
  const frigateMqttTopic = String(req.body?.frigateMqttTopic || "").trim();
  const mqttUrl = String(req.body?.mqttUrl || "").trim();
  const mqttUsername = String(req.body?.mqttUsername || "").trim();
  const mqttPassword = String(req.body?.mqttPassword || "").trim();

  setSetting("ha_url", haUrl);
  if (haToken) {
    setSetting("ha_token", haToken, true);
  }
  setSetting("immich_url", immichUrl);
  if (immichApiKey) {
    setSetting("immich_api_key", immichApiKey, true);
  }
  setSetting("immich_album_id", immichAlbumId);
  setSetting("frigate_url", frigateUrl);
  setSetting("frigate_mqtt_topic", frigateMqttTopic || "frigate/events");
  setSetting("mqtt_url", mqttUrl);
  setSetting("mqtt_username", mqttUsername);
  if (mqttPassword) {
    setSetting("mqtt_password", mqttPassword, true);
  }

  await refreshHaEntities();
  connectHaStream(true);
  await refreshImmichStatus();
  await refreshFrigateStatus();
  connectMqttClient(true);
  return res.json({
    saved: true,
    integrations: integrationStatusPayload()
  });
});

async function handleImmichAlbumAssets(albumId, res) {
  if (!immichConfigured()) {
    return res.status(503).json({ error: "Immich is not configured" });
  }

  const immich = getImmichConfig();
  const resolvedAlbumId = albumId || immich.albumId;
  if (!resolvedAlbumId) {
    return res.status(400).json({ error: "album id is required" });
  }

  try {
    const upstream = await immichFetch(`/api/albums/${encodeURIComponent(resolvedAlbumId)}`);
    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: body || "Immich album lookup failed" });
    }

    const album = await upstream.json();
    const assets = Array.isArray(album.assets) ? album.assets : [];
    const normalized = assets.map((asset) => ({
      // Keep useful exif/location context for signage captions.
      id: asset.id,
      type: asset.type,
      createdAt: asset.fileCreatedAt || asset.createdAt || null,
      width: asset.exifInfo?.exifImageWidth || null,
      height: asset.exifInfo?.exifImageHeight || null,
      city: asset.exifInfo?.city || null,
      state: asset.exifInfo?.state || null,
      country: asset.exifInfo?.country || null,
      description: asset.exifInfo?.description || asset.description || null,
      make: asset.exifInfo?.make || null,
      model: asset.exifInfo?.model || null,
      lensModel: asset.exifInfo?.lensModel || null,
      url: `/api/immich/asset/${asset.id}/original`
    }));

    return res.json({
      albumId: resolvedAlbumId,
      count: normalized.length,
      assets: normalized
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Immich request failed" });
  }
}

app.get("/api/immich/album/default/assets", requireMediaAuth, async (_req, res) => {
  return handleImmichAlbumAssets(getImmichConfig().albumId, res);
});

app.get("/api/immich/album/:albumId/assets", requireMediaAuth, async (req, res) => {
  return handleImmichAlbumAssets(req.params.albumId, res);
});

app.get("/api/immich/asset/:assetId/original", requireMediaAuth, async (req, res) => {
  if (!immichConfigured()) {
    return res.status(503).json({ error: "Immich is not configured" });
  }

  const assetId = req.params.assetId;
  if (!assetId) {
    return res.status(400).json({ error: "asset id is required" });
  }

  try {
    const immich = getImmichConfig();
    const upstream = await fetch(`${immich.url}/api/assets/${encodeURIComponent(assetId)}/original`, {
      headers: {
        "x-api-key": immich.apiKey
      }
    });

    if (!upstream.ok || !upstream.body) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: body || "Immich asset fetch failed" });
    }

    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    const cacheControl = upstream.headers.get("cache-control") || "public, max-age=300";

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Cache-Control", cacheControl);
    const bodyStream = Readable.fromWeb(upstream.body);
    bodyStream.on("error", () => {
      try {
        if (!res.writableEnded) {
          res.end();
        }
      } catch (_err) {
        // Ignore stream teardown races.
      }
    });
    res.on("close", () => {
      try {
        bodyStream.destroy();
      } catch (_err) {
        // Ignore stream teardown races.
      }
    });
    bodyStream.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Immich proxy failed" });
  }
});

app.post("/api/publish", requireAdmin, async (req, res) => {
  const { target, command, payload, retain = false, qos = 1 } = req.body || {};
  if (!target || !command) {
    return res.status(400).json({ error: "target and command are required" });
  }
  const targets = resolveTargetScreens(String(target));
  if (targets.length === 0) {
    return res.status(404).json({ error: "target does not resolve to any registered screens" });
  }
  try {
    const result = await publishCommandToResolvedTargets(targets, String(command), payload, { retain, qos });
    return res.json({
      published: true,
      target,
      resolvedTargets: result.resolvedTargets,
      topics: result.topics,
      qos: result.qos,
      retain: result.retain
    });
  } catch (err) {
    const status = String(err.message || "").includes("not connected") ? 503 : 500;
    return res.status(status).json({ error: err.message });
  }
});

app.post("/api/overrides", requireAdmin, (req, res) => {
  const target = String(req.body?.target || "").trim();
  const type = String(req.body?.type || "").trim().toLowerCase();
  const resourceId = String(req.body?.resourceId || "").trim().toLowerCase();
  const rawDuration = req.body?.duration;
  const duration = rawDuration === "" || rawDuration === null || rawDuration === undefined
    ? null
    : Number(rawDuration);
  const camera = String(req.body?.camera || "").trim();
  const label = String(req.body?.label || "").trim();
  const snapshot = String(req.body?.snapshot || "").trim();
  const widgetIndexRaw = req.body?.widgetIndex;
  const widgetIndexNumber = Number(widgetIndexRaw);
  const widgetIndex = Number.isInteger(widgetIndexNumber) ? widgetIndexNumber : null;

  if (!target || !type) {
    return res.status(400).json({ error: "target and type are required" });
  }

  const targets = resolveTargetScreens(target);
  if (targets.length === 0) {
    return res.status(404).json({ error: "target does not resolve to any registered screens" });
  }

  if (type === "camera") {
    if (!camera && !snapshot) {
      return res.status(400).json({ error: "camera or snapshot is required" });
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      return res.status(400).json({ error: "camera overrides require a duration greater than 0" });
    }
    const overlayPayload = {
      type: "manual",
      label: label || "camera",
      camera: camera || "camera",
      duration: Math.max(1, duration),
      snapshot: snapshot || (camera ? `/api/frigate/cameras/${encodeURIComponent(camera)}/snapshot` : undefined),
      time: new Date().toISOString()
    };
    publishCommandToResolvedTargets(targets, "overlay", overlayPayload, { retain: false, qos: 1 })
      .then(() => {
        return res.json({
          applied: true,
          target,
          resolvedTargets: targets,
          type,
          camera: camera || null,
          duration: Math.max(1, duration)
        });
      })
      .catch((err) => {
        return res.status(500).json({ error: err.message || "failed to apply camera override" });
      });
    return;
  }

  if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) {
    return res.status(400).json({ error: "duration must be greater than 0 when set" });
  }

  if (type !== "widget" && !resourceId) {
    return res.status(400).json({ error: "resourceId is required" });
  }

  const override = {};
  let resolvedResource = null;

  if (type === "theme") {
    resolvedResource = getTheme(resourceId);
    if (!resolvedResource) {
      return res.status(404).json({ error: "theme not found" });
    }
    override.theme = resolvedResource;
    override.themeState = buildThemePayloadFromTheme(resolvedResource);
  } else if (type === "profile") {
    resolvedResource = getProfile(resourceId);
    if (!resolvedResource) {
      return res.status(404).json({ error: "profile not found" });
    }
    override.profile = resolvedResource;
    override.layout = buildLayoutPayloadFromProfile(resolvedResource);
  } else if (type === "banner") {
    resolvedResource = getBanner(resourceId);
    if (!resolvedResource) {
      return res.status(404).json({ error: "banner not found" });
    }
    override.bannerState = buildBannerPayloadFromBanner(resolvedResource);
  } else if (type === "ticker") {
    resolvedResource = getTicker(resourceId);
    if (!resolvedResource) {
      return res.status(404).json({ error: "ticker not found" });
    }
    override.tickerState = buildTickerPayloadFromTicker(resolvedResource);
  } else if (type === "widget") {
    if (!Number.isInteger(widgetIndex) || widgetIndex < 0 || widgetIndex > 3) {
      return res.status(400).json({ error: "widgetIndex must be an integer from 0 to 3" });
    }
    if (!resourceId) {
      return res.status(400).json({ error: "widget resourceId is required" });
    }
    const widget = getWidget(resourceId);
    if (!widget) {
      return res.status(404).json({ error: "widget not found" });
    }
    const invalidTargets = targets.filter((item) => {
      const runtime = getRuntimeStateForScreen(item);
      return runtime?.layout?.template !== "custom";
    });
    if (invalidTargets.length > 0) {
      return res.status(400).json({
        error: `widget overrides require a custom layout on all targets: ${invalidTargets.join(", ")}`
      });
    }
    override.widgetOverrides = {
      [widgetIndex]: widget.config
    };
  } else {
    return res.status(400).json({ error: "unsupported override type" });
  }

  broadcastTransientRuntime(targets, override, duration);
  return res.json({
    applied: true,
    target,
    resolvedTargets: targets,
    type,
    resourceId,
    duration,
    widgetIndex: type === "widget" ? widgetIndex : null
  });
});

app.get("/v/:viewId", (req, res) => {
  const viewId = String(req.params.viewId || "").trim().toLowerCase();
  if (!viewId || !/^[a-z0-9_-]+$/.test(viewId)) {
    return res.status(404).send("Not found");
  }
  return res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.get(["/views", "/design", "/automation", "/targets", "/system"], (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "app.html"));
});

process.on("SIGTERM", () => {
  if (!mqttClient) {
    process.exit(0);
    return;
  }
  mqttClient.publish(
    SERVER_STATE_TOPIC,
    JSON.stringify({ online: false }),
    { qos: 1, retain: true },
    () => process.exit(0)
  );
});

server.listen(PORT, () => {
  console.log(`Signage server listening on port ${PORT}`);
  connectMqttClient(true);
  connectHaStream(true);
  refreshHaEntities().catch((err) => {
    console.error("Initial Home Assistant refresh failed:", err.message);
  });
  refreshImmichStatus().catch((err) => {
    console.error("Initial Immich refresh failed:", err.message);
  });
  refreshFrigateStatus().catch((err) => {
    console.error("Initial Frigate refresh failed:", err.message);
  });
  setInterval(() => {
    refreshImmichStatus().catch((err) => {
      console.error("Immich refresh failed:", err.message);
    });
  }, 30000);
  setInterval(() => {
    refreshFrigateStatus().catch((err) => {
      console.error("Frigate refresh failed:", err.message);
    });
  }, 30000);
  setInterval(() => {
    processScheduleRules().catch((err) => {
      console.error("Scheduled rule processing failed:", err.message);
    });
  }, 15000);
  setInterval(() => {
    try {
      maybeRunNightlyBackup();
    } catch (err) {
      console.error("Nightly backup failed:", err.message);
    }
  }, 60000);
  setInterval(() => {
    try {
      expireStaleRuntimeOverrides();
    } catch (err) {
      console.error("Runtime override sweep failed:", err.message);
    }
  }, RUNTIME_OVERRIDE_SWEEP_MS);
  setInterval(() => {
    try {
      pruneStalePendingDevices();
    } catch (err) {
      console.error("Pending device sweep failed:", err.message);
    }
  }, PENDING_DEVICE_SWEEP_MS);
});
