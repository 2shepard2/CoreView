// Holiday themes: the calendar, the house-wide setting and each screen's level.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const seasons = require("../lib/seasons");
const { createApp } = require("../server");

test("Thanksgiving is the fourth Thursday of November", () => {
  assert.equal(seasons.thanksgivingDay(2026), 26);
  assert.equal(seasons.thanksgivingDay(2027), 25);
  assert.equal(seasons.thanksgivingDay(2025), 27);
  assert.equal(seasons.thanksgivingDay(2029), 22);
});

test("the calendar picks one theme per day", () => {
  const c = (mo, d, y = 2026) => seasons.calendarTheme(y, mo - 1, d);
  assert.equal(c(10, 14), null);
  assert.equal(c(10, 15), "halloween");
  assert.equal(c(10, 31), "halloween");
  assert.equal(c(11, 1), "thanksgiving");
  assert.equal(c(11, 26), "thanksgiving");
  assert.equal(c(11, 27), "christmas");
  assert.equal(c(12, 26), "christmas");
  assert.equal(c(12, 27), "newyear");
  assert.equal(c(1, 1), "newyear");
  assert.equal(c(1, 2), null);
  assert.equal(c(7, 4), null);
});

test("mode and level: auto, forced, off; a screen can opt out", () => {
  const oct25 = new Date(2026, 9, 25, 12).getTime(), jul = new Date(2026, 6, 4, 12).getTime();
  assert.equal(seasons.activeTheme("auto", oct25), "halloween");
  assert.equal(seasons.activeTheme("auto", jul), null);
  assert.equal(seasons.activeTheme("christmas", jul), "christmas");
  assert.equal(seasons.activeTheme("off", oct25), null);
  assert.equal(seasons.activeTheme("bogus", oct25), "halloween", "unknown modes fall back to auto");
  assert.deepEqual(seasons.screenTheme("auto", {}, oct25), { id: "halloween", level: "full" });
  assert.deepEqual(seasons.screenTheme("auto", { seasonal: "light" }, oct25), { id: "halloween", level: "light" });
  assert.equal(seasons.screenTheme("auto", { seasonal: "off" }, oct25), null);
});

test("the setting reaches the display, and a screen's level is saved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvs-"));
  fs.writeFileSync(path.join(dir, "agent_token"), "test-agent-token");
  const app = createApp({ DATA_DIR: dir, COOKIE_SECURE: "0", AGENT_TOKEN_FILE: path.join(dir, "agent_token") },
    { immich: { configured: () => false }, overlays: { start() { return this; }, stop() {}, listCameras: async () => [] } }).start();
  const d = http.createServer(app.displayHandler).listen(0), a = http.createServer(app.adminHandler).listen(0);
  await Promise.all([new Promise((r) => d.once("listening", r)), new Promise((r) => a.once("listening", r))]);
  const disp = `http://127.0.0.1:${d.address().port}`, admin = `http://127.0.0.1:${a.address().port}`;
  const agent = (method, url, body) => fetch(url, { method, headers: { Authorization: "Bearer test-agent-token", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  try {
    const hello = await fetch(`${disp}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const code = (await hello.json()).code, cookie = hello.headers.get("set-cookie").split(";")[0];
    const paired = (await agent("POST", `${admin}/api/pair`, { code, name: "Kitchen" })).data;
    const again = async () => (await (await fetch(`${disp}/api/hello`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" })).json()).screen.theme;

    assert.equal((await agent("PUT", `${admin}/api/seasonal`, { mode: "nope" })).status, 400);
    const r = (await agent("PUT", `${admin}/api/seasonal`, { mode: "christmas" })).data;
    assert.equal(r.mode, "christmas"); assert.equal(r.active, "christmas");
    assert.deepEqual(await again(), { id: "christmas", level: "full" });
    assert.equal((await agent("GET", `${admin}/api/state`)).data.seasonal.mode, "christmas");

    const saved = (await agent("PATCH", `${admin}/api/screens/${paired.screenId}`, { seasonal: "light" })).data;
    assert.equal(saved.seasonal, "light");
    assert.deepEqual(await again(), { id: "christmas", level: "light" });
    await agent("PATCH", `${admin}/api/screens/${paired.screenId}`, { seasonal: "sideways" });
    assert.deepEqual(await again(), { id: "christmas", level: "full" }, "junk levels clean to full");

    await agent("PUT", `${admin}/api/seasonal`, { mode: "off" });
    assert.equal(await again(), null);
  } finally { app.stop(); d.close(); a.close(); }
});
