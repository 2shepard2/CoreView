// Timer pop-up: HA timer.* states -> what screens and the Matrix show.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createTimers, cleanTimer, durationMs } = require("../lib/timers");
const { createApp } = require("../server");

const T = "timer.kitchen_nfc_timer";
const at = (ms) => new Date(ms).toISOString();

function rig(t0 = 1_000_000_000_000) {
  const clock = { t: t0 };
  const states = {};
  const timers = createTimers({ states: () => states, now: () => clock.t });
  const set = (state, attrs = {}) => {
    states[T] = { state, attributes: { friendly_name: "Kitchen NFC Timer", duration: "0:20:00", ...attrs } };
    timers.onStates([T]);
  };
  return { clock, states, timers, set };
}

test("cleanTimer keeps only timer entities and clamps the done time", () => {
  assert.deepEqual(cleanTimer({ enabled: true, entities: [T, T, "light.x", "timer.a; rm"], doneSeconds: 9999 }),
    { enabled: true, entities: [T], doneSeconds: 600 });
  assert.deepEqual(cleanTimer(null), { enabled: false, entities: [], doneSeconds: 60 });
  assert.equal(durationMs("0:20:00"), 1200000);
  assert.equal(durationMs("1 day, 1:00:05"), 90005000);
  assert.equal(durationMs("junk"), null);
});

test("running, paused, finished and cancelled timers", () => {
  const { clock, timers, set } = rig();
  const cfg = cleanTimer({ enabled: true, entities: [T], doneSeconds: 60 });
  set("idle");
  assert.deepEqual(timers.list(cfg), [], "an idle timer seen first is never 'done'");

  const ends = clock.t + 1200000;
  set("active", { finishes_at: at(ends), remaining: "0:20:00", last_transition: "started" });
  const run = timers.list(cfg)[0];
  assert.equal(run.state, "running");
  assert.equal(run.endsAt, ends);
  assert.equal(run.label, "Kitchen Timer");
  assert.equal(run.duration, 1200000);

  set("paused", { remaining: "0:12:30", last_transition: "paused" });
  assert.deepEqual([timers.list(cfg)[0].state, timers.list(cfg)[0].remaining], ["paused", 750000]);

  set("active", { finishes_at: at(ends), last_transition: "started" });
  clock.t = ends;
  set("idle", { last_transition: "finished" });
  const done = timers.list(cfg)[0];
  assert.equal(done.state, "done");
  assert.equal(done.until, ends + 60000);
  clock.t = ends + 61000;
  assert.deepEqual(timers.list(cfg), [], "done disappears after doneSeconds");

  set("active", { finishes_at: at(clock.t + 60000), last_transition: "started" });
  set("idle", { last_transition: "cancelled" });
  assert.deepEqual(timers.list(cfg), [], "cancelled shows nothing");
  assert.deepEqual(timers.list({ ...cfg, enabled: false }), []);
});

test("without last_transition, idle at the end time counts as finished", () => {
  const { clock, timers, set } = rig();
  const cfg = cleanTimer({ enabled: true, entities: [T] });
  set("active", { finishes_at: at(clock.t + 5000) });
  clock.t += 5200;
  set("idle");
  assert.equal(timers.list(cfg)[0].state, "done");
  set("active", { finishes_at: at(clock.t + 600000) });
  clock.t += 1000;
  set("idle");
  assert.deepEqual(timers.list(cfg), [], "idle long before the end = cancelled");
});

test("a screen with the timer pop-up gets the countdown on init and on change", async () => {
  const hass = new EventEmitter();
  hass.states = {}; hass.connected = true; hass.stop = () => {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvs-"));
  fs.writeFileSync(path.join(dir, "agent_token"), "test-agent-token");
  const overlays = { start() { return this; }, stop() {}, listCameras: async () => [] };
  const app = createApp({ DATA_DIR: dir, COOKIE_SECURE: "0", AGENT_TOKEN_FILE: path.join(dir, "agent_token") },
    { overlays, hass, immich: { configured: () => false, album: async () => [] } }).start();
  const d = http.createServer(app.displayHandler).listen(0), a = http.createServer(app.adminHandler).listen(0);
  await Promise.all([new Promise((r) => d.once("listening", r)), new Promise((r) => a.once("listening", r))]);
  const display = `http://127.0.0.1:${d.address().port}`, admin = `http://127.0.0.1:${a.address().port}`;
  const agent = (method, url, body) => fetch(url, { method, headers: { Authorization: "Bearer test-agent-token", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  try {
    const hello = await fetch(`${display}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const { code } = await hello.json();
    const cookie = hello.headers.get("set-cookie").split(";")[0];
    const pair = await agent("POST", `${admin}/api/pair`, { code, name: "ThinkSmart" });
    const id = pair.data.screenId;
    const saved = await agent("PATCH", `${admin}/api/screens/${id}`, { timer: { enabled: true, entities: [T, "light.nope"], doneSeconds: 30 } });
    assert.deepEqual(saved.data.timer, { enabled: true, entities: [T], doneSeconds: 30 });

    const ends = Date.now() + 600000;
    hass.states[T] = { state: "active", attributes: { friendly_name: "Kitchen NFC Timer", finishes_at: at(ends), duration: "0:10:00" } };
    const events = [];
    const ctrl = new AbortController();
    const stream = fetch(`${display}/api/stream`, { headers: { cookie }, signal: ctrl.signal }).then(async (r) => {
      const reader = r.body.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString();
        for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) events.push([m[1], JSON.parse(m[2])]);
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const init = events.find(([e]) => e === "init")[1];
    assert.equal(init.timers.length, 1);
    assert.equal(init.timers[0].endsAt, ends);

    hass.states[T] = { state: "idle", attributes: { friendly_name: "Kitchen NFC Timer", last_transition: "cancelled" } };
    hass.emit("change", [T]);
    hass.emit("change", ["sensor.unrelated"]);
    assert.equal((await agent("POST", `${admin}/api/screens/${id}/test-timer`)).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await stream;
    const updates = events.filter(([e]) => e === "timers").map(([, x]) => x);
    assert.equal(updates.length, 2, "one for the cancel, one for the test; nothing for unrelated entities");
    assert.deepEqual(updates[0].timers, []);
    assert.equal(updates[1].test, true);
    assert.equal(updates[1].timers[0].state, "running");
  } finally { app.stop(); d.close(); a.close(); }
});

test("the Matrix shows a countdown under alerts and over the clock", () => {
  const { compileScene, cleanTarget, BEACON_DEFAULTS } = require("../lib/matrix");
  const target = cleanTarget({ ...BEACON_DEFAULTS, timer: { enabled: true, entities: [T] } });
  assert.deepEqual(target.timer, { enabled: true, entities: [T], doneSeconds: 60 });
  const now = Date.parse("2026-10-13T18:05:00-07:00");
  const running = { entity: T, label: "Kitchen Timer", state: "running", endsAt: now + 16 * 60000 + 500, duration: 1200000 };
  const s = compileScene(target, {}, {}, now, () => null, [running]);
  assert.equal(s.kind, "countdown");
  assert.equal(s.title, "KITCHEN TIMER");
  assert.equal(s.endsAt, Math.round(running.endsAt / 1000));
  assert.equal(s.duration, 1200);
  assert.match(s.detail, /^DONE AT \d{1,2}:\d{2} [AP]M$/);
  assert.deepEqual(compileScene(target, {}, {}, now + 30000, () => null, [running]), s, "stable while running: no republish every tick");

  const paused = compileScene(target, {}, {}, now, () => null, [{ ...running, state: "paused", remaining: 754000 }]);
  assert.deepEqual([paused.remaining, paused.detail], [754, "PAUSED 12:34"]);
  const done = compileScene(target, {}, {}, now, () => null, [running, { ...running, entity: "timer.b", state: "done", until: now + 1 }]);
  assert.equal(done.state, "done", "a finished timer wins over a running one");

  const banner = { banner: { kind: "alert", text: "Water leak", until: now + 60000 } };
  assert.equal(compileScene(target, {}, banner, now, () => null, [running]).kind, "notification");
  assert.equal(compileScene(target, {}, {}, now, () => null, []).kind, "clock");
});
