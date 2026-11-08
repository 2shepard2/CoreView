// Headless check of the Countdown widget and the Neon Coast holiday theme
// against scripts/dev-mock.js:
//   node scripts/smoke-countdown.mjs <outDir>
// Walks the countdown through its states by setting dates relative to today
// (11 days, tomorrow, later today, on the day, after, no date), checks the
// plain look, a portrait and a 1024x600 screen, then forces the Neon Coast
// theme over a clock view (with "until" in the future, then in the past).
// Screenshots each scene and checks the words that must be on screen.
// Fails on console errors. Needs Playwright with Chromium (see smoke-household.mjs).
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = process.argv[2] || "/tmp/cvs-countdown";
mkdirSync(out, { recursive: true });
const DP = 3498, AP = 3499, STUDIO = `http://127.0.0.1:${AP}`, DISPLAY = `http://127.0.0.1:${DP}`;
const mock = spawn("node", [fileURLToPath(new URL("./dev-mock.js", import.meta.url))], { env: { ...process.env, DISPLAY_PORT: DP, ADMIN_PORT: AP } });
await new Promise((resolve, reject) => {
  mock.stdout.on("data", (b) => { if (/calls (\S+)\/dev\/calls/.test(String(b))) resolve(); });
  mock.on("exit", () => reject(new Error("mock exited")));
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const watch = (page, name) => {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
};
// House-local dates (the mock runs in this machine's zone).
const day = (offset) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const later = new Date(Date.now() + 3 * 3600000 + 20 * 60000);
const laterTime = later.getDate() === new Date().getDate() ? `${later.getHours()}:${String(later.getMinutes()).padStart(2, "0")}` : null;
const base = { title: "Launch day", date: day(11), time: "", doneText: "It's here!", style: "neon", size: 1 };
const scenes = [
  ["01-eleven-days", {}, ["Launch day", "11", "days to go"]],
  ["02-tomorrow", { date: day(1) }, ["1", "Tomorrow!"]],
  ...(laterTime ? [["03-later-today", { date: day(0), time: laterTime }, ["hours to go", "Today"]]] : []),
  ["04-on-the-day", { date: day(0) }, ["It's here!"]],
  ["05-after", { date: day(-3) }, ["It's here!"]],
  ["06-no-date", { date: "" }, ["Pick a date for this countdown in Studio"]],
  ["07-bad-date", { date: "2026-02-30" }, ["Pick a date for this countdown in Studio"]],
  ["08-plain-long-title", { style: "plain", title: "Grandma and Grandpa visit from Ohio", date: day(40) }, ["40", "days to go"]]
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
    const j = r.status === 204 ? {} : await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  }, [method, url, body]);
  await api("PUT", "/api/seasonal", { mode: "off" });
  const view = await api("POST", "/api/views", { name: "Countdown", aspect: { w: 1920, h: 1080 } });
  const publish = async (v, widgets, background = "#000000") => {
    await api("PUT", `/api/views/${v.id}/draft`, { draft: { ...v.draft, background, widgets } });
    await api("POST", `/api/views/${v.id}/publish`);
  };
  await publish(view, [{ id: "cd", type: "countdown", x: 0, y: 0, w: 100, h: 100, props: base }]);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const display = await ctx.newPage();
  watch(display, "display");
  await display.goto(DISPLAY);
  await display.waitForSelector("#pairCode:not(:empty)");
  await pause(300);
  const code = (await display.textContent("#pairCode")).trim();
  const paired = await api("POST", "/api/pair", { code, name: "Countdown screen" });
  await api("PATCH", `/api/screens/${paired.screenId}`, { viewId: view.id });
  await display.waitForSelector(".cd-root");

  const check = async (name, words) => {
    await display.screenshot({ path: `${out}/${name}.png` });
    const body = await display.innerText("body");
    for (const w of words) if (!body.includes(w)) throw new Error(`${name}: expected "${w}" on screen, saw: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
    console.log("ok", name);
  };
  for (const [name, change, words] of scenes) {
    await publish(view, [{ id: "cd", type: "countdown", x: 0, y: 0, w: 100, h: 100, props: { ...base, ...change } }],
      change.style === "plain" ? "#2b4a5e" : "#000000");
    await pause(2200);
    await check(name, words);
  }
  // Other shapes: portrait and a small Echo Show-sized screen.
  await publish(view, [{ id: "cd", type: "countdown", x: 0, y: 0, w: 100, h: 100, props: base }]);
  for (const [name, vp] of [["09-small-1024x600", { width: 1024, height: 600 }], ["10-portrait", { width: 720, height: 1280 }]]) {
    await display.setViewportSize(vp);
    await pause(2200);
    await check(name, ["11", "days to go"]);
  }
  await display.setViewportSize({ width: 1280, height: 720 });

  // Neon Coast over an everyday view: a clock in the lower left, so only the right palm shows.
  const clockView = await api("POST", "/api/views", { name: "Clock", aspect: { w: 1920, h: 1080 } });
  await publish(clockView, [
    { id: "c", type: "clock", x: 2, y: 70, w: 40, h: 28, props: {} }
  ], "#22303c");
  await api("PATCH", `/api/screens/${paired.screenId}`, { viewId: clockView.id });
  const r = await api("PUT", "/api/seasonal", { mode: "neoncoast", until: day(11) });
  if (r.active !== "neoncoast" || r.until !== day(11)) throw new Error("11: seasonal API did not keep until: " + JSON.stringify(r));
  await pause(2500);
  const palms = await display.$$eval(".cvd-palm", (els) => els.map((e) => e.className));
  if (palms.length !== 1 || !/cvd-right/.test(palms[0])) throw new Error("11: expected one palm on the right, got " + JSON.stringify(palms));
  await check("11-neon-coast-over-clock", []);
  let bad = null;
  try { await api("PUT", "/api/seasonal", { mode: "neoncoast", until: "next friday" }); } catch (e) { bad = e.message; }
  if (!bad) throw new Error("12: a bad until date was accepted");
  errors.splice(errors.findIndex((e) => /status of 400/.test(e)), 1); // that refusal was the point
  // until in the past: back to the calendar at once.
  const past = await api("PUT", "/api/seasonal", { mode: "neoncoast", until: day(-1) });
  if (past.active === "neoncoast") throw new Error("12: until in the past still shows Neon Coast");
  await pause(2500);
  if (await display.$(".cvd-palm")) throw new Error("12: palms still drawn after until");
  await check("12-until-passed", []);
  console.log("ok 12 calendar theme now:", past.active);
  await api("PUT", "/api/seasonal", { mode: "neoncoast", until: day(11) });

  // Studio: the editor preview and the theme picker with its until date.
  await studio.goto(`${STUDIO}/#/views/${view.id}`);
  await pause(2500);
  await studio.screenshot({ path: `${out}/13-studio-editor.png` });
  await studio.goto(`${STUDIO}/#/screens`);
  await pause(1500);
  await studio.screenshot({ path: `${out}/14-studio-screens-picker.png` });
  if (!(await studio.$(".season-pick input[type=date]"))) throw new Error("14: no until date next to the theme picker");
  if (errors.length) throw new Error("console errors:\n" + errors.join("\n"));
  console.log("Countdown smoke passed:", out);
} finally {
  await browser.close();
  mock.kill();
}
