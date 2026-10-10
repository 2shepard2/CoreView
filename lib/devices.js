// Display devices: fresh pairing with a short on-screen code.
//
// A browser that opens the display page gets a device ID and a long random
// key (kept in an HttpOnly cookie). Only the SHA-256 of the key is stored. The
// screen shows a 4-character code; the admin types that code in Studio to
// attach the device to a screen. Unpairing deletes the device, so the browser
// has to pair again.
const crypto = require("node:crypto");

const CODE_ALPHABET = "ACDEFHJKMNPRTUVWXY34679"; // no 0/O, 1/I/L, 2/Z, 5/S, 8/B
const MAX_UNPAIRED = 50;
const UNPAIRED_TTL_MS = 24 * 3600 * 1000;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function newCode(taken) {
  for (let i = 0; i < 1000; i++) {
    let code = "";
    for (const b of crypto.randomBytes(4)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!taken.has(code)) return code;
  }
  throw new Error("No free pairing code");
}

// "Chrome/44.0.2403.119" -> 44. Non-Chromium browsers report null; we treat
// them as modern because the admin will see the model and can judge.
function chromeMajor(ua) {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(String(ua || ""));
  return m ? Number(m[1]) : null;
}

// A short human label from the user agent: "Android 6.0.1 · ZN-DP1001".
function deviceLabel(ua) {
  const s = String(ua || "");
  const android = /Android ([\d.]+);\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(s);
  if (android) return `Android ${android[1]} · ${android[2].trim()}`;
  if (/Windows/.test(s)) return "Windows";
  if (/Macintosh/.test(s)) return "Mac";
  if (/iPhone|iPad/.test(s)) return "iOS";
  if (/Linux/.test(s)) return "Linux";
  return "Unknown device";
}

function createDevices({ store, now = Date.now }) {
  function prune(d) {
    const t = now();
    for (const [id, dev] of Object.entries(d.devices)) {
      if (!dev.screenId && t - dev.createdAt > UNPAIRED_TTL_MS) delete d.devices[id];
    }
  }

  return {
    // Look up a device from its cookie value "<id>.<key>".
    authenticate(cookie) {
      if (typeof cookie !== "string") return null;
      const dot = cookie.indexOf(".");
      if (dot < 1) return null;
      const id = cookie.slice(0, dot), key = cookie.slice(dot + 1);
      const dev = store.data.devices[id];
      if (!dev || !key) return null;
      const want = Buffer.from(dev.keyHash, "hex"), got = Buffer.from(sha256(key), "hex");
      return want.length === got.length && crypto.timingSafeEqual(want, got) ? dev : null;
    },

    create({ ua, ip, width, height }) {
      return store.update((d) => {
        prune(d);
        const unpaired = Object.values(d.devices).filter((x) => !x.screenId);
        if (unpaired.length >= MAX_UNPAIRED) {
          throw Object.assign(new Error("Too many displays waiting to pair"), { status: 429 });
        }
        const id = "dev-" + crypto.randomBytes(9).toString("base64url");
        const key = crypto.randomBytes(32).toString("base64url");
        const taken = new Set(Object.values(d.devices).map((x) => x.code));
        d.devices[id] = {
          id, keyHash: sha256(key), code: newCode(taken), screenId: null,
          ua: String(ua || "").slice(0, 300), chrome: chromeMajor(ua), label: deviceLabel(ua),
          width: clampSize(width), height: clampSize(height),
          ip: String(ip || ""), createdAt: now(), lastSeen: now()
        };
        return { device: d.devices[id], cookie: `${id}.${key}` };
      });
    },

    // Record what the browser reports each time it connects.
    seen(dev, { ua, ip, width, height }) {
      store.update((d) => {
        const x = d.devices[dev.id];
        if (!x) return;
        x.lastSeen = now();
        if (ua) { x.ua = String(ua).slice(0, 300); x.chrome = chromeMajor(ua); x.label = deviceLabel(ua); }
        if (ip) x.ip = String(ip);
        if (width) x.width = clampSize(width);
        if (height) x.height = clampSize(height);
      });
    },

    pair(code, screenId) {
      const want = String(code || "").trim().toUpperCase();
      return store.update((d) => {
        if (!d.screens[screenId]) throw Object.assign(new Error("Unknown screen"), { status: 404 });
        const dev = Object.values(d.devices).find((x) => !x.screenId && x.code === want);
        if (!dev) throw Object.assign(new Error("No display is showing that code"), { status: 404 });
        // One display per screen: an older device on this screen is unpaired.
        for (const [id, other] of Object.entries(d.devices)) {
          if (other.screenId === screenId) delete d.devices[id];
        }
        dev.screenId = screenId;
        dev.pairedAt = now();
        return dev;
      });
    },

    unpair(deviceId) {
      return store.update((d) => {
        const dev = d.devices[deviceId];
        if (!dev) throw Object.assign(new Error("Unknown display"), { status: 404 });
        delete d.devices[deviceId];
        return dev;
      });
    },

    forScreen(screenId) {
      return Object.values(store.data.devices).find((x) => x.screenId === screenId) || null;
    }
  };
}

function clampSize(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 && v < 10000 ? v : null;
}

module.exports = { createDevices, chromeMajor, deviceLabel, CODE_ALPHABET };
