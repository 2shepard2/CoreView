// Bedroom matrix: scene priorities, quiet hours, washer detection, event memory and DDP frames.
const test = require("node:test");
const assert = require("node:assert");
const M = require("../lib/minimatrix");
const mini = require("../public/minimatrix");

const at = (h, m = 0) => new Date(2026, 9, 10, h, m, 0).getTime();
// An example household (the shipped defaults have nothing configured).
const HOUSE = {
  host: "192.0.2.1", enabled: true,
  people: [{ entityId: "person.alex", label: "ALEX", color: "#3a8dff" }, { entityId: "person.sam", label: "SAM", color: "#b36bff" }],
  doors: [{ entityId: "binary_sensor.back_door", kind: "door", letter: "B" }, { entityId: "binary_sensor.front_door", kind: "door", letter: "F" },
    { entityId: "binary_sensor.garage_door", kind: "garage", letter: "GRGE" }],
  cameras: [{ entityId: "binary_sensor.yard_person_occupancy", label: "YARD" }, { entityId: "binary_sensor.driveway_person_occupancy", label: "DRVE" }],
  dogs: { enabled: true, lastOut: "input_datetime.dogs_last_out", minutes: "input_number.dogs_out_minutes", from: "07:00", to: "22:00" },
  laundry: { enabled: true, runMinutes: 15, quietMinutes: 12, showMinutes: 120, machines: [
    { entity: "binary_sensor.washer_moving", kind: "washer" }, { entity: "binary_sensor.dryer_moving", kind: "dryer" }] }
};
const T = () => M.cleanTarget({ ...M.BEDROOM_DEFAULTS, ...HOUSE });
const rt = () => ({ messages: {}, arrivals: {}, cameraUntil: {}, laundry: {} });
const S = (state, extra = {}) => ({ state, last_changed: new Date(at(12)).toISOString(), ...extra });

test("decide: alert beats camera beats door beats dogs; nothing = null", () => {
  const t = T(), now = at(12, 5);
  const states = { "binary_sensor.back_door": S("on", { last_changed: new Date(at(12)).toISOString() }) };
  assert.deepEqual(M.decide(t, states, rt(), now).scene, { kind: "door", letter: "B" });
  states["binary_sensor.yard_person_occupancy"] = S("on");
  assert.deepEqual(M.decide(t, states, rt(), now).scene, { kind: "camera", label: "YARD" });
  const r = rt(); r.messages.alert = { text: "Water leak", until: now + 1000 };
  assert.equal(M.decide(t, states, r, now).scene.kind, "alert");
  assert.equal(M.decide(t, {}, rt(), now).scene, null);
});

test("decide: doors stop showing after the limit; garage uses its own icon", () => {
  const t = T();
  const states = { "binary_sensor.garage_door": S("on", { last_changed: new Date(at(12)).toISOString() }) };
  assert.deepEqual(M.decide(t, states, rt(), at(12, 10)).scene, { kind: "garage", label: "GRGE" });
  assert.equal(M.decide(t, states, rt(), at(12, 16)).scene, null);
});

test("decide: quiet hours keep only alerts and cameras", () => {
  const t = T();
  const states = { "binary_sensor.front_door": S("on", { last_changed: new Date(at(22, 59)).toISOString() }) };
  const night = M.decide(t, states, rt(), at(23));
  assert.equal(night.scene, null);
  assert.equal(night.quiet, true);
  states["binary_sensor.driveway_person_occupancy"] = S("on");
  assert.equal(M.decide(t, states, rt(), at(23)).scene.kind, "camera");
  assert.equal(M.within(at(5, 59), "21:00", "06:00"), true);
  assert.equal(M.within(at(6), "21:00", "06:00"), false);
});

test("decide: dogs need out once the last outing is older than the reminder, daytime only", () => {
  const t = T();
  const states = { "input_datetime.dogs_last_out": S("x", { attributes: { timestamp: at(10) / 1000 } }),
    "input_number.dogs_out_minutes": S("90.0") };
  assert.equal(M.decide(t, states, rt(), at(11)).scene, null);
  assert.deepEqual(M.decide(t, states, rt(), at(11, 31)).scene, { kind: "dogs" });
  t.quiet.enabled = false;
  assert.equal(M.decide(t, states, rt(), at(22, 30)).scene, null); // outside 07:00-22:00
});

test("laundry: the 10-07 wash is done 12 minutes after the shaking stops; a bump clears it", () => {
  const cfg = T().laundry;
  // Real Z2M history 2026-10-07 (on/off minutes after 13:29): one 43 min run, then 50 s pulses every 5 min.
  const events = [[0, 1], [42.8, 0], [46.8, 1], [47.6, 0], [51.8, 1], [52.8, 0], [56.8, 1], [57.6, 0], [61.8, 1], [62.6, 0],
    [66.8, 1], [67.6, 0], [71.8, 1], [72.6, 0], [76.8, 1], [77.8, 0]];
  const t0 = at(13, 29);
  let s = {};
  for (const [m, on] of events) s = M.laundryStep(s, cfg, { on: on === 1, now: t0 + m * 60000 });
  s = M.laundryStep(s, cfg, { now: t0 + 85 * 60000 });
  assert.equal(s.phase, "idle"); // only 7 quiet minutes
  s = M.laundryStep(s, cfg, { now: t0 + 90 * 60000 });
  assert.equal(s.phase, "done");
  s = M.laundryStep(s, cfg, { on: true, now: t0 + 100 * 60000 }); // unloading bumps the sensor
  assert.equal(s.phase, "idle");
  // A lone 40 s bump at 2 AM is never a load.
  let lone = M.laundryStep({}, cfg, { on: true, now: at(2) });
  lone = M.laundryStep(lone, cfg, { on: false, now: at(2) + 40000 });
  lone = M.laundryStep(lone, cfg, { now: at(3) });
  assert.equal(lone.phase, "idle");
});

test("laundry: the dryer's anti-wrinkle pulses neither delay nor hold 'done'; the door clears it", () => {
  const cfg = T().laundry, kind = "dryer";
  // Real Z2M history 2026-10-19 (minutes after 18:51:49): a 38 min run, ~1 min pulses every 5 min,
  // a 2 min bump out of step at 77.4 (the door), then nothing.
  const events = [[0, 1], [38.5, 0], [40.0, 1], [41.7, 0], [45.7, 1], [46.7, 0], [50.7, 1], [51.7, 0], [55.7, 1], [56.7, 0],
    [60.7, 1], [61.7, 0], [63.6, 1], [64.3, 0], [65.7, 1], [66.7, 0], [70.7, 1], [71.7, 0], [77.4, 1], [79.3, 0]];
  const t0 = at(18, 51);
  const run = (until) => { // like Studio: sensor changes plus a re-check every second
    let s = {}, i = 0;
    for (let ms = 0; ms <= until * 60000; ms += 1000) {
      while (i < events.length && events[i][0] * 60000 <= ms) s = M.laundryStep(s, cfg, { on: events[i][1] === 1, now: t0 + events[i++][0] * 60000, kind });
      s = M.laundryStep(s, cfg, { now: t0 + ms, kind });
    }
    return s;
  };
  assert.equal(run(50).phase, "idle"); // 11.5 min after the run
  assert.equal(run(51).phase, "done"); // 12 min after the run, pulses or not
  assert.equal(run(72).phase, "done"); // pulses don't clear it
  assert.equal(run(86).phase, "done"); // 6.7 min after the door bump
  assert.equal(run(87).phase, "idle"); // 7 still minutes: the door was opened
  // The next load (the drum turning longer than a pulse) clears it too.
  const s = M.laundryStep(run(58), cfg, { on: true, now: t0 + 58 * 60000, kind });
  assert.equal(M.laundryStep(s, cfg, { now: t0 + 59.5 * 60000, kind }).phase, "done");
  assert.equal(M.laundryStep(s, cfg, { now: t0 + 60.5 * 60000, kind }).phase, "idle");
  // The washer is unchanged: the same pulses keep pushing its "done" back.
  let w = {};
  for (const [m, on] of events) w = M.laundryStep(w, cfg, { on: on === 1, now: t0 + m * 60000 });
  assert.equal(M.laundryStep(w, cfg, { now: t0 + 51 * 60000 }).phase, "idle");
});

function harness(states, now) {
  const store = { data: { minimatrix: { targets: { "bedroom-matrix": T() } } }, update(fn) { return fn(this.data); } };
  const sent = [], changes = [];
  const socket = { send: (buf, port, host) => sent.push({ buf, port, host }) };
  const mx = M.createMiniMatrix({ store, states: () => states, now: () => now.t, socket, onChange: (id, s) => changes.push(s) });
  return { mx, sent, changes, store };
}

test("events: arrivals fire on a change to home, never on the first value seen", () => {
  const states = { "person.sam": S("not_home") }, now = { t: at(12) };
  const h = harness(states, now);
  h.mx.onStates(["person.sam"]); // first value: remembered only
  assert.equal(h.mx.summary("bedroom-matrix").scene, null);
  states["person.sam"] = S("home");
  h.mx.onStates(["person.sam"]);
  assert.deepEqual(h.mx.summary("bedroom-matrix").scene, { kind: "arrival", label: "SAM", color: "#b36bff" });
  now.t += 31000;
  h.mx.refresh("bedroom-matrix");
  assert.equal(h.mx.summary("bedroom-matrix").scene, null);
});

test("frames: DDP header, 768 bytes, sent only while a scene is up and the matrix is on", () => {
  const states = { "binary_sensor.back_door": S("on", { last_changed: new Date(at(12)).toISOString() }) }, now = { t: at(12, 1) };
  const h = harness(states, now);
  h.mx.refreshAll();
  h.mx.tick();
  assert.equal(h.sent.length, 1);
  const { buf, port, host } = h.sent[0];
  assert.equal(port, 4048); assert.equal(host, "192.0.2.1");
  assert.equal(buf[0], 0x41); assert.equal(buf.length, 10 + 768);
  assert.equal((buf[8] << 8) | buf[9], 768);
  h.store.data.minimatrix.targets["bedroom-matrix"].enabled = false;
  h.mx.tick();
  assert.equal(h.sent.length, 1);
  h.mx.test("bedroom-matrix", "laundry"); // a test plays even while off
  h.mx.tick();
  assert.equal(h.sent.length, 2);
});

test("summary keeps the settings intact (status goes in quietNow / laundryNow)", () => {
  const h = harness({}, { t: at(12) });
  const sum = h.mx.summary("bedroom-matrix");
  assert.deepEqual(sum.laundry, h.store.data.minimatrix.targets["bedroom-matrix"].laundry);
  assert.deepEqual(sum.quiet, h.store.data.minimatrix.targets["bedroom-matrix"].quiet);
  assert.deepEqual(sum.laundryNow, { washer: "idle", dryer: "idle" });
  // Saving what the card shows must not lose anything.
  assert.deepEqual(M.cleanTarget(sum, h.store.data.minimatrix.targets["bedroom-matrix"]).laundry.machines.length, 2);
});

test("frames: rotation and flips move the top-left LED", () => {
  const states = {}, now = { t: at(12) };
  const h = harness(states, now);
  const t = h.store.data.minimatrix.targets["bedroom-matrix"];
  const dot = { kind: "door", letter: "B" };
  const lit = (buf) => { const out = new Set(); for (let i = 0; i < 256; i++) if (buf[i * 3] || buf[i * 3 + 1] || buf[i * 3 + 2]) out.add(i); return out; };
  const plain = lit(h.mx.frame("bedroom-matrix", dot, 0));
  t.flipX = true;
  const flipped = lit(h.mx.frame("bedroom-matrix", dot, 0));
  for (const i of plain) assert.ok(flipped.has(Math.floor(i / 16) * 16 + (15 - (i % 16))));
});

test("laundry: washer and dryer are tracked separately; shipped defaults configure nothing", () => {
  const t = T();
  assert.deepEqual(t.laundry.machines.map((m) => m.kind), ["washer", "dryer"]);
  const fresh = M.cleanTarget(M.BEDROOM_DEFAULTS);
  assert.deepEqual([fresh.host, fresh.enabled, fresh.people.length, fresh.doors.length, fresh.laundry.machines.length], ["", false, 0, 0, 0]);
  const r = rt(); r.laundry["binary_sensor.dryer_moving"] = { phase: "done", doneAt: at(12) };
  assert.deepEqual(M.decide(t, {}, r, at(12, 5)).scene, { kind: "laundry", machine: "dryer" });
});

test("renderer: every sample scene lights something inside the 16x16", () => {
  for (const [k, scene] of Object.entries(mini.SAMPLES)) {
    let n = 0;
    mini.render(scene, 500, (x, y) => { assert.ok(x >= 0 && x < 16 && y >= 0 && y < 16, k); n++; });
    assert.ok(n > 20, k);
  }
});
