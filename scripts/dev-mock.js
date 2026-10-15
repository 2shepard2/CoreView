// Local preview with fake Immich and Home Assistant (no lab secrets needed).
// FRIGATE_URL=http://frigate.local:5000 uses a real Frigate read-only;
// PROMETHEUS_URL=http://prometheus.local:9090 a real Prometheus (Terrarium).
//   node scripts/dev-mock.js            -> display :3296, studio :3297
// Sample photos are generated once into /tmp/cvs-dev-photos (needs python3 + PIL).
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createApp } = require("../server");

const photoDir = "/tmp/cvs-dev-photos";
if (!fs.existsSync(path.join(photoDir, "done"))) {
  fs.mkdirSync(photoDir, { recursive: true });
  execFileSync("python3", ["-c", `
from PIL import Image, ImageDraw, ImageFont
import colorsys, os
out = ${JSON.stringify(photoDir)}
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 90)
except Exception:
    font = ImageFont.load_default()
for i in range(8):
    w, h = (1440, 1080) if i % 3 else (1080, 1440)
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        r, g, b = colorsys.hsv_to_rgb((i / 8 + y / h * 0.25) % 1, 0.55, 0.35 + 0.45 * y / h)
        d.line([(0, y), (w, y)], fill=(int(r*255), int(g*255), int(b*255)))
    d.ellipse([w*0.55, h*0.1, w*0.9, h*0.1 + w*0.35], fill=(255, 230, 160))
    d.text((60, h - 180), "Sample photo %d" % (i + 1), fill=(255, 255, 255), font=font)
    img.save(os.path.join(out, "%d.jpg" % i), quality=82)
open(os.path.join(out, "done"), "w").write("ok")
`]);
}
const ALBUM = "0e1d2c3b-4a59-6877-8695-a4b3c2d1e0f0";
const photos = Array.from({ length: 8 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`, date: `20${15 + i}-0${(i % 9) + 1}-1${i}T12:00:00`,
  place: ["Lisbon, Portugal", "Banff, Canada", "Kyoto, Japan", null][i % 4], portrait: i % 3 === 0
}));
const immich = {
  configured: () => true,
  listAlbums: async () => [{ id: ALBUM, name: "Family Frame (sample)", count: photos.length, thumb: photos[1].id },
    { id: "1e1d2c3b-4a59-6877-8695-a4b3c2d1e0f0", name: "Grandma's Whiteboard (sample)", count: 0, thumb: null }],
  album: async (id) => (id === ALBUM ? photos : []),
  preview: async (id) => {
    const i = photos.findIndex((p) => p.id === id);
    return i < 0 ? null : { body: fs.readFileSync(path.join(photoDir, `${i}.jpg`)), type: "image/jpeg" };
  }
};

// Fake HA: live object for subscriptions + REST for the entity picker.
const states = {
  "weather.forecast_home": { state: "sunny", attributes: { friendly_name: "Forecast Home", temperature: 95, temperature_unit: "°F" } },
  "sensor.living_room_temperature": { state: "76.4", attributes: { friendly_name: "Living Room Temperature", unit_of_measurement: "°F", device_class: "temperature" } },
  "binary_sensor.front_door": { state: "off", attributes: { friendly_name: "Front Door", device_class: "door" } },
  "sensor.washer_status": { state: "Running", attributes: { friendly_name: "Washer" } },
  "sensor.openweathermap_temperature": { state: "96.4", attributes: { unit_of_measurement: "°F" } },
  "sensor.indoor_temperature_average": { state: "75.8", attributes: { unit_of_measurement: "°F" } },
  "input_text.coreview_alert_text": { state: "", attributes: {} },
  "input_text.coreview_notification_text": { state: "", attributes: {} },
  "input_text.coreview_marquee_text": { state: "", attributes: {} },
  // Household (V2.2 board widgets)
  "person.alex": { state: "home", attributes: { friendly_name: "Alex" }, last_changed: new Date(Date.now() - 50 * 60000).toISOString() },
  "person.jordan": { state: "not_home", attributes: { friendly_name: "Jordan" }, last_changed: new Date(Date.now() - 130 * 60000).toISOString() },
  "person.sam": { state: "School", attributes: { friendly_name: "Sam" }, last_changed: new Date(Date.now() - 300 * 60000).toISOString() },
  "person.riley": { state: "home", attributes: { friendly_name: "Riley" }, last_changed: new Date(Date.now() - 600 * 60000).toISOString() },
  "sun.sun": { state: "above_horizon", attributes: { friendly_name: "Sun", next_rising: new Date(Date.now() + 15 * 3600e3).toISOString(), next_setting: new Date(Date.now() + 4 * 3600e3).toISOString() } },
  "todo.shopping_list": { state: "3", attributes: { friendly_name: "Shopping List" } },
  "todo.sam_s_chores": { state: "2", attributes: { friendly_name: "Sam's chores" } },
  "todo.riley_s_chores": { state: "1", attributes: { friendly_name: "Riley's chores" } },
  "input_datetime.dogs_last_out": { state: "", attributes: { friendly_name: "Dogs last out" } },
  "input_number.dogs_out_reminder_minutes": { state: "90", attributes: { friendly_name: "Dogs reminder" } },
  "script.record_dogs_out": { state: "off", attributes: { friendly_name: "Record dogs out" } },
  "vacuum.gary": { state: "docked", attributes: { friendly_name: "Gary", battery_level: 100 } },
  "calendar.family": { state: "off", attributes: { friendly_name: "Family" } },
  "calendar.birthdays": { state: "off", attributes: { friendly_name: "Birthdays" } },
  "calendar.grandma": { state: "off", attributes: { friendly_name: "Grandma" } },
  "climate.living": { state: "cool", attributes: { friendly_name: "Living thermostat", current_temperature: 75 } },
  // Laundry (Status tile) and the garage door (status icons)
  "input_boolean.washer_active": { state: "on", attributes: { friendly_name: "Washer running" }, last_changed: new Date(Date.now() - 25 * 60000).toISOString() },
  "input_text.washer_status": { state: "Washing · about 20 min left", attributes: { friendly_name: "Washer status" } },
  "input_boolean.dryer_active": { state: "off", attributes: { friendly_name: "Dryer running" } },
  "input_text.dryer_status": { state: "", attributes: { friendly_name: "Dryer status" } },
  "binary_sensor.garage_door": { state: "off", attributes: { friendly_name: "Garage Door", device_class: "garage_door" } }
};
{ // dogs went out 70 minutes ago (house-local, no offset, like HA)
  const d = new Date(Date.now() - 70 * 60000), p = (n) => String(n).padStart(2, "0");
  states["input_datetime.dogs_last_out"].state = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
const lists = {
  "todo.shopping_list": [{ uid: "s1", summary: "Milk", status: "needs_action" }, { uid: "s2", summary: "Bananas", status: "needs_action" }, { uid: "s3", summary: "Dog food", status: "needs_action" }],
  "todo.sam_s_chores": [{ uid: "k1", summary: "Litter box", status: "needs_action" }, { uid: "k2", summary: "Unload dishwasher", status: "completed" }, { uid: "k3", summary: "Feed cat", status: "needs_action" }],
  "todo.riley_s_chores": [{ uid: "c1", summary: "Trash to the curb", status: "needs_action" }]
};
const dayIso = (n, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d; };
const localStr = (d) => { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };
const dateStr = (d) => localStr(d).slice(0, 10);
const calendars = {
  "calendar.family": [
    { uid: "e1", summary: "Soccer practice", start: { dateTime: dayIso(0, 17, 30).toISOString() }, end: { dateTime: dayIso(0, 18, 30).toISOString() } },
    { uid: "e2", summary: "Trash night", rrule: "FREQ=WEEKLY", recurrence_id: "20261010", start: { dateTime: dayIso(0, 19).toISOString() }, end: { dateTime: dayIso(0, 20).toISOString() } },
    { uid: "e3", summary: "Dentist (Riley)", start: { dateTime: dayIso(1, 9).toISOString() }, end: { dateTime: dayIso(1, 10).toISOString() } },
    { uid: "e4", summary: "Grandparents visit", start: { date: dateStr(dayIso(3, 0)) }, end: { date: dateStr(dayIso(5, 0)) } },
    { uid: "e5", summary: "School pictures", start: { dateTime: dayIso(9, 8).toISOString() }, end: { dateTime: dayIso(9, 9).toISOString() } }
  ],
  "calendar.grandma": [
    { uid: "g1", summary: "Hair appt", start: { dateTime: dayIso(0, 10, 30).toISOString() }, end: { dateTime: dayIso(0, 11, 30).toISOString() } },
    { uid: "g2", summary: "Book club", start: { dateTime: dayIso(0, 18).toISOString() }, end: { dateTime: dayIso(0, 19).toISOString() } },
    { uid: "g3", summary: "Dr. Patel", start: { dateTime: dayIso(2, 9, 15).toISOString() }, end: { dateTime: dayIso(2, 10, 15).toISOString() } }
  ],
  "calendar.birthdays": [{ uid: "b1", summary: "Max's birthday", rrule: "FREQ=YEARLY", recurrence_id: "x", start: { date: dateStr(dayIso(12, 0)) }, end: { date: dateStr(dayIso(13, 0)) } }]
};
const calls = []; // what the screen asked Home Assistant to do (the smoke test reads /dev/calls)
const bus = new EventEmitter();
const hass = {
  states, connected: true, on: bus.on.bind(bus), stop() {},
  async calendar(entity, start, end) {
    return (calendars[entity] || []).filter((e) => (e.end.dateTime || e.end.date + "T00:00") > start && (e.start.dateTime || e.start.date + "T00:00") < end);
  },
  async command(p) {
    calls.push(p);
    if (p.type === "calendar/event/create") {
      const e = p.event, allDay = !String(e.dtstart).includes("T");
      (calendars[p.entity_id] = calendars[p.entity_id] || []).push({ uid: "n" + calls.length, summary: e.summary, rrule: e.rrule,
        start: allDay ? { date: e.dtstart } : { dateTime: new Date(e.dtstart).toISOString() }, end: allDay ? { date: e.dtend } : { dateTime: new Date(e.dtend).toISOString() } });
    }
    if (p.type === "calendar/event/delete") calendars[p.entity_id] = (calendars[p.entity_id] || []).filter((e) => e.uid !== p.uid);
    return null;
  },
  async callService(domain, service, data, returnResponse) {
    calls.push({ domain, service, data });
    const id = data.entity_id;
    if (domain === "todo" && service === "get_items") return { [id]: { items: lists[id] || [] } };
    if (domain === "weather" && service === "get_forecasts") {
      const out = [];
      for (let i = 0; i < 24; i++) out.push({ datetime: new Date(Date.now() + i * 3600e3).toISOString(), temperature: 95 - Math.abs(i - 4) * 2, templow: 70, condition: "sunny", precipitation_probability: i === 7 ? 50 : 5 });
      return { [id]: { forecast: out } };
    }
    if (domain === "todo" && service === "add_item") { lists[id].push({ uid: "u" + calls.length, summary: data.item, status: "needs_action" }); states[id].state = String(lists[id].filter((x) => x.status !== "completed").length); bus.emit("change", [id]); }
    if (domain === "todo" && service === "update_item") { const it = lists[id].filter((x) => x.uid === data.item)[0]; if (it) it.status = data.status; states[id].state = String(lists[id].filter((x) => x.status !== "completed").length); bus.emit("change", [id]); }
    if (domain === "script" && id === "script.record_dogs_out") {
      const d = new Date(), p = (n) => String(n).padStart(2, "0");
      states["input_datetime.dogs_last_out"].state = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
      bus.emit("change", ["input_datetime.dogs_last_out"]);
    }
    if (domain === "vacuum") { states[id].state = service === "start" ? "cleaning" : "returning"; bus.emit("change", [id]); }
    return returnResponse ? {} : null;
  },
  async rest() { return { ok: false, status: 404, headers: new Map() }; }
};
setInterval(() => {
  states["sensor.living_room_temperature"].state = (74 + Math.random() * 4).toFixed(1);
  states["binary_sensor.front_door"].state = Math.random() < 0.3 ? "on" : "off";
  bus.emit("change", ["sensor.living_room_temperature", "binary_sensor.front_door"]);
}, 5000);
// Fake Matrix: an in-process MQTT stand-in whose "Beacon" heartbeats and acks.
const mbus = new EventEmitter();
const mqtt = {
  connected: true, on: mbus.on.bind(mbus), subscribe() {}, start() { setTimeout(() => mbus.emit("status", true), 50); }, stop() {},
  publish(topic, payload) {
    const body = JSON.parse(payload);
    setTimeout(() => mbus.emit("message", topic.replace(/state$/, "ack"), Buffer.from(JSON.stringify({ revision: body.revision, ok: true }))), 100);
    return true;
  }
};
const beat = () => mbus.emit("message", "home/signage/matrix/coreview-beacon/status", Buffer.from(JSON.stringify({ online: true, width: 96, height: 32, features: ["clock"] })));
setTimeout(beat, 200); setInterval(beat, 30000);
const haRest = http.createServer((req, res) => {
  if (req.url === "/dev/calls") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(calls)); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(Object.entries(states).map(([entity_id, s]) => ({ entity_id, ...s }))));
}).listen(0, "127.0.0.1");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvs-dev-"));
fs.writeFileSync(path.join(dir, "ha_token"), "fake");
fs.writeFileSync(path.join(dir, "agent_token"), "dev-agent-token");
fs.writeFileSync(path.join(dir, "setup_code"), "dev-setup");
haRest.on("listening", () => {
  const app = createApp({
    DATA_DIR: process.env.DATA_DIR || dir, COOKIE_SECURE: "0", MQTT_URL: "mqtt://fake", FRIGATE_URL: process.env.FRIGATE_URL || "", PROMETHEUS_URL: process.env.PROMETHEUS_URL || "",
    HA_URL: `http://127.0.0.1:${haRest.address().port}`, HA_TOKEN_FILE: path.join(dir, "ha_token"), AGENT_TOKEN_FILE: path.join(dir, "agent_token"), SETUP_CODE_FILE: path.join(dir, "setup_code")
  }, { immich, hass, mqtt, ...(process.env.FRIGATE_URL ? {} : { overlays: { start() { return this; }, stop() {}, listCameras: async () => [{ name: "front_entry", zones: [] }, { name: "driveway", zones: ["property"] }], latestFrame: async () => immich.preview(photos[2].id) } }) }).start();
  const dp = Number(process.env.DISPLAY_PORT || 3296), ap = Number(process.env.ADMIN_PORT || 3297);
  http.createServer(app.displayHandler).listen(dp, "127.0.0.1");
  http.createServer(app.adminHandler).listen(ap, "127.0.0.1", () => console.log(`display http://127.0.0.1:${dp}  studio http://127.0.0.1:${ap}  album ${ALBUM}  data ${dir}  calls http://127.0.0.1:${haRest.address().port}/dev/calls`));
});
