// A fuller made-up family for scripts/dev-mock.js, for demos and videos:
// pictures for everyone, a busy month of calendars, a fake Frigate with
// "who came by" events, and photos from a folder instead of generated ones.
// Switched on by DEMO_MEDIA=/path/to/folder, laid out as:
//   photos/*.jpg + photos/photos.json   [{ file, date, place }]
//   cameras/*.jpg + cameras/events.json [{ file, camera, label, minutesAgo, count }]
//   avatars/<first name>.svg|png        alex, jordan, sam, riley, grandma
// Point IMMICH_URL (+ IMMICH_KEY_FILE) at a real Immich to use a real album
// instead of photos/. Use only pictures you may show (CC0, your own, ...).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
const fileResponse = (f) => fs.existsSync(f)
  ? new Response(fs.readFileSync(f), { status: 200, headers: { "content-type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream" } })
  : new Response("", { status: 404 });

function applyDemo({ dir, states, lists, calendars, hass, dayIso, dateStr, emit = () => {} }) {
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const avatar = (n) => ["svg", "png", "jpg"].map((x) => `${n}.${x}`).find((f) => fs.existsSync(path.join(dir, "avatars", f)));
  const person = (id, name, state, min) => {
    const pic = avatar(id);
    states[`person.${id}`] = { state, attributes: { friendly_name: name, ...(pic ? { entity_picture: `/demo/avatars/${pic}` } : {}) }, last_changed: ago(min) };
  };
  person("alex", "Alex", "home", 50);
  person("jordan", "Jordan", "Work", 190);
  person("sam", "Sam", "School", 300);
  person("riley", "Riley", "home", 35);
  person("grandma", "Grandma", "home", 600);
  Object.assign(states, {
    "binary_sensor.back_door": { state: "off", attributes: { friendly_name: "Back Door", device_class: "door" } },
    "calendar.school": { state: "off", attributes: { friendly_name: "School" } },
    "todo.shopping_list": { state: "5", attributes: { friendly_name: "Shopping List" } }
  });
  lists["todo.shopping_list"] = ["Milk", "Bananas", "Dog food", "Coffee", "Birthday candles"].map((summary, i) => ({ uid: `s${i}`, summary, status: "needs_action" }));

  // A believable month: weekly routines plus one-offs, from last week to five weeks out.
  const at = (n, h, m, mins, summary) => ({ uid: `d${n}-${h}-${summary}`, summary, start: { dateTime: dayIso(n, h, m).toISOString() }, end: { dateTime: new Date(dayIso(n, h, m).getTime() + mins * 60000).toISOString() } });
  const allDay = (n, days, summary) => ({ uid: `a${n}-${summary}`, summary, start: { date: dateStr(dayIso(n, 0)) }, end: { date: dateStr(dayIso(n + days, 0)) } });
  const family = [], school = [], grandma = [];
  for (let n = -10; n <= 38; n++) {
    const wd = dayIso(n, 12).getDay();
    if (wd === 2 || wd === 4) family.push(at(n, 17, 30, 60, "Soccer practice"));
    if (wd === 3) family.push(at(n, 16, 0, 45, "Piano lesson"));
    if (wd === 1) family.push(at(n, 19, 0, 30, "Trash night"));
    if (wd === 5) family.push(at(n, 18, 30, 120, "Pizza + movie night"));
    if (wd === 6 && n % 14 < 7) family.push(at(n, 9, 0, 90, "Soccer game"));
    if (wd >= 1 && wd <= 5) school.push(at(n, 7, 45, 30, "School drop-off"));
    if (wd === 2) grandma.push(at(n, 10, 0, 60, "Water aerobics"));
    if (wd === 0) grandma.push(at(n, 9, 0, 90, "Church"));
  }
  family.push(at(1, 9, 0, 60, "Dentist (Riley)"), allDay(3, 3, "Grandparents visit"), at(6, 11, 0, 120, "Farmers market"),
    at(12, 15, 0, 180, "Max's birthday party"), allDay(17, 3, "Camping trip"), at(24, 18, 0, 90, "Parent-teacher night"));
  school.push(allDay(9, 1, "Picture day"), allDay(15, 2, "No school"), at(21, 13, 0, 60, "Science fair"), allDay(30, 1, "Field trip"));
  grandma.push(at(0, 10, 30, 60, "Hair appt"), at(2, 9, 15, 60, "Dr. Patel"), at(8, 12, 0, 90, "Lunch with June"), at(19, 14, 0, 60, "Book club"));
  calendars["calendar.family"] = family;
  calendars["calendar.school"] = school;
  calendars["calendar.grandma"] = grandma;
  calendars["calendar.birthdays"] = [
    { uid: "b1", summary: "Max's birthday", rrule: "FREQ=YEARLY", recurrence_id: "x", start: { date: dateStr(dayIso(12, 0)) }, end: { date: dateStr(dayIso(13, 0)) } },
    { uid: "b2", summary: "Grandma's birthday", rrule: "FREQ=YEARLY", recurrence_id: "y", start: { date: dateStr(dayIso(27, 0)) }, end: { date: dateStr(dayIso(28, 0)) } }
  ];

  // Sun and weather follow the real clock (sunrise 6:30, sunset 18:15, warmest
  // at 3 PM), so the sky looks right whenever someone films it.
  const RISE = 6.5, SET = 18.25;
  const hourOf = (d) => d.getHours() + d.getMinutes() / 60;
  const tempAt = (d) => Math.round(80 + 15 * Math.cos(((hourOf(d) - 15) / 24) * 2 * Math.PI));
  const isDay = (d) => hourOf(d) >= RISE && hourOf(d) < SET;
  const next = (h) => { const d = new Date(); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d.toISOString(); };
  const sky = () => {
    const now = new Date();
    states["sun.sun"] = { state: isDay(now) ? "above_horizon" : "below_horizon", attributes: { friendly_name: "Sun", next_rising: next(RISE), next_setting: next(SET) } };
    const w = states["weather.forecast_home"];
    w.state = isDay(now) ? "sunny" : "clear-night";
    w.attributes = { ...w.attributes, temperature: tempAt(now) };
    emit(["sun.sun", "weather.forecast_home"]);
  };
  sky();
  setInterval(sky, 60000);
  const callService = hass.callService;
  hass.callService = async (domain, service, data, returnResponse) => {
    if (domain !== "weather" || service !== "get_forecasts") return callService(domain, service, data, returnResponse);
    const out = [];
    if (data.type === "daily") {
      for (let i = 0; i < 7; i++) { const d = dayIso(i, 12); out.push({ datetime: d.toISOString(), temperature: 95 - (i % 3), templow: 66 + (i % 2), condition: i === 4 ? "partlycloudy" : "sunny", precipitation_probability: i === 4 ? 20 : 0 }); }
    } else {
      const t0 = new Date(); t0.setMinutes(0, 0, 0);
      for (let i = 0; i < 24; i++) { const d = new Date(t0.getTime() + i * 3600e3); out.push({ datetime: d.toISOString(), temperature: tempAt(d), templow: 66, condition: isDay(d) ? "sunny" : "clear-night", precipitation_probability: 0 }); }
    }
    return { [data.entity_id]: { forecast: out } };
  };

  // Person pictures come through HA's REST API; serve them from the folder.
  const rest = hass.rest;
  hass.rest = async (p) => (/^\/demo\/avatars\/[a-z]+\.(svg|png|jpg)$/.test(p) ? fileResponse(path.join(dir, "avatars", path.basename(p))) : rest(p));

  // Photos from the folder (unless a real Immich is configured).
  const pmeta = readJson(path.join(dir, "photos", "photos.json"), []);
  const ALBUM = "0e1d2c3b-4a59-6877-8695-a4b3c2d1e0f0";
  const photos = pmeta.map((p, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, date: p.date, place: p.place || null, portrait: false, file: p.file }));
  const immich = photos.length ? {
    configured: () => true,
    listAlbums: async () => [{ id: ALBUM, name: "Family Frame (demo)", count: photos.length, thumb: photos[0].id }],
    album: async (id) => (id === ALBUM ? photos.map(({ file, ...p }) => p) : []),
    preview: async (id) => {
      const p = photos.find((x) => x.id === id);
      return p ? { body: fs.readFileSync(path.join(dir, "photos", p.file)), type: TYPES[path.extname(p.file).toLowerCase()] || "image/jpeg" } : null;
    }
  } : null;

  // A fake Frigate: the saved events the "Who came by" card lists, with snapshots.
  const cmeta = readJson(path.join(dir, "cameras", "events.json"), []);
  const events = () => {
    const out = [];
    cmeta.forEach((e, i) => {
      for (let k = 0; k < (e.count || 1); k++) {
        const t = Math.floor(Date.now() / 1000) - (e.minutesAgo + k * 4) * 60;
        out.push({ id: `demo-${i}-${k}`, camera: e.camera, label: e.label, sub_label: null, start_time: t, end_time: t + 20, has_clip: false, has_snapshot: true, false_positive: false, data: { max_severity: e.label === "person" ? "alert" : "detection" } });
      }
    });
    return out;
  };
  const frigate = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/events") {
      const cams = (u.searchParams.get("cameras") || "").split(",");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(events().filter((e) => cams.includes(e.camera))));
    }
    const m = /^\/api\/events\/demo-(\d+)-\d+\/(snapshot-clean|thumbnail)\.webp$/.exec(u.pathname);
    const e = m && cmeta[Number(m[1])];
    if (!e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(e.file).toLowerCase()] || "image/jpeg" });
    res.end(fs.readFileSync(path.join(dir, "cameras", e.file)));
  }).listen(0, "127.0.0.1");
  const frigateUrl = cmeta.length ? new Promise((r) => frigate.on("listening", () => r(`http://127.0.0.1:${frigate.address().port}`))) : Promise.resolve("");
  const cameraFrame = cmeta.length ? async () => ({ body: fs.readFileSync(path.join(dir, "cameras", cmeta[0].file)), type: "image/jpeg" }) : null;

  return { immich, frigateUrl, cameraFrame, cameras: [...new Set(cmeta.map((e) => e.camera))] };
}

module.exports = { applyDemo };
