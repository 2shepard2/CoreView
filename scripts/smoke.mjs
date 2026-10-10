// Headless end-to-end check against scripts/dev-mock.js:
//   node scripts/smoke.mjs <outDir>
// Signs up, opens a display (bedroom-frame user agent and size), pairs it
// through the UI, edits a view in the editor (album, text, drag, weather,
// entity), publishes, and screenshots every step. Fails on console errors.
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium),
// or PLAYWRIGHT=/path/to/playwright/index.mjs.
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { mkdirSync } from "node:fs";

const out = process.argv[2] || "/tmp/cvs-smoke";
mkdirSync(out, { recursive: true });
const STUDIO = process.env.STUDIO || "http://127.0.0.1:3297";
const DISPLAY = process.env.DISPLAY_URL || "http://127.0.0.1:3296";
const OLD_UA = "Mozilla/5.0 (Linux; Android 6.0.1; ZN-DP1001 Build/MXC89K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/44.0.2403.119 Safari/537.36";
const errors = [];
const watch = (page, name) => {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
};
const shot = (page, n) => page.screenshot({ path: `${out}/${n}.png` });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await shot(studio, "01-screens-empty");

  const display = await (await browser.newContext({ viewport: { width: 1024, height: 600 }, userAgent: OLD_UA })).newPage();
  watch(display, "display");
  await display.goto(DISPLAY);
  await display.waitForSelector("#pairCode:not(:empty)");
  await pause(300);
  const code = (await display.textContent("#pairCode")).trim();
  await shot(display, "02-display-pairing");

  await studio.waitForSelector("text=A display is waiting to be paired", { timeout: 5000 });
  await shot(studio, "03-screens-waiting");
  await studio.click("text=Pair it");
  await studio.fill(".modal input[placeholder^='e.g.']", "Master Bedroom Frame");
  await studio.click(".modal-actions >> text=Pair");
  await studio.waitForSelector("text=Master Bedroom Frame");
  await pause(800);
  await shot(studio, "04-screens-paired");
  if (!code) errors.push("no pairing code");

  // Open the view the screen got and edit it.
  await studio.click("text=Edit view");
  await studio.waitForSelector(".ed-canvas .cv-stage");
  await pause(500);
  // Select the photo widget by clicking the middle of the canvas, pick an album.
  const box = await studio.locator(".ed-overlay").boundingBox();
  await studio.mouse.dblclick(box.x + box.width * 0.6, box.y + box.height * 0.7);
  await studio.click(".album >> text=Family Frame (sample)");
  await pause(800);
  // Add a text widget and drag it to the bottom left.
  await studio.click(".ed-widget >> text=Text");
  await studio.fill(".ed-inspector textarea", "Welcome home!");
  await pause(300);
  const sel = await studio.locator(".ed-sel").boundingBox();
  await studio.mouse.move(sel.x + sel.width / 2, sel.y + sel.height / 2);
  await studio.mouse.down();
  await studio.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.88, { steps: 12 });
  await studio.mouse.up();
  // Weather (opens the entity picker), then an HA tile.
  await studio.click(".ed-widget >> text=Weather");
  await studio.click(".entity >> text=Forecast Home");
  await pause(300);
  await studio.click(".ed-widget >> text=Home Assistant tile");
  await studio.fill(".modal input", "front");
  await studio.click(".entity >> text=Front Door");
  await pause(1500);
  await shot(studio, "05-editor");
  await studio.click("button:has-text('Publish')");
  await studio.waitForSelector("text=updating now");
  await pause(2500);
  await shot(studio, "06-editor-published");

  await shot(display, "07-display-live");
  const widgets = await display.locator(".cv-widget").count();
  if (widgets < 4) errors.push(`display shows ${widgets} widgets, expected 4+`);
  const text = await display.textContent(".cv-stage");
  if (!text.includes("Welcome home!")) errors.push("published text not on display");

  // Back to screens: live thumbnail + camera pop-up test.
  await studio.click("text=← Views");
  await studio.click("text=Screens");
  await pause(1500);
  await shot(studio, "08-screens-live");
  await studio.click("text=Camera pop-up");
  // Cameras come from Frigate; without FRIGATE_URL there are none to pick.
  if (await studio.waitForSelector(".cam-row", { timeout: 5000 }).catch(() => null)) {
    await studio.check(".modal .check.big input");
    await studio.locator(".cam-row input").first().check();
    await shot(studio, "09-overlay-dialog");
    await studio.click("text=Save and test");
    await pause(2500);
    await shot(display, "10-display-overlay");
  } else {
    console.log("no Frigate cameras (set FRIGATE_URL to test the camera pop-up); skipping that step");
    // The camera list's 503 (no Frigate configured) is expected here.
    for (let i = errors.length - 1; i >= 0; i--) if (/status of 503/.test(errors[i])) errors.splice(i, 1);
    await studio.keyboard.press("Escape");
  }

  // Views page.
  await studio.goto(`${STUDIO}/#/views`);
  await pause(1200);
  await shot(studio, "11-views");
  // Phone width.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await studio.context().storageState() })).newPage();
  watch(phone, "phone");
  await phone.goto(STUDIO);
  await pause(1200);
  await phone.screenshot({ path: `${out}/12-phone-screens.png`, fullPage: true });
} finally {
  await browser.close();
}
const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) { console.log("ERRORS:\n" + real.join("\n")); process.exit(1); }
console.log("smoke ok");
