// Drive times for the Drive times widget: TomTom routing with live traffic,
// from home to each destination a published view lists.
//
// A destination ("to") is a Home Assistant zone (zone.office), a "lat,lon"
// pair, or an address or business name (looked up once with TomTom's search,
// nearest to home, and kept).
// Routes refresh every 10 minutes from 5 AM to 10 PM and hourly overnight,
// which keeps a household well inside TomTom's free daily allowance.
const DAY_MS = 10 * 60e3, NIGHT_MS = 60 * 60e3;

function parseLatLon(s) {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(s || ""));
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// states: () => HA states map (zones; zone.home is the default start).
function createDrives({ key = () => "", states = () => ({}), fetchImpl = fetch, log = () => {}, now = () => new Date(), gap = 400 } = {}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, gap ? ms : 0));
  const geocoded = new Map(); // address -> { lat, lon } | null
  let last = 0, lastSet = "", result = { ok: false, routes: {}, error: "Not checked yet" };

  function zone(id) {
    const s = states()[id];
    const a = s && s.attributes;
    return a && Number.isFinite(a.latitude) && Number.isFinite(a.longitude) ? { lat: a.latitude, lon: a.longitude } : null;
  }

  async function where(to) {
    if (/^zone\.[a-z0-9_]+$/.test(to)) return zone(to);
    const ll = parseLatLon(to);
    if (ll) return ll;
    if (geocoded.has(to)) return geocoded.get(to);
    const home = zone("zone.home");
    const near = home ? `&lat=${home.lat}&lon=${home.lon}` : "";
    // Fuzzy search: addresses and business names ("Costco, Verrado Way, Buckeye"), nearest to home first.
    const r = await fetchImpl(`https://api.tomtom.com/search/2/search/${encodeURIComponent(to)}.json?limit=1${near}&key=${encodeURIComponent(key())}`,
      { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(r.status === 403 ? "The TomTom key isn't allowed to look up addresses (turn on the Search API for it)" : `TomTom search said ${r.status}`);
    const hit = ((await r.json()).results || [])[0];
    const pos = hit ? { lat: hit.position.lat, lon: hit.position.lon } : null;
    geocoded.set(to, pos);
    return pos;
  }

  async function route(from, dest, retry = true) {
    const r = await fetchImpl(`https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lon}:${dest.lat},${dest.lon}/json?traffic=true&computeTravelTimeFor=all&routeType=fastest&key=${encodeURIComponent(key())}`,
      { signal: AbortSignal.timeout(12000) });
    // The free tier allows a few requests a second: wait and try once more.
    if (r.status === 429 && retry) { await pause(1500); return route(from, dest, false); }
    if (!r.ok) throw new Error(r.status === 403 ? "The TomTom key isn't allowed to plan routes (turn on the Routing API for it)" : `TomTom routing said ${r.status}`);
    const s = (((await r.json()).routes || [])[0] || {}).summary;
    if (!s) throw new Error("No route found");
    return {
      minutes: Math.round(s.travelTimeInSeconds / 60),
      usual: Math.round((s.historicTrafficTravelTimeInSeconds || s.noTrafficTravelTimeInSeconds || s.travelTimeInSeconds) / 60),
      free: Math.round((s.noTrafficTravelTimeInSeconds || s.travelTimeInSeconds) / 60),
      delay: Math.round((s.trafficDelayInSeconds || 0) / 60),
      miles: Math.round(s.lengthInMeters / 160.934) / 10
    };
  }

  // dests: the "to" strings in use. Returns the result if it changed, else null.
  async function refresh(dests, { force = false } = {}) {
    const list = [...new Set(dests)].sort(), set = list.join("|");
    const hour = now().getHours(), every = hour >= 5 && hour < 22 ? DAY_MS : NIGHT_MS;
    if (!list.length) { last = 0; lastSet = ""; return null; }
    if (!force && set === lastSet && Date.now() - last < every) return null;
    last = Date.now(); lastSet = set;
    // Nothing to ask TomTom yet: try again next minute.
    if (!key()) { last = 0; result = { ok: false, routes: {}, error: "No TomTom key yet" }; return result; }
    const home = zone("zone.home");
    if (!home) { last = 0; result = { ok: false, routes: {}, error: "Waiting for Home Assistant's home location (zone.home)" }; return result; }
    const routes = {};
    let firstError = null;
    for (const to of list) {
      try {
        const dest = await where(to);
        if (Object.keys(routes).length) await pause(gap);
        routes[to] = dest ? { ...(await route(home, dest)), at: Date.now() } : { error: "Couldn't find that place" };
      } catch (e) {
        firstError = firstError || e.message;
        const prev = result.routes[to];
        routes[to] = prev && prev.minutes !== undefined ? { ...prev, stale: true } : { error: e.message };
      }
    }
    result = { ok: !firstError, routes, error: firstError, at: Date.now() };
    if (firstError) log(`drive times: ${firstError}`);
    return result;
  }

  return { refresh, snapshot: () => result, parseLatLon };
}

module.exports = { createDrives, parseLatLon };
