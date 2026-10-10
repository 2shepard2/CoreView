// Immich: albums, album contents, and preview images.
//
// The API key stays on the server. Displays and the editor only ever get
// preview JPEGs through Studio, and only for photos in albums Studio uses.
// Album contents use POST /api/search/metadata with the v3.2 `filter` shape
// (the only shape that includes photos other album members added; see the
// 2026-09-30 note in V1's immich-album.js). Videos are skipped.
const fs = require("node:fs");
const path = require("node:path");

const ALBUM_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const CACHE_LIMIT_BYTES = 2 * 1024 ** 3;

class ImmichError extends Error {
  constructor(message, status) { super(message); this.name = "ImmichError"; this.status = status; }
}

function createImmich({ baseUrl, apiKeyFile, cacheDir, fetchImpl = fetch, log = () => {}, now = Date.now }) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const albums = new Map(); // albumId -> { at, assets: [...], refreshing }
  const known = new Set(); // asset ids that belong to a cached album
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });

  function key() {
    // Read on each use so secret-sync can rotate the key without a restart.
    return apiKeyFile && fs.existsSync(apiKeyFile) ? fs.readFileSync(apiKeyFile, "utf8").trim() : "";
  }
  const configured = () => Boolean(root && key());

  async function request(pathname, body) {
    const headers = { Accept: "application/json", "x-api-key": key() };
    const init = body === undefined ? { headers }
      : { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const rsp = await fetchImpl(`${root}${pathname}`, init);
    if (!rsp.ok) throw new ImmichError(`Immich ${pathname.split("?")[0]} failed (${rsp.status})`, rsp.status);
    return rsp.json();
  }

  async function listAlbums() {
    const [own, shared] = await Promise.all([request("/api/albums"), request("/api/albums?shared=true").catch(() => [])]);
    const byId = new Map();
    for (const a of [...own, ...shared]) {
      byId.set(a.id, { id: a.id, name: a.albumName, count: a.assetCount, thumb: a.albumThumbnailAssetId || null });
      if (a.albumThumbnailAssetId) known.add(a.albumThumbnailAssetId);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function slim(a) {
    const e = a.exifInfo || {};
    let w = Number(e.exifImageWidth) || 0, h = Number(e.exifImageHeight) || 0;
    // EXIF orientations 5-8 are rotated a quarter turn.
    if (["5", "6", "7", "8", 5, 6, 7, 8].includes(e.orientation)) [w, h] = [h, w];
    const place = [e.city, e.state, e.country].filter(Boolean);
    return {
      id: a.id,
      date: a.localDateTime || e.dateTimeOriginal || a.fileCreatedAt || null,
      place: place.length ? [...new Set(place)].slice(0, 2).join(", ") : null,
      portrait: w && h ? h > w : false
    };
  }

  async function fetchAlbum(albumId) {
    await request(`/api/albums/${encodeURIComponent(albumId)}?withoutAssets=true`);
    const out = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = {
        filter: { albumIds: { any: [albumId] }, visibility: { in: ["timeline", "archive"] }, trashedAt: { eq: null } },
        size: PAGE_SIZE, withExif: true
      };
      if (cursor) body.cursor = cursor;
      const result = await request("/api/search/metadata", body);
      for (const a of (result.assets && result.assets.items) || []) if (a.type === "IMAGE") out.push(slim(a));
      cursor = (result.assets && result.assets.nextCursor) || null;
      if (!cursor) break;
    }
    const seen = new Set();
    return out.filter((a) => !seen.has(a.id) && seen.add(a.id));
  }

  // Cached album contents; refreshed in the background once stale.
  async function album(albumId) {
    if (!/^[0-9a-f-]{36}$/.test(String(albumId))) throw new ImmichError("Bad album id", 400);
    let entry = albums.get(albumId);
    const refresh = async () => {
      const assets = await fetchAlbum(albumId);
      entry = { at: now(), assets };
      albums.set(albumId, entry);
      for (const a of assets) known.add(a.id);
      return entry;
    };
    if (!entry) entry = await refresh();
    else if (now() - entry.at > ALBUM_TTL_MS && !entry.refreshing) {
      entry.refreshing = true;
      refresh().catch((err) => { log(`immich: album refresh failed: ${err.message}`); entry.refreshing = false; });
    }
    return entry.assets;
  }

  // A preview image (about 1440px), from the disk cache when we have it.
  async function preview(assetId) {
    if (!/^[0-9a-f-]{36}$/.test(String(assetId)) || !known.has(assetId)) return null;
    const file = cacheDir && path.join(cacheDir, assetId);
    if (file && fs.existsSync(file)) {
      const now_ = new Date();
      fs.utimesSync(file, now_, now_);
      return { body: fs.readFileSync(file), type: fs.existsSync(file + ".type") ? fs.readFileSync(file + ".type", "utf8") : "image/jpeg" };
    }
    const rsp = await fetchImpl(`${root}/api/assets/${assetId}/thumbnail?size=preview`, { headers: { "x-api-key": key() } });
    if (!rsp.ok) throw new ImmichError(`Immich preview failed (${rsp.status})`, rsp.status);
    const body = Buffer.from(await rsp.arrayBuffer());
    const type = rsp.headers.get("content-type") || "image/jpeg";
    if (file) {
      fs.writeFileSync(file, body);
      fs.writeFileSync(file + ".type", type);
      trimCache();
    }
    return { body, type };
  }

  let trimming = false;
  function trimCache() {
    if (trimming || !cacheDir) return;
    trimming = true;
    try {
      const files = fs.readdirSync(cacheDir).filter((f) => !f.endsWith(".type"))
        .map((f) => { const p = path.join(cacheDir, f); const s = fs.statSync(p); return { p, size: s.size, at: s.mtimeMs }; });
      let total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files.sort((a, b) => a.at - b.at)) {
        if (total <= CACHE_LIMIT_BYTES) break;
        fs.rmSync(f.p, { force: true }); fs.rmSync(f.p + ".type", { force: true });
        total -= f.size;
      }
    } finally { trimming = false; }
  }

  return { configured, listAlbums, album, preview, isKnown: (id) => known.has(id) };
}

module.exports = { createImmich, ImmichError };
