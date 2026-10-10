// Headless check of Grandma's whiteboard views against scripts/dev-mock.js:
//   node scripts/smoke-whiteboard.mjs <outDir>
// Builds the three linked views (scripts/whiteboard-views.js), pairs a
// 1024x768 display, and walks through it: photos -> tap -> calendar, a day,
// hold to write, hold to erase, bring back, Grandkids mode and the PIN,
// the drawing board (draw, save, fridge), idle back to photos. Screenshots
// every step; fails on console errors or a missing Home Assistant call.
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium),
// or PLAYWRIGHT=/path/to/playwright/index.mjs.
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("./whiteboard-views.js");
const out = process.argv[2] || "/tmp/cvs-whiteboard";
mkdirSync(out, { recursive: true });
const DP = 3596, AP = 3597, STUDIO = `http://127.0.0.1:${AP}`, DISPLAY = `http://127.0.0.1:${DP}`;
const mock = spawn("node", [fileURLToPath(new URL("./dev-mock.js", import.meta.url))], { env: { ...process.env, DISPLAY_PORT: DP, ADMIN_PORT: AP } });
const info = await new Promise((resolve, reject) => {
  mock.stdout.on("data", (b) => { const m = /album (\S+)\s+data (\S+)\s+calls (\S+)/.exec(String(b)); if (m) resolve({ album: m[1], data: m[2], calls: m[3] }); });
  mock.on("exit", () => reject(new Error("mock exited")));
});
const calls = async () => (await fetch(info.calls)).json();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const expectCall = async (pred, what) => {
  for (let i = 0; i < 30; i++) { if ((await calls()).some(pred)) return; await pause(150); }
  throw new Error(`no Home Assistant call for: ${what}`);
};
const errors = [];
let expectErr = null;
const watch = (page, name) => {
  page.on("console", (m) => { if (m.type() === "error" && !(expectErr && expectErr.test(m.text())) && !/404/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
};
const shot = (page, n) => page.screenshot({ path: `${out}/${n}.png` });
const hold = async (page, sel) => { const b = page.locator(sel).first(); await b.hover(); await page.mouse.down(); await pause(1200); await page.mouse.up(); };

const browser = await chromium.launch();
try {
  const studio = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  watch(studio, "studio");
  await studio.goto(STUDIO);
  await studio.fill("input[name=code]", "dev-setup"); await studio.fill("input[name=username]", "admin"); await studio.fill("input[name=password]", "dev-password-1");
  await studio.click("button[type=submit]"); await studio.waitForSelector("text=Screens");
  const api = (method, url, body) => studio.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { "Content-Type": "application/json", "X-Studio": "1" }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
  }, [method, url, body]);
  const ids = {};
  for (const [k, name] of [["idle", "Grandma (photos)"], ["board", "Grandma (calendar)"], ["draw", "Grandma (whiteboard)"]]) ids[k] = (await api("POST", "/api/views", { name, aspect: { w: 1024, h: 768 } })).id;
  const views = build({ album: info.album, ids });
  for (const k of Object.keys(ids)) {
    const saved = await api("PUT", `/api/views/${ids[k]}/draft`, { draft: views[k] });
    if (saved.draft.widgets.length !== views[k].widgets.length) throw new Error(`${k}: widgets dropped`);
    await api("POST", `/api/views/${ids[k]}/publish`);
  }

  const display = await (await browser.newContext({ viewport: { width: 1024, height: 768 } })).newPage();
  watch(display, "display");
  await display.goto(DISPLAY);
  await display.waitForSelector("#pairCode:not(:empty)"); await pause(300);
  const paired = await api("POST", "/api/pair", { code: (await display.textContent("#pairCode")).trim(), name: "Grandma's frame" });
  await api("PATCH", `/api/screens/${paired.screenId}`, { viewId: ids.idle, pin: "2026" });
  await display.waitForSelector(".wb-sticky"); await pause(1500);
  await shot(display, "1-idle");

  await display.mouse.click(300, 300);                        // tap the photo -> calendar
  await display.waitForSelector(".wb-cell"); await pause(800);
  await shot(display, "2-board");

  await display.click(".wb-todaycell");
  await pause(600); await shot(display, "3-day");
  await display.click(".wb-big");
  await display.click(".wb-quick .wb-chip >> nth=0");            // "Doctor"
  await pause(300); await shot(display, "4-add");
  await hold(display, ".wb-save");
  await expectCall((c) => c.type === "calendar/event/create" && c.event.summary === "Doctor", "hold to write");
  await pause(800); await shot(display, "5-written");

  await display.click(".wb-todaycell"); await pause(600);
  await hold(display, ".wb-er");
  await expectCall((c) => c.type === "calendar/event/delete", "hold to erase");
  await pause(800);
  await display.click(".wb-oops");
  await pause(300); await shot(display, "6-erased");
  const before = (await calls()).filter((c) => c.type === "calendar/event/create").length;
  await display.click(".wb-gone-item .wb-chip");
  for (let i = 0; i < 30 && (await calls()).filter((c) => c.type === "calendar/event/create").length === before; i++) await pause(150);
  if ((await calls()).filter((c) => c.type === "calendar/event/create").length === before) throw new Error("bring back made no event");
  await display.click(".wb-x");

  // Grandkids mode: on with a tap; the server then refuses writes; off with the PIN.
  await display.click(".cv-button .hh-pill-light");
  await pause(600); await shot(display, "7-kids");
  expectErr = /423|403/;
  const refused = await display.evaluate(async () => (await fetch("api/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ widget: "wb-cal", action: "add", cal: 0, title: "x", day: "2026-10-10", min: null }) })).status);
  if (refused !== 423) throw new Error(`write in Grandkids mode should be refused, got ${refused}`);
  await display.click(".cv-button .hh-pill-dark >> nth=0");
  for (const d of "1111") await display.click(`.wb-keys button:text-is("${d}")`);
  await pause(700); await shot(display, "8-pin-wrong");
  for (const d of "2026") await display.click(`.wb-keys button:text-is("${d}")`);
  await pause(700);
  expectErr = null;
  if (await display.locator(".wb-pin").count()) throw new Error("PIN pad still open after the right PIN");

  // Drawing board: draw on Grandma's notes, wait for the save, fridge from Play.
  await display.click(".wb-tile"); await display.waitForSelector("canvas.wb-canvas"); await pause(800);
  await display.mouse.move(300, 300); await display.mouse.down();
  for (let i = 0; i < 20; i++) await display.mouse.move(300 + i * 15, 300 + Math.sin(i / 3) * 60);
  await display.mouse.up();
  await pause(2200); await shot(display, "9-notes");
  if (!existsSync(`${info.data}/boards/whiteboard/notes.png`)) throw new Error("notes page wasn't saved");
  await display.click(".wb-tabs button:text-is('Play')"); await pause(500);
  await display.click(".wb-rainbow");
  await display.mouse.move(200, 400); await display.mouse.down();
  for (let i = 0; i < 25; i++) await display.mouse.move(200 + i * 20, 400 + Math.cos(i / 2) * 50);
  await display.mouse.up();
  await display.click(".wb-fridge"); await pause(1000);
  await shot(display, "10-play");
  const fridge = await api("GET", "/api/board/whiteboard/fridge");
  if (!fridge.fridge.length) throw new Error("nothing on the fridge");
  await display.click(".wb-back"); await pause(600);
  await shot(display, "11-board-tile");

  if (errors.length) throw new Error("console errors:\n" + errors.join("\n"));
  console.log("whiteboard smoke OK:", out);
} finally {
  await browser.close();
  mock.kill();
}
