// Map tiles and drive times, against fake upstreams.
const test = require("node:test");
const assert = require("node:assert");
const { createTiles } = require("../lib/tiles");
const { createDrives, parseLatLon } = require("../lib/drives");

const png = (status = 200) => ({ ok: status === 200, status, headers: { get: () => "image/png" }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

test("tiles: picks the right source, caches, refuses junk and keyless traffic", async () => {
  const urls = [];
  let key = "";
  const t = createTiles({ tomtomKey: () => key, fetchImpl: async (u) => { urls.push(u); return png(); } });
  assert.ok(await t.tile("base", 8, 48, 103));
  assert.match(urls[0], /World_Dark_Gray_Base\/MapServer\/tile\/8\/103\/48$/);
  await t.tile("base", 8, 48, 103);
  assert.equal(urls.length, 1, "second request comes from the cache");
  await t.tile("radar", 8, 48, 103, 5); await t.tile("radar", 8, 48, 103, 2);
  assert.match(urls[1], /nexrad-n0q-900913\/8\/48\/103\.png$/);
  assert.match(urls[2], /nexrad-n0q-900913-m30m\//);
  assert.equal(await t.tile("traffic", 8, 48, 103), null, "no key, no traffic");
  key = "k&y";
  await t.tile("traffic", 8, 48, 103);
  assert.match(urls[3], /flow\/relative0-dark\/8\/48\/103\.png\?tileSize=256&key=k%26y$/);
  assert.equal(await t.tile("base", 8, 256, 0), null, "x outside the zoom level");
  assert.equal(await t.tile("radar", 8, 1, 1, 9), null, "no such frame");
  assert.equal(await t.tile("nope", 1, 0, 0), null);
});

test("tiles: a failed fetch keeps serving the last good tile", async () => {
  let now = 0, fail = false;
  const t = createTiles({ now: () => now, fetchImpl: async () => (fail ? png(500) : png()) });
  assert.ok(await t.tile("radar", 5, 1, 1, 5));
  now = 10 * 60e3; fail = true;
  assert.ok(await t.tile("radar", 5, 1, 1, 5), "stale beats a hole");
});

test("drive times: zones, lat,lon and the pace", async () => {
  assert.deepEqual(parseLatLon(" 33.48, -112.34 "), { lat: 33.48, lon: -112.34 });
  assert.equal(parseLatLon("Costco"), null);
  const states = { "zone.home": { attributes: { latitude: 33.41, longitude: -112.57 } }, "zone.office": { attributes: { latitude: 33.51, longitude: -112.27 } } };
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    return { ok: true, status: 200, json: async () => ({ routes: [{ summary: { travelTimeInSeconds: 1860, noTrafficTravelTimeInSeconds: 1560, historicTrafficTravelTimeInSeconds: 1700, trafficDelayInSeconds: 300, lengthInMeters: 34440 } }] }) };
  };
  const d = createDrives({ key: () => "k", states: () => states, fetchImpl, now: () => new Date(2026, 9, 26, 7), gap: 0 });
  const r = await d.refresh(["zone.office", "33.48,-112.34"]);
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.routes["zone.office"], at: 0 }, { minutes: 31, usual: 28, free: 26, delay: 5, miles: 21.4, at: 0 });
  assert.match(calls[0], /calculateRoute\/33\.41,-112\.57:33\.48,-112\.34\/json\?traffic=true/);
  assert.equal(await d.refresh(["zone.office", "33.48,-112.34"]), null, "not again within 10 minutes");
  assert.ok(await d.refresh(["zone.office"]), "a changed list refreshes at once");
});

test("drive times: a 403 says which API to turn on, and keeps old numbers", async () => {
  const states = { "zone.home": { attributes: { latitude: 33.41, longitude: -112.57 } } };
  let status = 200;
  const fetchImpl = async () => ({ ok: status === 200, status, json: async () => ({ routes: [{ summary: { travelTimeInSeconds: 600, lengthInMeters: 1000 } }] }) });
  const d = createDrives({ key: () => "k", states: () => states, fetchImpl, gap: 0 });
  await d.refresh(["33.4,-112.5"]);
  status = 403;
  const r = await d.refresh(["33.4,-112.5"], { force: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Routing API/);
  assert.equal(r.routes["33.4,-112.5"].minutes, 10);
  assert.equal(r.routes["33.4,-112.5"].stale, true);
  const none = createDrives({ key: () => "", states: () => states, fetchImpl });
  assert.equal((await none.refresh(["zone.x"])).error, "No TomTom key yet");
});

test("gas widget: keeps price sensors, drops junk, and the screen follows them", () => {
  const { cleanView, viewNeeds } = require("../lib/widgets");
  const v = cleanView({ aspect: { w: 1920, h: 1080 }, widgets: [{ id: "g", type: "gas", x: 0, y: 0, w: 30, h: 30, props: {
    rows: [{ label: "Costco", regular: "sensor.costco_regular_gas", premium: "sensor.costco_premium_gas" }, { label: "Bad", regular: "light.kitchen" }]
  } }] });
  const rows = v.widgets[0].props.rows;
  assert.equal(rows[0].premium, "sensor.costco_premium_gas");
  assert.equal(rows.length, 1); // a row without a usable price sensor is dropped
  assert.deepEqual(viewNeeds(v).entities.sort(), ["sensor.costco_premium_gas", "sensor.costco_regular_gas"]);
});
