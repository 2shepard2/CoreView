// "Now showing": Jellyfin recently added + playing now, and its image proxy.
const test = require("node:test");
const assert = require("node:assert");
const { createJellyfin } = require("../lib/jellyfin");
const { viewNeeds, cleanView } = require("../lib/widgets");

const id = (n) => String(n).padStart(32, "0");
const MOVIE = { Id: id(1), Type: "Movie", Name: "Dune: Part Two", ProductionYear: 2024, OfficialRating: "PG-13", CommunityRating: 8.237,
  RunTimeTicks: 166 * 60 * 1e7, Genres: ["Science Fiction", "Adventure", "Drama", "Extra"], Overview: "Paul Atreides unites with Chani.",
  DateCreated: "2026-10-12T20:00:00Z", BackdropImageTags: ["b"] };
const ep = (n, season) => ({ Id: id(100 + n), Type: "Episode", Name: `Episode ${n}`, SeriesId: id(50), SeriesName: "Severance",
  ParentIndexNumber: season, IndexNumber: n, DateCreated: "2026-10-13T08:00:00Z", Overview: "episode plot" });
const SERIES = { Id: id(50), Type: "Series", Name: "Severance", ProductionYear: 2022, OfficialRating: "TV-MA", Genres: ["Drama", "Mystery"],
  Overview: "Mark leads a team of office workers.", BackdropImageTags: ["x"] };

function fakeFetch(log) {
  return async (url, opts) => {
    log.push(url);
    assert.match(opts.headers.Authorization, /^MediaBrowser Token="k3y"$/);
    const u = new URL(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, headers: new Map() });
    if (u.pathname === "/Items" && u.searchParams.get("Ids")) return json({ Items: [SERIES] });
    if (u.pathname === "/Items") return json({ Items: [ep(3, 2), MOVIE, ep(2, 2), ep(1, 2)] });
    if (u.pathname === "/Sessions") return json([
      { UserName: "Kaley", DeviceName: "Living Room TV", NowPlayingItem: { ...MOVIE }, PlayState: { PositionTicks: 60 * 60 * 1e7, IsPaused: false } },
      { UserName: "Sam", DeviceName: "Phone", NowPlayingItem: { Type: "Audio", Id: id(9) }, PlayState: {} }
    ]);
    if (/\/Images\//.test(u.pathname)) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Map([["content-type", "image/jpeg"]]) };
    return { ok: false, status: 404 };
  };
}

test("recently added: movies one by one, a show's episodes grouped with the show's details", async () => {
  const log = [];
  const jf = createJellyfin({ url: "http://jf:8096/", readKey: () => "k3y", fetchImpl: fakeFetch(log), now: () => 1e12 });
  const d = await jf.refresh();
  assert.equal(d.ok, true);
  assert.deepEqual(d.recent.map((x) => x.title), ["Severance", "Dune: Part Two"]);
  const show = d.recent[0];
  assert.equal(show.kind, "show");
  assert.deepEqual(show.episodes.map((e) => e.episode), [3, 2, 1]);
  assert.equal(show.rating, "TV-MA");
  assert.equal(show.overview, "Mark leads a team of office workers.", "the show's plot, not the episode's");
  assert.equal(show.poster, id(50));
  const movie = d.recent[1];
  assert.deepEqual([movie.minutes, movie.score, movie.genres.length, movie.backdrop], [166, 8.2, 3, id(1)]);
  assert.equal(d.playing.length, 1, "music sessions are skipped");
  assert.deepEqual([d.playing[0].who, d.playing[0].where, d.playing[0].position, d.playing[0].paused], ["Kaley", "Living Room TV", 3600000, false]);

  // Recent is cached for 5 minutes; sessions are asked every time.
  await jf.refresh();
  assert.equal(log.filter((u) => u.includes("/Items?SortBy")).length, 1);
  assert.equal(log.filter((u) => u.includes("/Sessions")).length, 2);
});

test("images only for listed items, as JPEG, cached", async () => {
  const log = [];
  const jf = createJellyfin({ url: "http://jf:8096", readKey: () => "k3y", fetchImpl: fakeFetch(log), now: () => 1e12 });
  assert.equal(await jf.image(id(1), "poster"), null, "nothing listed yet");
  await jf.refresh();
  const img = await jf.image(id(1), "poster");
  assert.equal(img.type, "image/jpeg");
  assert.ok(log.some((u) => u.includes(`/Items/${id(1)}/Images/Primary`) && u.includes("format=Jpg")));
  await jf.image(id(1), "poster");
  assert.equal(log.filter((u) => u.includes("/Images/")).length, 1, "second request from the cache");
  assert.equal(await jf.image(id(7), "poster"), null, "unknown item");
  assert.equal(await jf.image("../../System", "poster"), null);
  assert.equal(await jf.image(id(1), "logo"), null);
});

test("no key: not connected, no requests", async () => {
  const log = [];
  const jf = createJellyfin({ url: "http://jf:8096", readKey: () => "", fetchImpl: fakeFetch(log) });
  assert.deepEqual(await jf.refresh(), { ok: false, error: "Jellyfin isn't connected yet" });
  assert.equal(log.length, 0);
});

test("the widget asks for the jellyfin data key", () => {
  const v = cleanView({ widgets: [{ id: "n", type: "nowshowing", x: 0, y: 0, w: 100, h: 100, props: { mode: "nope", count: 99 } }] });
  assert.equal(v.widgets[0].props.mode, "both");
  assert.equal(v.widgets[0].props.count, 24);
  assert.deepEqual(viewNeeds(v).data, ["jellyfin"]);
});
