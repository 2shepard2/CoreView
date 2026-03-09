#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_DIR = process.cwd();
const DB_DIR = path.join(APP_DIR, "data");
const DB_PATH = path.join(DB_DIR, "signage.db");
const BACKUP_DIR = path.join(DB_DIR, "backups");

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

function parseJsonOrDefault(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function ensureBaseSchema() {
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
    CREATE TABLE IF NOT EXISTS widgets (
      widget_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

function backupDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const targetPath = path.join(BACKUP_DIR, `coreview-pre-migration-${stamp}.sqlite3`);
  fs.copyFileSync(DB_PATH, targetPath);
  return targetPath;
}

function columnNames(tableName) {
  return new Set(
    sqliteQuery(`PRAGMA table_info(${tableName});`).map((row) => String(row.name || "").toLowerCase())
  );
}

function getProfile(profileId) {
  const rows = sqliteQuery(
    `SELECT profile_id AS profileId
     FROM profiles
     WHERE profile_id = ${sqlQuote(profileId)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function getTheme(themeId) {
  const rows = sqliteQuery(
    `SELECT theme_id AS themeId
     FROM themes
     WHERE theme_id = ${sqlQuote(themeId)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function getView(viewId) {
  const rows = sqliteQuery(
    `SELECT view_id AS viewId
     FROM views
     WHERE view_id = ${sqlQuote(viewId)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function getWidget(widgetId) {
  const rows = sqliteQuery(
    `SELECT widget_id AS widgetId
     FROM widgets
     WHERE widget_id = ${sqlQuote(widgetId)}
     LIMIT 1;`
  );
  return rows[0] || null;
}

function buildUniqueId(baseId, existsFn, fallbackPrefix) {
  const normalizedBase = String(baseId || fallbackPrefix)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallbackPrefix;
  if (!existsFn(normalizedBase)) {
    return normalizedBase;
  }
  let index = 2;
  while (existsFn(`${normalizedBase}-${index}`)) {
    index += 1;
  }
  return `${normalizedBase}-${index}`;
}

function buildUniqueViewId(baseId) {
  return buildUniqueId(baseId, (value) => Boolean(getView(value)), "view");
}

function buildUniqueWidgetId(baseId) {
  return buildUniqueId(baseId, (value) => Boolean(getWidget(value)), "widget");
}

function saveView(viewId, name, profileId, themeId) {
  const now = nowIso();
  sqliteExec(
    `INSERT INTO views (view_id, name, profile_id, theme_id, created_at, updated_at)
     VALUES (
       ${sqlQuote(viewId)},
       ${sqlQuote(name)},
       ${sqlQuote(profileId || null)},
       ${sqlQuote(themeId || null)},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(view_id) DO UPDATE SET
       name = excluded.name,
       profile_id = excluded.profile_id,
       theme_id = excluded.theme_id,
       updated_at = excluded.updated_at;`
  );
}

function saveWidget(widgetId, name, config) {
  const now = nowIso();
  sqliteExec(
    `INSERT INTO widgets (widget_id, name, config_json, created_at, updated_at)
     VALUES (
       ${sqlQuote(widgetId)},
       ${sqlQuote(name)},
       ${sqlQuote(JSON.stringify(config || {}))},
       ${sqlQuote(now)},
       ${sqlQuote(now)}
     )
     ON CONFLICT(widget_id) DO UPDATE SET
       name = excluded.name,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at;`
  );
}

function ensureDeviceKeyHashColumn() {
  const columns = columnNames("devices");
  if (!columns.has("device_key_hash")) {
    sqliteExec("ALTER TABLE devices ADD COLUMN device_key_hash TEXT;");
    return true;
  }
  return false;
}

function migrateLegacyProfileWidgets() {
  const profiles = sqliteQuery(
    `SELECT profile_id AS profileId,
            name,
            template,
            config_json AS configJson
     FROM profiles
     ORDER BY profile_id ASC;`
  );
  let migrated = 0;
  for (const profile of profiles) {
    if (!profile || profile.template !== "custom") {
      continue;
    }
    const config = parseJsonOrDefault(profile.configJson, {});
    const hasWidgetIds = Array.isArray(config.widgetIds) && config.widgetIds.length > 0;
    const legacyWidgets = Array.isArray(config.widgets) ? config.widgets : [];
    if (hasWidgetIds || legacyWidgets.length === 0) {
      continue;
    }
    const widgetIds = legacyWidgets.slice(0, 4).map((widget, index) => {
      const widgetId = buildUniqueWidgetId(`${profile.profileId}-w${index + 1}`);
      saveWidget(widgetId, `${profile.name || profile.profileId} Widget ${index + 1}`, widget || {});
      return widgetId;
    });
    const nextConfig = {
      ...config,
      widgetIds
    };
    delete nextConfig.widgets;
    sqliteExec(
      `UPDATE profiles
       SET config_json = ${sqlQuote(JSON.stringify(nextConfig))},
           updated_at = ${sqlQuote(nowIso())}
       WHERE profile_id = ${sqlQuote(profile.profileId)};`
    );
    migrated += 1;
  }
  return migrated;
}

function migrateLegacyWidgetRules() {
  const rules = sqliteQuery(
    `SELECT rule_id AS ruleId,
            name,
            rule_type AS ruleType,
            config_json AS configJson
     FROM rules
     ORDER BY rule_id ASC;`
  );
  let migrated = 0;
  for (const rule of rules) {
    if (!rule || rule.ruleType !== "widget") {
      continue;
    }
    const config = parseJsonOrDefault(rule.configJson, {});
    if (config.widgetId) {
      continue;
    }
    const legacyWidget = config.widget;
    if (!legacyWidget || typeof legacyWidget !== "object" || Array.isArray(legacyWidget)) {
      continue;
    }
    const widgetId = buildUniqueWidgetId(`${rule.ruleId}-widget`);
    saveWidget(widgetId, `${rule.name || rule.ruleId} Widget`, legacyWidget);
    const nextConfig = {
      ...config,
      widgetId
    };
    delete nextConfig.widget;
    sqliteExec(
      `UPDATE rules
       SET config_json = ${sqlQuote(JSON.stringify(nextConfig))},
           updated_at = ${sqlQuote(nowIso())}
       WHERE rule_id = ${sqlQuote(rule.ruleId)};`
    );
    migrated += 1;
  }
  return migrated;
}

function migrateScreensSchemaToViewOnly() {
  const columns = columnNames("screens");
  const hasLegacyProfileId = columns.has("profile_id");
  const hasLegacyThemeId = columns.has("theme_id");
  const hasViewId = columns.has("view_id");
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
  let migrated = 0;
  for (const row of rows) {
    const existingViewId = String(row.viewId || "").trim().toLowerCase();
    if (existingViewId && getView(existingViewId)) {
      continue;
    }
    const profileId = row.profileId && getProfile(String(row.profileId).trim().toLowerCase())
      ? String(row.profileId).trim().toLowerCase()
      : null;
    const themeId = row.themeId && getTheme(String(row.themeId).trim().toLowerCase())
      ? String(row.themeId).trim().toLowerCase()
      : null;
    const viewId = buildUniqueViewId(`screen-${row.screenId}`);
    const viewName = row.friendlyName ? `${row.friendlyName} Default` : `${row.screenId} Default`;
    saveView(viewId, viewName, profileId, themeId);
    sqliteExec(
      `UPDATE screens
       SET view_id = ${sqlQuote(viewId)}
       WHERE screen_id = ${sqlQuote(row.screenId)};`
    );
    migrated += 1;
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
  return migrated;
}

function assertFinalSchema() {
  const screenColumns = columnNames("screens");
  const deviceColumns = columnNames("devices");
  if (screenColumns.has("profile_id") || screenColumns.has("theme_id")) {
    throw new Error("screens table still contains legacy profile_id/theme_id columns");
  }
  if (!screenColumns.has("view_id")) {
    throw new Error("screens table is missing required view_id column");
  }
  if (!deviceColumns.has("device_key_hash")) {
    throw new Error("devices table is missing required device_key_hash column");
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database found at ${DB_PATH}`);
    process.exit(1);
  }

  ensureBaseSchema();
  const backupPath = backupDatabase();
  const results = {
    backupPath,
    deviceKeyHashAdded: ensureDeviceKeyHashColumn(),
    legacyProfileWidgetsMigrated: migrateLegacyProfileWidgets(),
    legacyWidgetRulesMigrated: migrateLegacyWidgetRules(),
    screenBindingsMigrated: migrateScreensSchemaToViewOnly()
  };
  assertFinalSchema();

  console.log("CoreView legacy DB migration completed.");
  if (results.backupPath) {
    console.log(`Backup: ${results.backupPath}`);
  }
  console.log(`devices.device_key_hash added: ${results.deviceKeyHashAdded ? "yes" : "no"}`);
  console.log(`custom profiles migrated from inline widgets: ${results.legacyProfileWidgetsMigrated}`);
  console.log(`widget rules migrated from inline widget payloads: ${results.legacyWidgetRulesMigrated}`);
  console.log(`screens migrated to view-only bindings: ${results.screenBindingsMigrated}`);
}

main();
