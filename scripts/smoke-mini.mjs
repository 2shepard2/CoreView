// Headless check of the bedroom matrix card against scripts/dev-mock.js:
//   node scripts/smoke-mini.mjs <outDir>
// Signs up, finds the Bedroom matrix card, opens Settings (adds a person,
// saves), opens "Try a scene" without pressing anything. Fails on console errors.
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium),
// or PLAYWRIGHT=/path/to/playwright/index.mjs.
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
import { mkdirSync } from "node:fs";

const out = process.argv[2] || "/tmp/cvs-smoke-mini";
mkdirSync(out, { recursive: true });
const STUDIO = process.env.STUDIO || "http://127.0.0.1:3297";
const errors = [];
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(STUDIO);
  await page.fill("input[name=code]", "dev-setup");
  await page.fill("input[name=username]", "admin");
  await page.fill("input[name=password]", "dev-password-1");
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Bedroom matrix");
  await page.locator("h2", { hasText: "Bedroom matrix" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/01-card.png` });
  const card = page.locator(".matrix-card", { hasText: "WLED at" });
  await card.locator("text=Settings").click();
  await page.waitForSelector(".modal >> text=Quiet hours");
  await page.screenshot({ path: `${out}/02-settings.png`, fullPage: true });
  // Fresh install: no people yet. Add one the way a user would.
  await page.locator(".modal button", { hasText: "+ Add" }).first().click();
  const row = page.locator(".modal .mini-list").first().locator(".mini-row").first();
  await row.locator("input").nth(0).fill("person.alex");
  await row.locator("input").nth(1).fill("POP");
  await page.click(".modal-actions >> text=Save");
  await page.waitForTimeout(500);
  await card.locator("text=Try a scene").click();
  await page.waitForSelector(".modal >> text=Plays on the matrix");
  await page.screenshot({ path: `${out}/03-try.png` });
  const state = await page.evaluate(async () => (await (await fetch("/api/state")).json()).minimatrix[0].people[0].label);
  if (state !== "POP") errors.push(`settings not saved: ${state}`);
} finally {
  await browser.close();
}
if (errors.length) { console.error("FAIL\n" + errors.join("\n")); process.exit(1); }
console.log("ok", out);
