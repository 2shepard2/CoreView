// Headless check of the Aquarium widget against scripts/dev-mock.js:
//   node scripts/smoke-aquarium.mjs <outDir>
// Builds a landscape view with one full-screen Aquarium, pairs a display,
// then walks the tank through its stories by changing fake Home Assistant
// states (POST /dev/state): a calm day, a door left open in the rain, night,
// a leak, everyone out on a cold day, and Home Assistant going quiet.
// Screenshots each scene and checks the words that must be on screen.
// Fails on console errors. Needs Playwright with Chromium (see smoke-household.mjs).
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = process.argv[2] || "/tmp/cvs-aquarium";
mkdirSync(out, { recursive: true });
const DP = 3496, AP = 3497, STUDIO = `http://127.0.0.1:${AP}`, DISPLAY = `http://127.0.0.1:${DP}`;
const mock = spawn("node", [fileURLToPath(new URL("./dev-mock.js", import.meta.url))], { env: { ...process.env, DISPLAY_PORT: DP, ADMIN_PORT: AP } });
const haUrl = await new Promise((resolve, reject) => {
  mock.stdout.on("data", (b) => { const m = /calls (\S+)\/dev\/calls/.exec(String(b)); if (m) resolve(m[1]); });
  mock.on("exit", () => reject(new Error("mock exited")));
});
const set = (changes) => fetch(`${haUrl}/dev/state`, { method: "POST", body: JSON.stringify(changes) });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const watch = (page, name) => {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
};

const props = {
  title: "Our Aquarium",
  people: [
    { entity: "person.alex", name: "", color: "#4f8cff" }, { entity: "person.jordan", name: "", color: "#ff7eb6" },
    { entity: "person.sam", name: "", color: "#ffb257" }, { entity: "person.riley", name: "", color: "#34d399" }
  ],
  openings: [
    { entity: "binary_sensor.garage_door", name: "Garage" }, { entity: "binary_sensor.back_window", name: "Back window" }
  ], // not the front door: dev-mock flips it at random
  alarms: [{ entity: "binary_sensor.laundry_leak", name: "Water leak in the laundry" }],
  inside: "sensor.indoor_temperature_average", coolBelow: 68, warmAbove: 77,
  weather: "weather.forecast_home", sun: "sun.sun", size: 2
};
const calm = {
  "binary_sensor.garage_door": { state: "off" }, "binary_sensor.back_window": { state: "off" }, "binary_sensor.laundry_leak": { state: "off" },
  "weather.forecast_home": { state: "sunny", attributes: { friendly_name: "Forecast Home", temperature: 81 } },
  "sun.sun": { state: "above_horizon", attributes: { friendly_name: "Sun" } },
  "sensor.indoor_temperature_average": { state: "72.4", attributes: { unit_of_measurement: "°F" } }
};
const scenes = [
  ["01-calm-day", calm, ["All calm"]],
  ["02-garage-open-rain", { "binary_sensor.garage_door": { state: "on", last_changed: new Date(Date.now() - 12 * 60000).toISOString() },
    "binary_sensor.back_window": { state: "on" }, "weather.forecast_home": { state: "rainy", attributes: { temperature: 64 } } }, ["2 open: Garage, Back window"]],
  ["03-night", { ...calm, "sun.sun": { state: "below_horizon", attributes: {} }, "weather.forecast_home": { state: "clear-night", attributes: { temperature: 66 } } }, ["All calm"]],
  ["04-leak", { "binary_sensor.laundry_leak": { state: "on" } }, ["Needs a look now", "Water leak in the laundry"]],
  ["05-cold-everyone-out", { ...calm, "person.alex": { state: "Work" }, "person.riley": { state: "not_home" },
    "sensor.indoor_temperature_average": { state: "63.1", attributes: { unit_of_measurement: "°F" } },
    "weather.forecast_home": { state: "snowy", attributes: { temperature: 28 } } }, ["everyone's out", "cool"]]
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
  await set(calm);
  const view = await api("POST", "/api/views", { name: "Aquarium", aspect: { w: 1920, h: 1080 } });
  await api("PUT", `/api/views/${view.id}/draft`, { draft: { ...view.draft, background: "#06202a", widgets: [
    { id: "tank", type: "aquarium", x: 0, y: 0, w: 100, h: 100, props }
  ] } });
  await api("POST", `/api/views/${view.id}/publish`);

  const display = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  watch(display, "display");
  await display.goto(DISPLAY);
  await display.waitForSelector("#pairCode:not(:empty)");
  await pause(300);
  const code = (await display.textContent("#pairCode")).trim();
  const paired = await api("POST", "/api/pair", { code, name: "Aquarium screen" });
  await api("PATCH", `/api/screens/${paired.screenId}`, { viewId: view.id });
  await display.waitForSelector(".aq-root");

  for (const [name, changes, words] of scenes) {
    await set(changes);
    await pause(2500);
    await display.screenshot({ path: `${out}/${name}.png` });
    const body = await display.innerText("body");
    for (const w of words) if (!body.includes(w)) throw new Error(`${name}: expected "${w}" on screen, saw: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
    console.log("ok", name);
  }
  // Home Assistant has nothing for any configured entity: grey, still water, never "All calm".
  const ghost = { ...props, people: [{ entity: "person.nobody", name: "Ghost", color: "#ffffff" }], openings: [{ entity: "binary_sensor.nothing", name: "Nowhere" }],
    alarms: [], inside: "sensor.missing" };
  await api("PUT", `/api/views/${view.id}/draft`, { draft: { ...view.draft, background: "#06202a", widgets: [{ id: "tank", type: "aquarium", x: 0, y: 0, w: 100, h: 100, props: ghost }] } });
  await api("POST", `/api/views/${view.id}/publish`);
  await pause(3000);
  await display.screenshot({ path: `${out}/06-cant-hear-ha.png` });
  if (!(await display.innerText("body")).includes("Can't hear Home Assistant")) throw new Error("06: expected Can't hear Home Assistant");
  console.log("ok 06-cant-hear-ha");
  // Studio's editor preview of the same view.
  await studio.goto(`${STUDIO}/#/views/${view.id}`);
  await pause(2500);
  await studio.screenshot({ path: `${out}/07-studio-editor.png` });
  if (errors.length) throw new Error("console errors:\n" + errors.join("\n"));
  console.log("Aquarium smoke passed:", out);
} finally {
  await browser.close();
  mock.kill();
}
