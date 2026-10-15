// README screenshot of a household board (docs/screenshots/household-board.png):
// a portrait 1080x1920 view with the layout of a real family board, filled
// with scripts/dev-mock.js's made-up family, on a paired headless display.
//   node scripts/readme-household.mjs [out.png]
// Needs Playwright with Chromium, or PLAYWRIGHT=/path/to/playwright/index.mjs.
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const out = process.argv[2] || fileURLToPath(new URL("../docs/screenshots/household-board.png", import.meta.url));
const DP = 3496, AP = 3497, STUDIO = `http://127.0.0.1:${AP}`, DISPLAY = `http://127.0.0.1:${DP}`;
// The mock's sun and forecast are relative to now: pick a time zone where it's
// mid-afternoon, so the sky, clock and sunrise/sunset agree whenever this runs.
const off = (((new Date().getUTCHours() - 15) % 24) + 24) % 24, n = off > 12 ? off - 24 : off;
const TZ = n >= 0 ? `Etc/GMT+${n}` : `Etc/GMT${n}`;
const mock = spawn("node", [fileURLToPath(new URL("./dev-mock.js", import.meta.url))], { env: { ...process.env, TZ, DISPLAY_PORT: DP, ADMIN_PORT: AP } });
await new Promise((resolve, reject) => { mock.stdout.on("data", (b) => { if (/studio http/.test(String(b))) resolve(); }); mock.on("exit", () => reject(new Error("mock exited"))); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const card = { textColor: "", shadow: false, bg: "#121622", bgOpacity: 42, radius: 1.77, outline: true, size: 1.04 };
const tile = { textColor: "", shadow: false, bg: "#ffffff", bgOpacity: 6, radius: 1.25, padding: 0.6, outline: false, size: 1.04 };
const P = (entity, color) => ({ entity, name: "", color });
const widgets = [
  { id: "sky", type: "sky", x: 0, y: 0, w: 100, h: 33.33, props: { entity: "weather.forecast_home", sun: "sun.sun", showWeather: true, showRibbon: true, showTip: true, backdrop: true, size: 1.04 } },
  { id: "clock", type: "clock", x: 5.56, y: 2.92, w: 59.26, h: 15.1, props: { format: "12", showAmPm: true, showSeconds: false, showDate: true, dateStyle: "long", look: "elegant", size: 12.29, align: "left", shadow: false, bgOpacity: 0, padding: 0 } },
  { id: "people", type: "people", x: 5.56, y: 33.13, w: 88.89, h: 10.42, props: { people: [P("person.alex", "#4f8cff"), P("person.jordan", "#ff7eb6"), P("person.sam", "#ffb257"), P("person.riley", "#34d399")],
    showStatus: true, ...card, bgOpacity: 0, padding: 0, outline: false } },
  { id: "agenda", type: "calendar", x: 3.7, y: 44.9, w: 54.63, h: 32.08, props: { calendars: [P("calendar.family", "#7fe0a1"), { ...P("calendar.birthdays", "#ff6b6b"), birthdays: true }],
    layout: "agenda", maxItems: 6, showBirthday: true, allowAdd: true, allowErase: true, ...card, padding: 1.5 } },
  { id: "house", type: "panel", x: 60.19, y: 44.9, w: 36.11, h: 32.08, props: { look: "card", title: "House", note: "", ...card, padding: 1.46 } },
  { id: "dogs", type: "since", x: 62.59, y: 48.49, w: 31.3, h: 4.38, props: { entity: "input_datetime.dogs_last_out", intervalEntity: "input_number.dogs_out_reminder_minutes", interval: 90,
    icon: "🐕", label: "Dogs out", dueLabel: "Dogs need out", script: "script.record_dogs_out", buttonLabel: "They just went out", ...tile } },
  { id: "laundry", type: "status", x: 62.59, y: 53.49, w: 31.3, h: 4.38, props: { title: "Laundry", icon: "🫧", idleText: "All quiet", staleHours: 12,
    items: [{ entity: "input_boolean.washer_active", status: "input_text.washer_status", name: "Washer" }, { entity: "input_boolean.dryer_active", status: "input_text.dryer_status", name: "Dryer" }], ...tile } },
  { id: "gary", type: "button", x: 62.59, y: 58.49, w: 31.3, h: 4.38, props: { action: "vacuum", entity: "vacuum.gary", icon: "🤖", label: "Gary", look: "tile", ring: false, confirm: true, ...tile } },
  { id: "shop", type: "todo", x: 62.59, y: 63.49, w: 31.3, h: 4.38, props: { entity: "todo.shopping_list", title: "Shopping list", icon: "🛒", preview: 4, allowAdd: true, allowCheck: true, ...tile } },
  { id: "icons", type: "icons", x: 62.59, y: 71.04, w: 31.3, h: 4.48, props: { items: [{ entity: "", name: "Matrix", kind: "matrix" }, { entity: "binary_sensor.garage_door", name: "Garage", kind: "garage" },
    { entity: "binary_sensor.front_door", name: "Front", kind: "door" }, { entity: "climate.living", name: "Inside", kind: "temp" }], playMinutes: 10, size: 1.04 } },
  { id: "chores", type: "chores", x: 3.7, y: 77.92, w: 92.59, h: 9.17, props: { title: "Chores", kids: [{ entity: "todo.sam_s_chores", name: "Sam", person: "person.sam", color: "#ffb257" },
    { entity: "todo.riley_s_chores", name: "Riley", person: "person.riley", color: "#34d399" }], allowCheck: true, allowAdd: true, footer: "by 5 PM", chipLayout: "stacked", ...card, padding: 1.25 } },
  // The real board has "Who came by" (Frigate snapshots) here; a month calendar needs no cameras.
  { id: "month", type: "calendar", x: 3.7, y: 88.13, w: 92.59, h: 10.42, props: { calendars: [P("calendar.family", "#7fe0a1")], layout: "month", weeks: 2, ...card, padding: 1.15 } }
];

const browser = await chromium.launch();
try {
  const studio = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await studio.goto(STUDIO);
  await studio.fill("input[name=code]", "dev-setup");
  await studio.fill("input[name=username]", "admin");
  await studio.fill("input[name=password]", "dev-password-1");
  await studio.click("button[type=submit]");
  await studio.waitForSelector("text=Screens");
  const api = (method, url, body) => studio.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { "Content-Type": "application/json", "X-Studio": "1" }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  }, [method, url, body]);
  const view = await api("POST", "/api/views", { name: "Family board", aspect: { w: 1080, h: 1920 } });
  await api("PUT", `/api/views/${view.id}/draft`, { draft: { ...view.draft, background: "#05070d", textColor: "#f7f4ee", font: "manrope", accentFont: "fraunces", widgets } });
  await api("POST", `/api/views/${view.id}/publish`);

  const errors = [];
  const display = await (await browser.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, timezoneId: TZ })).newPage();
  display.on("pageerror", (e) => errors.push(e.message));
  display.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await display.goto(DISPLAY);
  await display.waitForSelector("#pairCode:not(:empty)");
  await pause(300);
  const code = (await display.textContent("#pairCode")).trim();
  const paired = await api("POST", "/api/pair", { code, name: "Dining room" });
  await api("PATCH", `/api/screens/${paired.screenId}`, { viewId: view.id });
  await display.waitForSelector(".hh-ev");
  await pause(2500);
  await display.screenshot({ path: out });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  mock.kill();
}
