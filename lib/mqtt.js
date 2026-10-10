// A small MQTT 3.1.1 client: enough for the Matrix (retained QoS 1 publishes,
// QoS 0 subscriptions, keepalive, reconnect). Studio has no runtime
// dependencies, and the Beacon protocol needs nothing more than this.
const net = require("node:net");
const { EventEmitter } = require("node:events");

const T = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

function str(s) {
  const b = Buffer.from(String(s), "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}
function remaining(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}
function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), remaining(body.length), body]);
}

// Parse as many complete packets as the buffer holds; returns [packets, rest].
function parse(buf) {
  const packets = [];
  let off = 0;
  while (buf.length - off >= 2) {
    let mult = 1, len = 0, i = off + 1, byte;
    do {
      if (i >= buf.length) return [packets, buf.subarray(off)];
      byte = buf[i++];
      len += (byte & 127) * mult;
      mult *= 128;
    } while (byte & 128);
    if (buf.length < i + len) break;
    packets.push({ type: buf[off] >> 4, flags: buf[off] & 15, body: buf.subarray(i, i + len) });
    off = i + len;
  }
  return [packets, buf.subarray(off)];
}

function decodePublish(p) {
  const tlen = p.body.readUInt16BE(0);
  const topic = p.body.subarray(2, 2 + tlen).toString("utf8");
  const qos = (p.flags >> 1) & 3;
  let off = 2 + tlen, id = null;
  if (qos > 0) { id = p.body.readUInt16BE(off); off += 2; }
  return { topic, qos, id, retain: Boolean(p.flags & 1), payload: p.body.subarray(off) };
}

function topicMatches(filter, topic) {
  const f = filter.split("/"), t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

function createMqtt({ url, username, password, clientId, keepalive = 30, log = () => {}, connectImpl = net.connect }) {
  const u = new URL(url);
  const bus = new EventEmitter();
  const subs = new Set();
  let sock = null, connected = false, stopped = false, retryMs = 1000, retryTimer = null, pinger = null;
  let nextId = 1, failures = 0, buf = Buffer.alloc(0), lastIn = 0;

  const id = () => { nextId = (nextId % 65535) + 1; return nextId; };

  function drop(s, reason) {
    if (s !== sock) return;
    sock = null;
    clearInterval(pinger);
    try { s.destroy(); } catch (_e) { /* gone */ }
    if (connected) log(`mqtt: connection lost (${reason})`);
    else if (failures++ % 20 === 0) log(`mqtt: connect failed (${reason}); retrying`);
    connected = false;
    bus.emit("status", false);
    if (!stopped && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    }
  }

  function sendSubscribe(filters) {
    if (!filters.length) return;
    const body = Buffer.concat([Buffer.from([0, 0]), ...filters.map((f) => Buffer.concat([str(f), Buffer.from([0])]))]);
    body.writeUInt16BE(id(), 0);
    sock.write(packet(T.SUBSCRIBE, 2, body));
  }

  function connect() {
    if (stopped) return;
    buf = Buffer.alloc(0);
    const s = sock = connectImpl({ host: u.hostname, port: Number(u.port || 1883) });
    s.setNoDelay(true);
    s.on("connect", () => {
      let flags = 2; // clean session
      const parts = [str("MQTT"), Buffer.from([4, 0, 0, 0]), str(clientId)];
      if (username) { flags |= 128; parts.push(str(username)); }
      if (password) { flags |= 64; parts.push(str(password)); }
      parts[1][1] = flags;
      parts[1].writeUInt16BE(keepalive, 2);
      s.write(packet(T.CONNECT, 0, Buffer.concat(parts)));
    });
    s.on("data", (chunk) => {
      if (s !== sock) return;
      lastIn = Date.now();
      let packets;
      [packets, buf] = parse(Buffer.concat([buf, chunk]));
      for (const p of packets) handle(s, p);
    });
    s.on("error", (err) => drop(s, err.code || err.message));
    s.on("close", () => drop(s, "closed"));
  }

  function handle(s, p) {
    if (p.type === T.CONNACK) {
      if (p.body[1] !== 0) {
        // A refused login must not hammer the broker; one try per 30 s.
        retryMs = 30000;
        drop(s, `refused (code ${p.body[1]})`);
        return;
      }
      if (failures) log(`mqtt: connected after ${failures} failed attempt(s)`);
      connected = true; retryMs = 1000; failures = 0;
      sendSubscribe([...subs]);
      pinger = setInterval(() => {
        if (Date.now() - lastIn > keepalive * 1500) return drop(s, "keepalive timed out");
        s.write(packet(T.PINGREQ, 0, Buffer.alloc(0)));
      }, keepalive * 500);
      bus.emit("status", true);
    } else if (p.type === T.PUBLISH) {
      const m = decodePublish(p);
      if (m.qos === 1) {
        const ack = Buffer.alloc(2);
        ack.writeUInt16BE(m.id);
        s.write(packet(T.PUBACK, 0, ack));
      }
      bus.emit("message", m.topic, m.payload, { retain: m.retain });
    }
  }

  return {
    start() { connect(); return this; },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      if (sock && connected) { try { sock.write(packet(T.DISCONNECT, 0, Buffer.alloc(0))); } catch (_e) { /* closing anyway */ } }
      if (sock) drop(sock, "stopped");
    },
    get connected() { return connected; },
    on: bus.on.bind(bus),
    subscribe(filter) {
      if (subs.has(filter)) return;
      subs.add(filter);
      if (connected) sendSubscribe([filter]);
    },
    // Returns false when offline; callers republish on reconnect instead of queueing.
    publish(topic, payload, { qos = 0, retain = false } = {}) {
      if (!connected) return false;
      const parts = [str(topic)];
      if (qos > 0) { const pid = Buffer.alloc(2); pid.writeUInt16BE(id()); parts.push(pid); }
      parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8"));
      sock.write(packet(T.PUBLISH, (qos << 1) | (retain ? 1 : 0), Buffer.concat(parts)));
      return true;
    }
  };
}

module.exports = { createMqtt, parse, packet, remaining, topicMatches, decodePublish, T };
