// Jellyfin for the "Now showing" widget: what was added lately (movies, and
// new episodes grouped by show) and what someone is watching right now.
// The result is household data key "jellyfin" (lib/household.js pushes it).
//
// Needs an API key (Jellyfin Dashboard -> API Keys). Screens never talk to
// Jellyfin: posters and backdrops come through Studio (image()), and only for
// items in the current list.
const fs = require("node:fs");

const TICKS = 10000; // Jellyfin ticks are 100 ns
const FIELDS = "Overview,Genres,DateCreated,OfficialRating,CommunityRating,RunTimeTicks,ProductionYear";

function createJellyfin({ url, apiKeyFile, readKey, fetchImpl = fetch, log = () => {}, now = Date.now, recentMs = 5 * 60 * 1000 }) {
  const root = String(url || "").replace(/\/+$/, "");
  const key = readKey || (() => (apiKeyFile && fs.existsSync(apiKeyFile) ? fs.readFileSync(apiKeyFile, "utf8").trim() : ""));
  let recent = null, recentAt = 0, failing = false;
  const images = new Map(); // "<id>:<kind>" -> { body, type, at }
  let allowed = new Set();  // item ids screens may fetch images for

  const configured = () => Boolean(root && key());
  async function get(path) {
    const rsp = await fetchImpl(root + path, { headers: { Authorization: `MediaBrowser Token="${key()}"`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!rsp.ok) throw new Error(`Jellyfin said ${rsp.status}`);
    return rsp.json();
  }
  const mins = (ticks) => (ticks ? Math.round(ticks / TICKS / 60000) : null);
  const info = (x) => ({
    year: x.ProductionYear || null, rating: x.OfficialRating || "", score: x.CommunityRating ? Math.round(x.CommunityRating * 10) / 10 : null,
    minutes: mins(x.RunTimeTicks), genres: (x.Genres || []).slice(0, 3), overview: String(x.Overview || "").slice(0, 600)
  });
  const hasBackdrop = (x) => Boolean((x.BackdropImageTags || []).length);

  // Newest first: movies one by one, a show's new episodes as one entry.
  async function loadRecent() {
    const q = `/Items?SortBy=DateCreated&SortOrder=Descending&Recursive=true&IncludeItemTypes=Movie,Episode&IsMissing=false&Limit=80&Fields=${FIELDS}`;
    const items = (await get(q)).Items || [];
    const out = [], shows = new Map();
    for (const x of items) {
      if (x.Type === "Movie") {
        out.push({ id: x.Id, kind: "movie", title: x.Name, added: Date.parse(x.DateCreated) || null, poster: x.Id, backdrop: hasBackdrop(x) ? x.Id : null, ...info(x) });
      } else if (x.Type === "Episode" && x.SeriesId) {
        let s = shows.get(x.SeriesId);
        if (!s) {
          s = { id: x.SeriesId, kind: "show", title: x.SeriesName || "", added: Date.parse(x.DateCreated) || null, poster: x.SeriesId, backdrop: x.SeriesId, episodes: [] };
          shows.set(x.SeriesId, s);
          out.push(s);
        }
        if (s.episodes.length < 20) s.episodes.push({ season: x.ParentIndexNumber ?? null, episode: x.IndexNumber ?? null, name: x.Name || "" });
      }
      if (out.length >= 24) break;
    }
    // The show's own details (rating, genres, plot), not the episode's.
    if (shows.size) {
      const series = (await get(`/Items?Ids=${[...shows.keys()].join(",")}&Fields=${FIELDS}`)).Items || [];
      for (const x of series) {
        const s = shows.get(x.Id);
        if (!s) continue;
        Object.assign(s, info(x), { minutes: null });
        if (!hasBackdrop(x)) s.backdrop = null;
      }
    }
    return out;
  }

  // Sessions playing something now. Position is extrapolated on the screen
  // from `position` at `at` unless paused.
  async function loadPlaying() {
    const sessions = await get("/Sessions?ActiveWithinSeconds=900");
    const out = [];
    for (const s of sessions || []) {
      const x = s.NowPlayingItem;
      if (!x || !["Movie", "Episode"].includes(x.Type)) continue;
      const ep = x.Type === "Episode";
      out.push({
        id: x.Id, kind: ep ? "show" : "movie", title: ep ? x.SeriesName || x.Name : x.Name,
        episode: ep ? { season: x.ParentIndexNumber ?? null, episode: x.IndexNumber ?? null, name: x.Name || "" } : null,
        poster: ep && x.SeriesId ? x.SeriesId : x.Id,
        backdrop: ep && x.SeriesId ? x.SeriesId : hasBackdrop(x) ? x.Id : null,
        year: x.ProductionYear || null, rating: x.OfficialRating || "",
        genres: (x.Genres || []).slice(0, 3), overview: String(x.Overview || "").slice(0, 600),
        duration: x.RunTimeTicks ? Math.round(x.RunTimeTicks / TICKS) : null,
        position: s.PlayState && s.PlayState.PositionTicks ? Math.round(s.PlayState.PositionTicks / TICKS) : 0,
        paused: Boolean(s.PlayState && s.PlayState.IsPaused),
        who: s.UserName || "", where: s.DeviceName || s.Client || "", at: now()
      });
    }
    return out;
  }

  async function refresh() {
    if (!configured()) return { ok: false, error: "Jellyfin isn't connected yet" };
    try {
      if (!recent || now() - recentAt > recentMs) { recent = await loadRecent(); recentAt = now(); }
      const playing = await loadPlaying();
      allowed = new Set();
      for (const x of [...recent, ...playing]) for (const id of [x.poster, x.backdrop]) if (id) allowed.add(id);
      if (failing) log("jellyfin: reachable again");
      failing = false;
      return { ok: true, recent, playing };
    } catch (err) {
      if (!failing) log(`jellyfin: ${err.message}`);
      failing = true;
      return { ok: false, error: err.message };
    }
  }

  // A poster (2:3, up to 900 high) or backdrop (up to 1280 wide) as JPEG,
  // only for items in the current list. Kept in memory for a day.
  async function image(id, kind) {
    if (!/^[0-9a-f]{32}$/.test(id) || !["poster", "backdrop"].includes(kind) || !allowed.has(id)) return null;
    const k = `${id}:${kind}`, hit = images.get(k);
    if (hit && now() - hit.at < 864e5) return hit;
    const path = kind === "poster" ? `/Items/${id}/Images/Primary?maxHeight=900&quality=85&format=Jpg` : `/Items/${id}/Images/Backdrop/0?maxWidth=1280&quality=70&format=Jpg`;
    const rsp = await fetchImpl(root + path, { headers: { Authorization: `MediaBrowser Token="${key()}"` }, redirect: "error", signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!rsp || !rsp.ok) return null;
    const img = { body: Buffer.from(await rsp.arrayBuffer()), type: rsp.headers.get("content-type") || "image/jpeg", at: now() };
    images.set(k, img);
    while (images.size > 120) images.delete(images.keys().next().value);
    return img;
  }

  return { configured, refresh, image };
}

module.exports = { createJellyfin };
