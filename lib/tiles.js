// Map tiles for the Map widget, fetched by the server so keys stay here and
// every screen shares one cache.
//
//   base     dark grey street map (Esri World Dark Gray Canvas; no key)
//   labels   its place names and road labels, drawn over the weather/traffic
//   radar    NWS NEXRAD base reflectivity from Iowa State's Mesonet (US only,
//            no key). Frames 0-5 are 50, 40 ... 0 minutes ago.
//   traffic  TomTom live traffic flow (needs the TomTom key, Traffic API)
//
// Tiles are cached in memory: base and labels for a day, radar and traffic for four
// minutes (the sources update about every five).
const RADAR_AGO = [50, 40, 30, 20, 10, 0];
const TTL = { base: 24 * 3600e3, labels: 24 * 3600e3, radar: 4 * 60e3, traffic: 4 * 60e3 };
const MAX_TILES = 2500;
const MAX_ZOOM = { base: 16, labels: 16, radar: 12, traffic: 18 };

function createTiles({ tomtomKey = () => "", fetchImpl = fetch, log = () => {}, now = Date.now } = {}) {
  const cache = new Map(); // key -> { body, type, at } (Map keeps insertion order: oldest first)
  const pending = new Map();

  function upstream(layer, z, x, y, frame) {
    if (layer === "base" || layer === "labels") {
      const name = layer === "base" ? "World_Dark_Gray_Base" : "World_Dark_Gray_Reference";
      return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${name}/MapServer/tile/${z}/${y}/${x}`;
    }
    if (layer === "radar") {
      const ago = RADAR_AGO[frame];
      const name = ago ? `nexrad-n0q-900913-m${String(ago).padStart(2, "0")}m` : "nexrad-n0q-900913";
      return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${name}/${z}/${x}/${y}.png`;
    }
    if (layer === "traffic") {
      const key = tomtomKey();
      if (!key) return null;
      return `https://api.tomtom.com/traffic/map/4/tile/flow/relative0-dark/${z}/${x}/${y}.png?tileSize=256&key=${encodeURIComponent(key)}`;
    }
    return null;
  }

  function valid(layer, z, x, y, frame) {
    if (!TTL[layer] || !Number.isInteger(z) || z < 0 || z > MAX_ZOOM[layer]) return false;
    const n = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return false;
    return layer !== "radar" || (Number.isInteger(frame) && frame >= 0 && frame < RADAR_AGO.length);
  }

  // { body, type } or null (the source failed or has no key).
  async function tile(layer, z, x, y, frame = 0) {
    if (!valid(layer, z, x, y, frame)) return null;
    const key = `${layer}/${z}/${x}/${y}/${layer === "radar" ? frame : 0}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL[layer]) return hit;
    if (pending.has(key)) return pending.get(key);
    const url = upstream(layer, z, x, y, frame);
    if (!url) return null;
    const job = (async () => {
      try {
        const r = await fetchImpl(url, { headers: { "User-Agent": "CoreView-Studio (home display)" }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) {
          if (r.status !== 404) log(`map tile ${layer} ${z}/${x}/${y}: HTTP ${r.status}`);
          return hit || null; // a stale tile beats a hole
        }
        const type = r.headers.get("content-type") || "image/png";
        if (!/^image\//.test(type)) return hit || null;
        const out = { body: Buffer.from(await r.arrayBuffer()), type, at: now() };
        cache.delete(key);
        cache.set(key, out);
        while (cache.size > MAX_TILES) cache.delete(cache.keys().next().value);
        return out;
      } catch (e) {
        log(`map tile ${layer} ${z}/${x}/${y}: ${e.message}`);
        return hit || null;
      } finally { pending.delete(key); }
    })();
    pending.set(key, job);
    return job;
  }

  return { tile, RADAR_AGO, size: () => cache.size };
}

module.exports = { createTiles, RADAR_AGO };
