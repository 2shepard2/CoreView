// Admin sign-in (one household admin), sessions, and the agent token.
//
// The password is stored as scrypt(salt, password). Sessions are kept in the
// store as SHA-256(session id), so restarts and deploys don't sign people
// out and the file never holds a usable cookie value. The agent
// token (a root-only file on the host) lets scripts and automations call the admin API
// without a browser session.
const crypto = require("node:crypto");
const fs = require("node:fs");

const SESSION_MS = 30 * 24 * 3600 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

function checkPassword(record, password) {
  if (!record || typeof password !== "string") return false;
  const want = Buffer.from(record.hash, "hex");
  const got = crypto.scryptSync(password, Buffer.from(record.salt, "hex"), 32, { N: 16384, r: 8, p: 1 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createAuth({ store, agentTokenFile, setupCodeFile, now = Date.now }) {
  const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  const sessions = {
    get: (id) => (store.data.sessions || {})[sha(id)],
    set: (id, v) => store.update((d) => {
      d.sessions = d.sessions || {};
      for (const [k, x] of Object.entries(d.sessions)) if (x.expires < now()) delete d.sessions[k];
      d.sessions[sha(id)] = v;
    }),
    delete: (id) => { if (store.data.sessions && store.data.sessions[sha(id)]) store.update((d) => { delete d.sessions[sha(id)]; }); }
  };
  let agentToken = null;
  if (agentTokenFile && fs.existsSync(agentTokenFile)) {
    agentToken = fs.readFileSync(agentTokenFile, "utf8").trim() || null;
  }
  // Slow down password guessing: one failed attempt per IP per second.
  const lastFail = new Map();

  return {
    needsSetup() { return !store.data.admin; },

    // First-run setup needs a one-time code from a root-only file on the
    // server (SETUP_CODE_FILE), so whoever reaches a fresh install first can't
    // claim it. No file, no setup.
    setup(username, password, code) {
      if (store.data.admin) throw Object.assign(new Error("Already set up"), { status: 409 });
      const want = setupCodeFile && fs.existsSync(setupCodeFile) ? fs.readFileSync(setupCodeFile, "utf8").trim() : "";
      if (!want) throw Object.assign(new Error("Setup is locked: put a one-time code in the server's setup_code file (see the README)"), { status: 403 });
      if (!safeEqual(String(code || "").trim(), want)) throw Object.assign(new Error("That setup code isn't right"), { status: 403 });
      if (typeof username !== "string" || !/^[A-Za-z0-9._-]{2,32}$/.test(username)) {
        throw Object.assign(new Error("Pick a username of 2-32 letters or numbers"), { status: 400 });
      }
      if (typeof password !== "string" || password.length < 8) {
        throw Object.assign(new Error("Use a password of at least 8 characters"), { status: 400 });
      }
      store.update((d) => { d.admin = { username, ...hashPassword(password) }; });
      return this.createSession(username);
    },

    login(username, password, ip) {
      const t = now();
      if (t - (lastFail.get(ip) || 0) < 1000) return null;
      const admin = store.data.admin;
      if (admin && username === admin.username && checkPassword(admin, password)) {
        return this.createSession(username);
      }
      lastFail.set(ip, t);
      return null;
    },

    createSession(username) {
      const id = crypto.randomBytes(32).toString("base64url");
      sessions.set(id, { username, expires: now() + SESSION_MS });
      return id;
    },

    // Asked again before risky changes (connections). Same pace limit as sign-in.
    verifyPassword(password, ip) {
      const t = now();
      if (t - (lastFail.get(ip) || 0) < 1000) throw Object.assign(new Error("Too fast; try again in a second"), { status: 429 });
      if (!checkPassword(store.data.admin, password)) {
        lastFail.set(ip, t);
        throw Object.assign(new Error("Your Studio password isn't right"), { status: 403 });
      }
    },

    // A new password signs out every other browser; this one stays signed in.
    changePassword(current, next, keepSessionId, ip) {
      const t = now();
      if (t - (lastFail.get(ip) || 0) < 1000) throw Object.assign(new Error("Too fast; try again in a second"), { status: 429 });
      const admin = store.data.admin;
      if (!admin || !checkPassword(admin, current)) {
        lastFail.set(ip, t);
        throw Object.assign(new Error("The current password isn't right"), { status: 403 });
      }
      if (typeof next !== "string" || next.length < 8) throw Object.assign(new Error("Use a password of at least 8 characters"), { status: 400 });
      if (next === current) throw Object.assign(new Error("That's the same password"), { status: 400 });
      const keep = keepSessionId ? sha(keepSessionId) : null;
      store.update((d) => {
        d.admin = { username: admin.username, ...hashPassword(next) };
        for (const k of Object.keys(d.sessions || {})) if (k !== keep) delete d.sessions[k];
      });
    },

    logout(id) { if (id) sessions.delete(id); },

    // Returns the username for a valid session cookie or agent bearer token.
    who({ sessionId, bearer }) {
      if (bearer && agentToken && safeEqual(bearer, agentToken)) return "agent";
      const s = sessionId && sessions.get(sessionId);
      if (!s) return null;
      if (s.expires < now()) { sessions.delete(sessionId); return null; }
      return s.username;
    }
  };
}

module.exports = { createAuth, hashPassword, checkPassword, SESSION_MS };
