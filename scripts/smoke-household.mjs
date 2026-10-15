// Headless check of the household widgets (V2.2) against scripts/dev-mock.js:
//   node scripts/smoke-household.mjs <outDir>
// Starts the mock, builds a portrait "Family board" view through the API,
// pairs a display, taps through the interactive widgets and checks that each
// tap reached (fake) Home Assistant. Screenshots every step; fails on console errors.
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium),
// or PLAYWRIGHT=/path/to/playwright/index.mjs.
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = process.argv[2] || "/tmp/cvs-household";
mkdirSync(out, { recursive: true });
const DP = 3396, AP = 3397, STUDIO = `http://127.0.0.1:${AP}`, DISPLAY = `http://127.0.0.1:${DP}`;
const mock = spawn("node", [fileURLToPath(new URL("./dev-mock.js", import.meta.url))], { env: { ...process.env, DISPLAY_PORT: DP, ADMIN_PORT: AP } });
const callsUrl = await new Promise((resolve, reject) => {
  mock.stdout.on("data", (b) => { const m = /calls (\S+)/.exec(String(b)); if (m) resolve(m[1]); });
  mock.on("exit", () => reject(new Error("mock exited")));
});
const calls = async () => (await fetch(callsUrl)).json();
const errors = [];
let expect403 = false; // the refused-action check below
const watch = (page, name) => {
  page.on("console", (m) => { if (m.type() === "error" && !(expect403 && /403/.test(m.text()))) errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
};
const shot = (page, n) => page.screenshot({ path: `${out}/${n}.png` });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const expectCall = async (pred, what) => {
  for (let i = 0; i < 20; i++) { if ((await calls()).some(pred)) return; await pause(150); }
  throw new Error(`no Home Assistant call for: ${what}`);
};

const C = (k, color, extra = {}) => ({ entity: k, name: "", color, ...extra });
const widgets = [
  { id: "sky", type: "sky", x: 0, y: 0, w: 100, h: 26, props: { entity: "weather.forecast_home", sun: "sun.sun", showWeather: true, showRibbon: true, showTip: true, size: 1.04 } },
  { id: "clock", type: "clock", x: 4, y: 2, w: 50, h: 9, props: { size: 6, showDate: true, format: "12", showAmPm: true, align: "left", shadow: true } },
  { id: "people", type: "people", x: 2, y: 27, w: 96, h: 10, props: { people: [C("person.alex", "#4f8cff"), C("person.jordan", "#ff7eb6"), C("person.sam", "#ffb257"), C("person.riley", "#34d399")], showStatus: true, size: 1.04 } },
  { id: "agenda", type: "calendar", x: 2, y: 38, w: 96, h: 24, props: { calendars: [C("calendar.family", "#7fe0a1", { name: "Family" }), C("calendar.birthdays", "#ff6b6b", { name: "Birthdays", birthdays: true })], layout: "agenda", maxItems: 7, showBirthday: true, allowAdd: true, allowErase: true, size: 1.04 } },
  { id: "dogs", type: "since", x: 2, y: 63, w: 47, h: 7, props: { entity: "input_datetime.dogs_last_out", intervalEntity: "input_number.dogs_out_reminder_minutes", icon: "🐕", label: "Dogs out", dueLabel: "Dogs need out", script: "script.record_dogs_out", buttonLabel: "They just went out", size: 1.04 } },
  { id: "shop", type: "todo", x: 51, y: 63, w: 47, h: 7, props: { entity: "todo.shopping_list", title: "Shopping list", icon: "🛒", preview: 4, allowAdd: true, allowCheck: true, size: 1.04 } },
  { id: "gary", type: "button", x: 2, y: 71, w: 47, h: 7, props: { action: "vacuum", entity: "vacuum.gary", icon: "🤖", label: "Gary", confirm: true, size: 1.04 } },
  { id: "inside", type: "entity", x: 51, y: 71, w: 22, h: 7, props: { entity: "climate.living", label: "Inside", attribute: "current_temperature", size: 2 } },
  { id: "icons", type: "icons", x: 74, y: 71, w: 24, h: 7, props: { items: [{ entity: "binary_sensor.front_door", name: "Front", kind: "door" }, { entity: "", name: "Matrix", kind: "matrix" }], playMinutes: 10, size: 1.04 } },
  { id: "chores", type: "chores", x: 2, y: 79, w: 96, h: 10, props: { title: "Chores", kids: [{ entity: "todo.sam_s_chores", name: "Sam", person: "person.sam", color: "#ffb257" }, { entity: "todo.riley_s_chores", name: "Riley", person: "person.riley", color: "#34d399" }], allowCheck: true, allowAdd: true, footer: "by 5 PM", size: 1.04 } },
  { id: "month", type: "calendar", x: 2, y: 90, w: 96, h: 9, props: { calendars: [C("calendar.family", "#7fe0a1", { name: "Family" })], layout: "month", weeks: 2, size: 1.04 } }
];

const browser = await chromium.launch();
try {
  const studio = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  watch(studio, "studio");
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
  await api("PUT", `/api/views/${view.id}/draft`, { draft: { ...view.draft, background: "#0b0f14", widgets } });
  await api("POST", `/api/views/${view.id}/publish`);

  const display = await (await browser.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 })).newPage();
  watch(display, "display");
  await display.goto(DISPLAY);
  await display.waitForSelector("#pairCode:not(:empty)");
  await pause(300);
  const code = (await display.textContent("#pairCode")).trim();
  const paired = await api("POST", "/api/pair", { code, name: "Kitchen tablet" });
  await api("PATCH", `/api/screens/${paired.screenId}`, { viewId: view.id });
  await display.waitForSelector(".hh-ev");
  await pause(1500);
  await shot(display, "10-board");
  if (process.env.PROBE) console.log(await display.evaluate(([x, y]) => document.elementsFromPoint(x, y).slice(0, 6).map((e) => e.className + " " + JSON.stringify(e.getBoundingClientRect())), process.env.PROBE.split(",").map(Number)));

  // Shopping list: add an item.
  await display.click(".cv-todo .hh-tile");
  await display.fill(".cv-sheet input", "Eggs");
  await shot(display, "11-shopping-sheet");
  await display.click(".cv-sheet .hh-inp .hh-pri");
  await expectCall((c) => c.domain === "todo" && c.service === "add_item" && c.data.item === "Eggs", "add Eggs");
  await pause(400);
  await shot(display, "12-shopping-added");
  await display.click(".cv-sheet .hh-li");               // check off the first item
  await expectCall((c) => c.service === "update_item" && c.data.entity_id === "todo.shopping_list", "check off");
  await display.click(".cv-sheet-x");

  // Chores: open Sam, check one off.
  await display.click(".hh-kchip");
  await shot(display, "13-chores-sheet");
  await display.click(".cv-sheet .hh-li");
  await expectCall((c) => c.service === "update_item" && c.data.entity_id === "todo.sam_s_chores", "chore");
  await display.click(".cv-sheet-x");

  // Dogs went out.
  await display.click(".cv-since .hh-tile");
  await display.click(".cv-sheet .hh-pri");
  await expectCall((c) => c.domain === "script" && c.data.entity_id === "script.record_dogs_out", "dogs out");

  // Gary: start cleaning.
  await display.click(".cv-button .hh-tile");
  await display.click(".cv-sheet .hh-pri");
  await expectCall((c) => c.domain === "vacuum" && c.service === "start", "vacuum start");

  // Calendar: add an event, then erase one.
  await display.click(".cv-calendar .hh-add");
  await display.fill(".cv-sheet .hh-inp input", "Pizza night");
  await shot(display, "14-add-event");
  await display.click(".cv-sheet .hh-btns .hh-pri");
  await expectCall((c) => c.type === "calendar/event/create" && c.event.summary === "Pizza night", "add event");
  await pause(500);
  await shot(display, "15-event-added");
  await display.click(".cv-calendar .hh-ev");
  await shot(display, "16-event-sheet");
  await display.click(".cv-sheet .hh-danger");
  await expectCall((c) => c.type === "calendar/event/delete", "erase event");

  // Matrix: the icon's sheet puts a sign up, then a light show, then back to normal.
  await api("POST", "/api/matrix/coreview-beacon", { live: true });
  await display.click(".cv-icons .hh-lk-tap");
  await display.fill(".cv-sheet .hh-inp input >> nth=0", "Hi Mom!");
  await display.fill(".cv-sheet .hh-inp input >> nth=1", "love Amara");
  await display.locator(".cv-sheet .hh-chipbtn", { hasText: "Pink" }).click();
  await shot(display, "18-matrix-sheet");
  await display.locator(".cv-sheet .hh-btn", { hasText: "Show it" }).click();
  await display.waitForSelector(".cv-icons .hh-lk-tap >> text=Playing");
  const playing = async () => (await api("GET", "/api/state")).matrix.find((t) => t.id === "coreview-beacon");
  let mx = await playing();
  if (!mx.play || mx.scene.kind !== "message" || mx.scene.title !== "Hi Mom!" || mx.preview.theme.primary !== "#ff4fc3") throw new Error("Matrix sign not showing: " + JSON.stringify(mx.scene));
  await display.locator(".cv-sheet .hh-chipbtn", { hasText: "Fireworks" }).click();
  await pause(400);
  mx = await playing();
  if (mx.scene.effect !== "fireworks") throw new Error("Matrix effect not showing: " + JSON.stringify(mx.scene));
  await shot(display, "19-matrix-playing");
  await display.locator(".cv-sheet .hh-btn", { hasText: "Back to normal" }).click();
  await pause(400);
  mx = await playing();
  if (mx.play || mx.scene.kind === "effect") throw new Error("Matrix still playing after Back to normal");
  await display.click(".cv-sheet-x");

  // A widget the view doesn't allow must be refused by the server.
  expect403 = true;
  const refused = await display.evaluate(async () => (await fetch("api/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ widget: "month", action: "add", cal: 0, title: "x", date: "2026-10-10" }) })).status);
  if (refused !== 403) throw new Error(`month calendar add should be refused, got ${refused}`);
  await pause(600);
  expect403 = false;
  await shot(display, "17-after");

  // The editor shows the rows UI for the calendar.
  await studio.goto(`${STUDIO}/#/edit/${view.id}`);
  await studio.waitForSelector(".ed-canvas");
  await pause(800);
  await studio.locator(".ed-layer", { hasText: "Calendar" }).last().click();
  await pause(400);
  await shot(studio, "20-editor");

  if (errors.length) throw new Error("console errors:\n" + errors.join("\n"));
  console.log("household smoke OK:", out);
} finally {
  await browser.close();
  mock.kill();
}
