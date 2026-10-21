// Matrix: V1 parity for scenes, payloads, controls, message triggers, revisions,
// and the MQTT wire format.
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const m = require("../lib/matrix");
const { parse, packet, remaining, topicMatches, decodePublish, T } = require("../lib/mqtt");

function memStore(data) {
  return { data, update(fn) { return fn(this.data); } };
}
function fakeMqtt() {
  const bus = new EventEmitter();
  return {
    connected: true, sent: [], subs: [],
    on: bus.on.bind(bus), emit: bus.emit.bind(bus),
    subscribe(f) { this.subs.push(f); }, start() {}, stop() {},
    publish(topic, payload, opts) { this.sent.push({ topic, body: JSON.parse(payload), opts }); return true; }
  };
}
const at = (h, min = 0) => new Date(2026, 9, 9, h, min).getTime();
// An example household's Matrix settings (the shipped defaults have no teams).
const EXAMPLE = {
  clockTitle: "Out:{{sensor.openweathermap_temperature.state | round(0)}} In:{{sensor.indoor_temperature_average.state | round(0)}}",
  sports: { ...m.BEACON_DEFAULTS.sports, teams: [["sensor.nfl_denver_broncos", "Broncos"], ["sensor.nba_boston_celtics", "Celtics"]]
    .map(([entityId, name]) => ({ entityId, name, enabled: true })) }
};
function setup({ live = true, states = {}, clock = at(12), logos = { get: () => null } } = {}) {
  const target = m.cleanTarget({ ...m.BEACON_DEFAULTS, ...EXAMPLE, live });
  const store = memStore({ matrix: { targets: { [target.id]: target } } });
  const mqtt = fakeMqtt();
  let now = clock;
  const changes = [];
  const mx = m.createMatrix({ store, mqtt, states: () => states, now: () => now, onChange: (id, s) => changes.push(s), logos });
  mx.start();
  mx.stop(); // stops the tick timer; handlers stay attached
  return { mx, store, mqtt, states, changes, id: target.id, tick: (ms) => { now += ms; }, setNow: (t) => { now = t; } };
}
const H = (state, attributes = {}) => ({ state, attributes, last_changed: new Date(at(12)).toISOString() });

test("clock scene renders a Home Assistant template", () => {
  const s = setup({ states: { "sensor.openweathermap_temperature": H("72.6"), "sensor.indoor_temperature_average": H("75.2") } });
  const last = s.mqtt.sent.at(-1).body;
  assert.equal(last.scene.kind, "clock");
  assert.equal(last.scene.title, "Out:73 In:75");
  assert.equal(last.schema, "coreview.matrix.state.v1");
  assert.equal(s.mqtt.sent.at(-1).topic, "home/signage/matrix/coreview-beacon/state");
  assert.deepEqual(s.mqtt.sent.at(-1).opts, { qos: 1, retain: true });
});

test("payload matches V1 shape: display carries config + controls, control brightness overrides the theme", () => {
  const s = setup();
  const p = s.mqtt.sent.at(-1).body;
  assert.deepEqual(Object.keys(p), ["schema", "target", "revision", "issuedAt", "display", "theme", "controls", "scene"]);
  assert.deepEqual(p.display, { width: 96, height: 32, colorDepth: 4, rotation: 0, features: ["clock", "status", "notification", "ticker", "icons"], controls: p.controls });
  assert.equal(p.theme.brightness, 51); // controls.brightness 20% of 255
  assert.equal(p.theme.primary, "#ae00ff"); // noon = Day theme
});

test("theme schedule: day 06:00, evening 17:00, overnight 20:30, wraps past midnight", () => {
  const themes = m.cleanTarget(m.BEACON_DEFAULTS).themes;
  assert.equal(m.themeAt(themes, new Date(at(5, 59))).name, "Overnight");
  assert.equal(m.themeAt(themes, new Date(at(6))).name, "Day");
  assert.equal(m.themeAt(themes, new Date(at(17, 1))).name, "Evening");
  assert.equal(m.themeAt(themes, new Date(at(23))).name, "Overnight");
});

test("unchanged scenes are not republished; revisions only go up", () => {
  const s = setup();
  const n = s.mqtt.sent.length;
  s.mx.refreshAll();
  s.mx.refreshAll();
  assert.equal(s.mqtt.sent.length, n);
  s.setNow(at(18));
  s.mx.refreshAll();
  assert.equal(s.mqtt.sent.length, n + 1);
  assert.equal(s.mqtt.sent.at(-1).body.revision, s.mqtt.sent.at(-2).body.revision + 1);
});

test("alert helper fires on change to non-empty, shows for its seconds, honours cooldown", () => {
  const states = { "input_text.coreview_alert_text": H("") };
  const s = setup({ states });
  s.mx.onStates(["input_text.coreview_alert_text"]); // first sighting never fires
  states["input_text.coreview_alert_text"] = H("Garage open");
  s.mx.onStates(["input_text.coreview_alert_text"]);
  let p = s.mqtt.sent.at(-1).body;
  assert.equal(p.scene.kind, "notification");
  assert.equal(p.scene.severity, "critical");
  assert.equal(p.scene.icon, "warning");
  assert.equal(p.scene.flashBorder, true);
  assert.equal(p.scene.title, "Garage open");
  s.tick(91000);
  s.mx.refreshAll();
  assert.equal(s.mqtt.sent.at(-1).body.scene.kind, "clock");
  // HA clears and re-sets within the 30 s cooldown of the *last fire*: here 91 s later, so it fires.
  states["input_text.coreview_alert_text"] = H("");
  s.mx.onStates(["input_text.coreview_alert_text"]);
  states["input_text.coreview_alert_text"] = H("Again");
  s.mx.onStates(["input_text.coreview_alert_text"]);
  assert.equal(s.mqtt.sent.at(-1).body.scene.title, "Again");
  // A new text within 30 s of the last fire is dropped (V1 cooldown); the first message stays.
  s.tick(10000);
  states["input_text.coreview_alert_text"] = H("Third");
  s.mx.onStates(["input_text.coreview_alert_text"]);
  assert.equal(s.mqtt.sent.at(-1).body.scene.title, "Again");
});

test("clearing the helper does not cut a message short (V1 froze the text when it fired)", () => {
  const states = { "input_text.coreview_notification_text": H("") };
  const s = setup({ states });
  s.mx.onStates(["input_text.coreview_notification_text"]);
  states["input_text.coreview_notification_text"] = H("Dogs need water");
  s.mx.onStates(["input_text.coreview_notification_text"]);
  assert.equal(s.mqtt.sent.at(-1).body.scene.severity, "warning");
  states["input_text.coreview_notification_text"] = H("");
  s.mx.onStates(["input_text.coreview_notification_text"]);
  assert.equal(s.mqtt.sent.at(-1).body.scene.title, "Dogs need water");
  s.tick(61000);
  s.mx.refreshAll();
  assert.equal(s.mqtt.sent.at(-1).body.scene.kind, "clock");
});

test("marquee becomes the ticker on the clock", () => {
  const states = { "input_text.coreview_marquee_text": H("") };
  const s = setup({ states });
  s.mx.onStates(["input_text.coreview_marquee_text"]);
  states["input_text.coreview_marquee_text"] = H("Dad is home");
  s.mx.onStates(["input_text.coreview_marquee_text"]);
  assert.deepEqual(s.mqtt.sent.at(-1).body.scene.ticker, { message: "Dad is home" });
});

test("control card: Beacon 2.0 effects accept their ESPHome labels", () => {
  const base = m.cleanControls({});
  const want = { "Fireworks": "fireworks", "Lava Lamp": "lava", "Life": "life", "Ripples": "ripples", "Pong": "pong" };
  for (const [label, effect] of Object.entries(want)) {
    const r = m.applyControl(base, "effect", label);
    assert.equal(r.ok, true, label);
    assert.equal(r.controls.effect, effect);
    assert.equal(m.cleanControls(r.controls).effect, effect);
  }
});

test("control card: Lights mode, Stars alias, refusals; persisted and republished", () => {
  const s = setup();
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/control", Buffer.from(JSON.stringify({ schema: "coreview.matrix.control.v1", control: "mode", value: "Lights" })));
  let p = s.mqtt.sent.at(-1).body;
  assert.equal(p.scene.kind, "effect");
  assert.equal(p.scene.effect, "fire");
  assert.equal(p.scene.speed, 16);
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/control", Buffer.from(JSON.stringify({ control: "effect", value: "Stars" })));
  assert.equal(s.mqtt.sent.at(-1).body.scene.effect, "starfield");
  assert.equal(s.store.data.matrix.targets[s.id].controls.effect, "starfield");
  assert.equal(m.applyControl(m.cleanControls({}), "effect", "laser").ok, false);
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/control", Buffer.from(JSON.stringify({ control: "mode", value: "Music" })));
  p = s.mqtt.sent.at(-1).body;
  assert.equal(p.scene.kind, "music");
  assert.equal(p.scene.mode, "local_pulse_rings");
  assert.equal(p.scene.palette, "neon");
  // HA's select labels ("Ridgeline", "Mix") map onto the Beacon 2.2 modes.
  for (const [label, mode] of [["Ridgeline", "ridgeline"], ["Inferno", "inferno"], ["Mix", "mix"], ["Bars", "bars"], ["Warp", "warp"]]) {
    s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/control", Buffer.from(JSON.stringify({ control: "audio_mode", value: label })));
    assert.equal(s.mqtt.sent.at(-1).body.scene.mode, `local_${mode}`);
  }
  assert.equal(m.applyControl(m.cleanControls({}), "audio_mode", "laser").ok, false);
});

test("an alert beats Lights mode", () => {
  const states = { "input_text.coreview_alert_text": H("") };
  const s = setup({ states });
  s.mx.control(s.id, "mode", "lights");
  s.mx.onStates(["input_text.coreview_alert_text"]);
  states["input_text.coreview_alert_text"] = H("Water leak");
  s.mx.onStates(["input_text.coreview_alert_text"]);
  assert.equal(s.mqtt.sent.at(-1).body.scene.kind, "notification");
});

test("sports: a live watched game takes over the clock with a scoreboard", () => {
  const states = { "sensor.nfl_denver_broncos": H("IN", { team_abbr: "DEN", opponent_abbr: "KC", team_score: 17, opponent_score: 14,
    team_homeaway: "home", quarter: 3, clock: "4:12", event_id: "1", league: "NFL", sport: "football" }) };
  const s = setup({ states });
  s.mx.refreshAll();
  const sc = s.mqtt.sent.at(-1).body.scene;
  assert.equal(sc.kind, "scoreboard");
  // Away team (KC) in the left slot, home team (DEN) in the right slot.
  assert.equal(sc.homeLabel, "KC");
  assert.equal(sc.homeScore, "14");
  assert.equal(sc.guestLabel, "DEN");
  assert.equal(sc.guestScore, "17");
  assert.equal(sc.period, "Q3");
  assert.equal(sc.remainingTime, "4:12");
  assert.equal(s.store.data.matrix.targets[s.id].sportsSelection.entityId, "sensor.nfl_denver_broncos");
});

test("sports: logos go with their team (away left), in the smaller size for three-digit scores", () => {
  const grids = { "https://x/kc.png": { 18: "KC18", 15: "KC15" }, "https://x/den.png": { 18: "DEN18", 15: "DEN15" } };
  const game = (homeScore) => ({ "sensor.nfl_denver_broncos": H("IN", { team_abbr: "DEN", opponent_abbr: "KC", team_score: homeScore, opponent_score: 14,
    team_homeaway: "home", team_logo: "https://x/den.png", opponent_logo: "https://x/kc.png", team_colors: ["#0a2343", "#fc4c02"],
    opponent_colors: ["#e31837", "#ffb612"], quarter: 3, clock: "4:12", event_id: "1", league: "NFL", sport: "football" }) });
  let s = setup({ states: game(17), logos: { get: (u) => grids[u] || null } });
  s.mx.refreshAll();
  let sc = s.mqtt.sent.at(-1).body.scene;
  assert.equal(sc.leftLogo, "KC18");
  assert.equal(sc.rightLogo, "DEN18");
  assert.equal(sc.leftColor, "#e31837");
  assert.equal(sc.rightColor, "#fc4c02"); // navy is too dark for the dot
  s = setup({ states: game(104), logos: { get: (u) => grids[u] || null } });
  s.mx.refreshAll();
  sc = s.mqtt.sent.at(-1).body.scene;
  assert.equal(sc.rightLogo, "DEN15");
  assert.equal(sc.guestScore, "104");
});

test("shadow mode publishes nothing, ignores the control card, and tracks V1's revision", () => {
  const s = setup({ live: false });
  assert.equal(s.mqtt.sent.length, 0);
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/state", Buffer.from(JSON.stringify({ revision: 1932822, scene: { kind: "clock", title: "Out:73 In:75" }, theme: {}, controls: {} })));
  assert.equal(s.store.data.matrix.targets[s.id].revision, 1932822);
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/control", Buffer.from(JSON.stringify({ control: "mode", value: "lights" })));
  assert.equal(s.store.data.matrix.targets[s.id].controls.mode, "display");
  // ...but follows the controls V1 publishes.
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/state", Buffer.from(JSON.stringify({ revision: 1932823, scene: { kind: "effect" }, controls: { mode: "lights", effect: "plasma", brightness: 30 } })));
  assert.equal(s.store.data.matrix.targets[s.id].controls.effect, "plasma");
  assert.equal(s.store.data.matrix.targets[s.id].controls.brightness, 30);
  const sum = s.mx.summary(s.id);
  assert.equal(sum.observed.revision, 1932823);
  assert.equal(sum.scene.kind, "effect");
});

test("going live publishes above the retained revision", () => {
  const s = setup({ live: false });
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/state", Buffer.from(JSON.stringify({ revision: 500, scene: {} })));
  s.store.data.matrix.targets[s.id].live = true;
  s.mx.refresh(s.id, { force: true });
  assert.equal(s.mqtt.sent.at(-1).body.revision, 501);
});

test("status heartbeat marks the Beacon online; stale after 90 s", () => {
  const s = setup();
  s.mqtt.emit("message", "home/signage/matrix/coreview-beacon/status", Buffer.from(JSON.stringify({ online: true, width: 96, height: 32, features: ["clock"] })));
  assert.equal(s.mx.summary(s.id).online, true);
  s.tick(91000);
  assert.equal(s.mx.summary(s.id).online, false);
});

test("settings are validated", () => {
  const t = m.cleanTarget({ themes: [{ at: "25:00", primary: "red", brightness: 999 }], messages: { alert: { entity: "bad entity", seconds: 1 } } }, m.cleanTarget(m.BEACON_DEFAULTS));
  assert.equal(t.themes[0].at, "00:00");
  assert.equal(t.themes[0].primary, "#e6e8ed");
  assert.equal(t.themes[0].brightness, 255);
  assert.equal(t.messages.alert.entity, "input_text.coreview_alert_text");
  assert.equal(t.messages.alert.seconds, 5);
  assert.equal(t.id, "coreview-beacon");
});

test("mqtt: remaining length, packet framing, topic filters, publish decode", () => {
  assert.deepEqual([...remaining(0)], [0]);
  assert.deepEqual([...remaining(127)], [127]);
  assert.deepEqual([...remaining(128)], [128, 1]);
  assert.deepEqual([...remaining(16383)], [255, 127]);
  const body = Buffer.concat([Buffer.from([0, 3]), Buffer.from("a/b"), Buffer.from([0, 7]), Buffer.from("hello")]);
  const raw = packet(T.PUBLISH, 0b0011, body);
  const [pk, rest] = parse(Buffer.concat([raw, raw.subarray(0, 3)]));
  assert.equal(pk.length, 1);
  assert.equal(rest.length, 3);
  const msg = decodePublish(pk[0]);
  assert.deepEqual([msg.topic, msg.qos, msg.id, msg.retain, msg.payload.toString()], ["a/b", 1, 7, true, "hello"]);
  assert.ok(topicMatches("home/signage/matrix/+/status", "home/signage/matrix/coreview-beacon/status"));
  assert.ok(!topicMatches("home/signage/matrix/+/status", "home/signage/matrix/x/ack"));
  assert.ok(topicMatches("home/#", "home/a/b"));
});

test("play: a sign in its colour, then back to the regular program after the idle time", () => {
  const { mx, mqtt, id, tick } = setup({ states: { "sensor.openweathermap_temperature": H("88") } });
  const r = mx.play(id, { style: "sign", line1: "Hi Mom ❤️", line2: "love Amara", color: "#ff4fc3", brightness: "bright" }, 5 * 60000);
  assert.ok(r.ok);
  let last = mqtt.sent.at(-1).body;
  assert.equal(last.scene.kind, "message");
  assert.equal(last.scene.title, "Hi Mom");           // emoji dropped: the panel font is ASCII
  assert.equal(last.scene.detail, "love Amara");
  assert.equal(last.theme.primary, "#ff4fc3");
  assert.equal(last.theme.brightness, 140);
  assert.equal(mx.summary(id).play.style, "sign");
  // Another tap restarts the clock.
  tick(4 * 60000);
  mx.play(id, { style: "bounce", line1: "AMARA", palette: "ocean" }, 5 * 60000);
  last = mqtt.sent.at(-1).body;
  assert.equal(last.scene.kind, "effect");
  assert.equal(last.scene.effect, "bouncing_text");
  assert.equal(last.scene.text, "AMARA");
  assert.equal(last.scene.palette, "ocean");
  tick(4 * 60000);
  mx.refresh(id);
  assert.equal(mqtt.sent.at(-1).body.scene.kind, "effect");
  tick(61000);
  mx.refresh(id);
  last = mqtt.sent.at(-1).body;
  assert.equal(last.scene.kind, "clock");
  assert.notEqual(last.theme.primary, "#ff4fc3");
  assert.equal(mx.summary(id).play, null);
});

test("play: effects, refusals, an alert still wins, and Back to normal", () => {
  const { mx, mqtt, id, states, tick } = setup();
  assert.equal(mx.play(id, { style: "sign", line1: "  ", line2: "" }, 60000).ok, false);
  assert.ok(mx.play(id, { style: "effect", effect: "fireworks", palette: "party" }, 60000).ok);
  assert.equal(mqtt.sent.at(-1).body.scene.effect, "fireworks");
  assert.equal(m.cleanPlay({ style: "effect", effect: "nope" }).effect, "rainbow_waves");
  assert.equal(m.cleanPlay({ style: "sign", line1: "x", color: "#123456" }).color, "#ffffff");
  states["input_text.coreview_alert_text"] = H("");
  mx.onStates(["input_text.coreview_alert_text"]);
  tick(1000);
  states["input_text.coreview_alert_text"] = H("Leak in the laundry");
  mx.onStates(["input_text.coreview_alert_text"]);
  assert.equal(mqtt.sent.at(-1).body.scene.kind, "notification");
  mx.endPlay(id);
  assert.equal(mx.summary(id).play, null);
});
