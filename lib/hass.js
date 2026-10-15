// One long-lived Home Assistant WebSocket: subscribes to just the entities the
// board shows (`subscribe_entities`, compressed diffs) and carries service calls.
// REST is used for calendars, which have no WebSocket read.
const { EventEmitter } = require("node:events");

class HaError extends Error {
  constructor(message, status) { super(message); this.name = "HaError"; this.status = status; }
}

// Apply one `subscribe_entities` message to a { entity_id: {state, attributes, last_changed} } map.
function applyDiff(states, msg) {
  const changed = [];
  for (const [id, s] of Object.entries(msg.a || {})) {
    states[id] = { state: s.s, attributes: s.a || {}, last_changed: toIso(s.lc), last_updated: toIso(s.lu || s.lc) };
    changed.push(id);
  }
  for (const [id, d] of Object.entries(msg.c || {})) {
    const cur = states[id];
    if (!cur) continue;
    const plus = d["+"] || {};
    if ("s" in plus) cur.state = plus.s;
    if (plus.a) cur.attributes = { ...cur.attributes, ...plus.a };
    if ("lc" in plus) { cur.last_changed = toIso(plus.lc); cur.last_updated = cur.last_changed; }
    if ("lu" in plus) cur.last_updated = toIso(plus.lu);
    for (const k of (d["-"] && d["-"].a) || []) delete cur.attributes[k];
    changed.push(id);
  }
  for (const id of msg.r || []) { delete states[id]; changed.push(id); }
  return changed;
}
const toIso = (t) => (typeof t === "number" ? new Date(t * 1000).toISOString() : t || null);

function createHass({ url, token, entities, WebSocketImpl = globalThis.WebSocket, fetchImpl = fetch, log = () => {},
  connectTimeoutMs = 20000, pingMs = 30000 }) {
  const root = String(url || "").replace(/\/+$/, "");
  const bus = new EventEmitter();
  const states = {};
  const pending = new Map();
  let ws = null, nextId = 1, connected = false, stopped = false, retryMs = 1000, subId = null;
  let retryTimer = null, deadline = null, pinger = null, failures = 0;

  // Every way a socket can end funnels here once, so a reconnect is always
  // scheduled. On 2026-10-03 HA was still booting when the board started; the
  // first socket never closed and the board stayed offline for hours.
  function drop(sock, reason) {
    if (sock !== ws) return;
    ws = null;
    clearTimeout(deadline); clearInterval(pinger);
    try { sock.close(); } catch (_e) { /* already closed */ }
    if (connected) log(`ha: connection lost (${reason})`);
    else if (failures++ % 20 === 0) log(`ha: connect failed (${reason}); retrying`);
    connected = false; bus.emit("status", false);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new HaError("Home Assistant connection lost", 502)); }
    pending.clear();
    if (!stopped && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    }
  }

  function connect() {
    if (stopped) return;
    let sock;
    try { sock = ws = new WebSocketImpl(root.replace(/^http/, "ws") + "/api/websocket"); } catch (err) { ws = {}; drop(ws, err.message); return; }
    deadline = setTimeout(() => drop(sock, "no auth_ok within " + connectTimeoutMs / 1000 + "s"), connectTimeoutMs);
    sock.onmessage = (event) => {
      if (sock !== ws) return;
      let msg;
      try { msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch (_err) { return; }
      if (msg.type === "auth_required") sock.send(JSON.stringify({ type: "auth", access_token: token }));
      // One rejected token must not become a retry loop: HA's ip_ban would lock out
      // every screen (whiteboard, CoreView). Stay down until restarted with a good token.
      else if (msg.type === "auth_invalid") { log("ha: token rejected; not retrying until restart"); stopped = true; drop(sock, "auth_invalid"); }
      else if (msg.type === "auth_ok") {
        clearTimeout(deadline);
        if (failures) log(`ha: connected after ${failures} failed attempt(s)`);
        connected = true; retryMs = 1000; failures = 0; bus.emit("status", true);
        subId = nextId++;
        sock.send(JSON.stringify({ id: subId, type: "subscribe_entities", entity_ids: entities }));
        // Half-open sockets (HA VM gone without a FIN) never fire close; a ping
        // that gets no answer within the next interval does the same job.
        pinger = setInterval(() => {
          command({ type: "ping" }, pingMs).catch(() => drop(sock, "ping timed out"));
        }, pingMs);
      } else if (msg.type === "event" && msg.id === subId) {
        const changed = applyDiff(states, msg.event);
        if (changed.length) bus.emit("change", changed);
      } else if ((msg.type === "result" || msg.type === "pong") && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.type === "pong" || msg.success) p.resolve(msg.result);
        else p.reject(new HaError((msg.error && msg.error.message) || "Home Assistant command failed", 400));
      }
    };
    sock.onclose = () => drop(sock, "closed");
    sock.onerror = () => drop(sock, "socket error");
  }

  function command(payload, timeoutMs = 15000) {
    if (!connected) return Promise.reject(new HaError("Home Assistant is not connected", 503));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new HaError("Home Assistant timed out", 504)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  function callService(domain, service, data = {}, returnResponse = false) {
    const p = { type: "call_service", domain, service, service_data: data };
    if (returnResponse) p.return_response = true;
    return command(p).then((r) => (returnResponse ? r && r.response : r));
  }

  async function rest(pathname) {
    const rsp = await fetchImpl(`${root}${pathname}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
    if (!rsp.ok) throw new HaError(`Home Assistant ${pathname.split("?")[0]} failed (${rsp.status})`, rsp.status);
    return rsp;
  }

  async function calendar(entity, startIso, endIso) {
    const rsp = await rest(`/api/calendars/${encodeURIComponent(entity)}?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`);
    return rsp.json();
  }

  return {
    start() { connect(); return this; },
    stop() { stopped = true; clearTimeout(retryTimer); if (ws) drop(ws, "stopped"); },
    get connected() { return connected; },
    states, on: bus.on.bind(bus), callService, command, calendar, rest
  };
}

module.exports = { createHass, applyDiff, HaError };
