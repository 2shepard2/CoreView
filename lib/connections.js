// Where each integration's address and key come from.
//
// Two sources, never mixed within one service:
//   server   .env (the URL) and files in secrets/ (the key). If any of a
//            service's settings is set on the server, the whole service is
//            read-only in Studio, so a browser can't point a server-held key
//            at another address.
//   browser  saved from Studio's Settings page into data/connections.json
//            (0600, like studio.json). Keys are write-only: they never go
//            back to the browser.
// A saved key belongs to the address it was entered for: changing the
// address forgets it (on save, and when testing a draft), so nobody who gets
// into Studio can send the household's token to a server of their choosing.
// SETTINGS_LOCK=1 makes every service read-only.
const fs = require("node:fs");
const path = require("node:path");

const SERVICES = {
  homeAssistant: { name: "Home Assistant", what: "Entities, calendars, lists, timers, LED sign text",
    url: "HA_URL", secretFile: "HA_TOKEN_FILE", secretLabel: "Long-lived access token", protocols: ["http:", "https:"], example: "http://homeassistant.local:8123" },
  mqtt: { name: "MQTT broker", what: "The LED Matrix", url: "MQTT_URL", user: "MQTT_USERNAME", secretFile: "MQTT_PASSWORD_FILE",
    secretLabel: "Password", protocols: ["mqtt:"], example: "mqtt://homeassistant.local:1883" },
  immich: { name: "Immich", what: "Photo slideshows", url: "IMMICH_URL", secretFile: "IMMICH_KEY_FILE", secretLabel: "API key",
    protocols: ["http:", "https:"], example: "http://immich.local:2283",
    tip: "Pick an album for each Photo slideshow in the view editor. Studio lists every album this key can see, so a separate Immich user with only the albums you want shared to it keeps the rest private." },
  frigate: { name: "Frigate", what: "Camera pop-ups and events", url: "FRIGATE_URL", protocols: ["http:", "https:"], example: "http://frigate.local:5000" },
  jellyfin: { name: "Jellyfin", what: "The Now showing widget", url: "JELLYFIN_URL", secretFile: "JELLYFIN_KEY_FILE", secretLabel: "API key",
    protocols: ["http:", "https:"], example: "http://jellyfin.local:8096" },
  prometheus: { name: "Prometheus", what: "The Terrarium widget", url: "PROMETHEUS_URL", protocols: ["http:", "https:"], example: "http://prometheus.local:9090",
    tip: "The Terrarium was built for one homelab: it expects node_exporter, prometheus-pve-exporter and blackbox probes, and LAB_HOST_PATTERN in .env picks your Proxmox hosts. See the README's Terrarium section." }
};

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const readFile = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "");

// A clean URL string, "" for blank, or an error people can act on.
function cleanUrl(svc, v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.length > 300) throw bad("That address is too long");
  let u;
  try { u = new URL(s); } catch (_e) { throw bad(`That isn't an address; it should look like ${svc.example}`); }
  if (!svc.protocols.includes(u.protocol)) throw bad(`${svc.name} addresses start with ${svc.protocols.map((p) => p + "//").join(" or ")}`);
  if (u.username || u.password) throw bad("Leave the user name and password out of the address");
  if (u.search || u.hash) throw bad("Leave the ?query or #part out of the address");
  return u.toString().replace(/\/+$/, "");
}

function createConnections({ env = {}, dataDir, now = Date.now }) {
  const file = path.join(dataDir, "connections.json");
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")).services || {}; } catch (_e) { saved = {}; }
  const lockAll = env.SETTINGS_LOCK === "1";

  function write(services) {
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeSync(fd, JSON.stringify({ version: 1, services }, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }

  const svcOf = (id) => { const s = SERVICES[id]; if (!s) throw bad("Unknown connection", 404); return s; };
  // Set on the server: a URL or user name in the environment, or a non-empty key file.
  function onServer(id) {
    const s = svcOf(id);
    return Boolean(env[s.url] || (s.user && env[s.user]) || (s.secretFile && readFile(env[s.secretFile])));
  }

  // What the integrations use right now. Server keys are read on each call,
  // so secret-sync can rotate them without a restart.
  function get(id) {
    const s = svcOf(id);
    if (onServer(id)) return { url: env[s.url] || "", username: s.user ? env[s.user] || "" : "", secret: s.secretFile ? readFile(env[s.secretFile]) : "", source: "server" };
    const x = saved[id];
    if (!x || !x.url) return { url: "", username: "", secret: "", source: "none" };
    return { url: x.url, username: x.username || "", secret: x.secret || "", source: "browser" };
  }

  // A draft from the Settings page, resolved by the same rules a save uses.
  // input: { url, username, secret, clearSecret }
  function draft(id, input) {
    const s = svcOf(id), cur = get(id), b = input && typeof input === "object" ? input : {};
    const url = cleanUrl(s, b.url);
    const username = s.user ? String(b.username || "").trim().slice(0, 100) : "";
    let secret = "";
    if (s.secretFile) {
      const given = typeof b.secret === "string" ? b.secret.trim() : "";
      if (given.length > 4096) throw bad("That key is too long");
      // Keep the saved key only for the same address (and same source).
      secret = given || (!b.clearSecret && cur.source === "browser" && url === cur.url ? cur.secret : "");
    }
    return { url, username, secret };
  }

  return {
    SERVICES,
    get,
    locked: (id) => lockAll || onServer(id),
    draft,
    // input as for draft(). Returns true when anything changed.
    save(id, input) {
      if (lockAll) throw bad("Settings are locked on the server (SETTINGS_LOCK=1)", 409);
      if (onServer(id)) throw bad(`${svcOf(id).name} is set on the server (.env / secrets); change it there`, 409);
      const d = draft(id, input), prev = saved[id] || {};
      const next = d.url ? { url: d.url, username: d.username, secret: d.secret,
        secretSetAt: d.secret ? (d.secret === prev.secret ? prev.secretSetAt || now() : now()) : null, updatedAt: now() } : null;
      const same = JSON.stringify({ ...prev, updatedAt: 0 }) === JSON.stringify(next ? { ...next, updatedAt: 0 } : {});
      if (same) return false;
      // Disk first: if the write fails, nothing in memory changed and a retry saves again.
      const all = { ...saved };
      if (next) all[id] = next; else delete all[id];
      write(all);
      saved = all;
      return true;
    },
    // For the Settings page: never includes a key.
    describe(id) {
      const s = svcOf(id), cur = get(id), x = saved[id] || {};
      return {
        id, name: s.name, what: s.what, tip: s.tip || null, example: s.example, source: cur.source,
        locked: lockAll || cur.source === "server", lockReason: cur.source === "server" ? "server" : lockAll ? "lock" : null,
        url: cur.url ? displayUrl(cur.url) : "",
        username: s.user ? cur.username : undefined, hasUser: Boolean(s.user),
        secret: s.secretFile ? { label: s.secretLabel, set: Boolean(cur.secret), setAt: cur.source === "browser" ? x.secretSetAt || null : null } : null,
        configured: Boolean(cur.url && (!s.secretFile || cur.secret || id === "mqtt"))
      };
    }
  };
}

function displayUrl(u) {
  try { const x = new URL(u); x.username = ""; x.password = ""; return x.toString().replace(/\/$/, ""); } catch (_e) { return ""; }
}

module.exports = { createConnections, SERVICES, cleanUrl };
