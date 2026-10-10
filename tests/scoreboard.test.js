// Scoreboard: logo fetching/shrinking and the pixel layout shared by Studio's preview and the Beacon.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const L = require("../lib/logos");
const SB = require("../public/scoreboard");

// A tiny RGBA PNG: left half red, right half transparent.
function png(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = [0]; // filter: none
    for (let x = 0; x < w; x++) row.push(...(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    rows.push(Buffer.from(row));
  }
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(kind, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("logos: PNG decode, crop to the visible part, shrink to 18 and 15", () => {
  const img = L.decodePng(png(40, 20));
  assert.equal(img.width, 40);
  assert.deepEqual([...img.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal(img.rgba[(39) * 4 + 3], 0);
  const e = L.encode(png(40, 20));
  const g18 = Buffer.from(e[18], "base64"), g15 = Buffer.from(e[15], "base64");
  assert.equal(g18.length, 18 * 18 * 3);
  assert.equal(g15.length, 15 * 15 * 3);
  // The red block (20x20 after cropping) fills the whole square.
  assert.deepEqual([...g18.subarray(9 * 54 + 27, 9 * 54 + 30)], [252, 0, 0]);
  assert.throws(() => L.decodePng(Buffer.from("nope")));
});

test("logos: cache fetches once, reports ready, and backs off after a failure", async () => {
  let calls = 0, ready = [];
  const ok = L.createLogos({ fetch: async () => { calls++; return { ok: true, arrayBuffer: async () => png(8, 8) }; }, onReady: (u) => ready.push(u) });
  assert.equal(ok.get("https://x/a.png"), null);
  assert.equal(ok.get("https://x/a.png"), null); // still pending: no second fetch
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.deepEqual(ready, ["https://x/a.png"]);
  assert.ok(ok.get("https://x/a.png")[18]);
  assert.equal(ok.get("http://x/insecure.png"), null);
  let fails = 0;
  const bad = L.createLogos({ fetch: async () => { fails++; return { ok: false, status: 404 }; } });
  bad.get("https://x/b.png");
  await new Promise((r) => setImmediate(r));
  bad.get("https://x/b.png");
  assert.equal(fails, 1);
});

function frame(scene) {
  const px = {};
  SB.render(scene, 0, (x, y, c) => { px[x + "," + y] = c; });
  return px;
}

test("render: logos at the edges, scores beside them, pregame hides the 0-0", () => {
  const red = Buffer.alloc(18 * 18 * 3);
  for (let i = 0; i < red.length; i += 3) red[i] = 200;
  const scene = { kind: "scoreboard", homeLabel: "KC", guestLabel: "DEN", homeScore: "14", guestScore: "17", period: "Q3",
    remainingTime: "4:12", leftLogo: red.toString("base64"), rightLogo: "", ticker: "" };
  const p = frame(scene);
  assert.equal(p["1,2"], "#c80000");   // left logo top-left LED
  assert.equal(p["18,19"], "#c80000"); // and bottom-right
  assert.equal(p["23,8"], SB.palette.red);  // top of the "1" in 14: score starts 2 px after the logo
  assert.equal(p["70,0"], SB.palette.amber); // no right logo: DEN over its score instead
  const pre = frame({ ...scene, period: "PRE", remainingTime: "1:25PM" });
  let lit = 0;
  for (let x = 21; x < 33; x++) for (let y = 8; y < 19; y++) if (pre[x + "," + y] === SB.palette.red) lit++;
  assert.equal(lit, 0);
});

test("compile: pregame shows the local start time", () => {
  const sc = SB.compile({ entityId: "sensor.x" }, { entityId: "sensor.x", state: "PRE", attributes: { team_abbr: "ARI", opponent_abbr: "DET",
    team_homeaway: "home", date: "2026-10-11T20:25Z", sport: "football" } });
  assert.equal(sc.period, "PRE");
  assert.match(sc.remainingTime, /^\d{1,2}:\d{2}[AP]M$/);
  assert.equal(sc.homeLabel, "DET");
  assert.equal(sc.leftLogo, "");
});
