# Recipe: add a widget

How to add a new widget (a clock, a card, or a whole "world" like the Aquarium
or Terrarium) so it shows up in the Studio palette, saves, renders on every
screen, and is tested. Worked example to copy: the Aquarium, commit `54ad9fe`
(`git show 54ad9fe --stat` lists every file it touched).

Read [design-guide.md](design-guide.md) before you draw anything.

## 0. Decide before coding

- **Type id**: short, lowercase, unique (`aquarium`, `station`). It is stored in
  every saved view; renaming later breaks views.
- **Family file**: a new world gets its own `public/render-<id>.js`. A small
  widget joins an existing family file (`render-household.js` for family data,
  `render-lab.js` for lab data).
- **Data**: Home Assistant entities (any widget can read them), or a server
  feed (`lab` = Prometheus via `lib/lab.js`, `jellyfin`, `drives`...). A new
  feed means server work in `lib/` and `viewNeeds()`: keep that a separate,
  reviewed change.
- **States you will draw**: list them now (normal, each warning, data missing).
  Each becomes a smoke-test scene in step 6.
- **Thresholds** (when is a host "hot", a disk "nearly full"): reuse the ones
  an existing widget already uses for the same data (Terrarium for lab data:
  disk >= 85% full or wear >= 70% = amber; degraded/critical = red). If a family
  might reasonably disagree with a threshold, make it a field with that default
  (the Aquarium's `coolBelow`/`warmAbove`). Otherwise pick a sensible household
  default and say which in your report.

## 1. Catalog entry: `lib/widgets.js`

Add an entry to `WIDGETS`:

```js
station: {
  name: "The Station", icon: "🚉", minChrome: 44,
  description: "One plain sentence a family member understands.",
  size: { w: 100, h: 100 },            // default box, percent of the screen
  fields: [
    { key: "title", label: "Title", kind: "text", default: "The Station" },
    // kinds: text, number(min,max,step), toggle, color, select(options),
    // entity(domain), rows(max, fields), plus helpers PEOPLE_ROW, SIZE(d)
    SIZE(2)
  ]
},
```

- Labels are plain English for the household, not developer words.
- Every field needs a `default`; optional entity fields set `optional: true`.
- If it needs a server feed, add it in `viewNeeds()` (search for
  `w.type === "terrarium"` to see the `lab` feed).
- `interactive: true` only if screens can tap it.

## 2. Renderer: `public/render-<id>.js`

Copy the shape of `public/render-aquarium.js`:

```js
/* What it shows, as a short list of "thing -> how it looks". ES5 only. */
(function () {
  'use strict';
  if (typeof CVRender === 'undefined') return;
  var U = CVRender.util, el = U.el, clear = U.clear;

  function stationWidget(box, stage) {
    var props = {}, sig = null;
    var root = el('div', 'st-root', box);
    function read() { /* everything the picture depends on, as plain data */ }
    function render() {
      var d = read(), s = JSON.stringify([d, props]);
      if (s === sig) return;            // only redraw on change
      sig = s;
      box.style.fontSize = (props.size || 2) * stage.height / 100 + 'px';
      clear(root);
      /* build DOM / inline SVG in em units */
    }
    return {
      update: function (p) { props = p || {}; sig = null; render(); }, // view config changed
      states: render,      // Home Assistant states changed
      data: render,        // a server feed changed (stage.data.lab etc.)
      tick: function () { /* called often: redraw at most once a minute */ }
      // optional: destroy (clear your timers), kids (kids mode toggled)
    };
  }
  CVRender.register('station', stationWidget);
})();
```

Rules:

- Size everything in **em** of the widget box; `size` scales the whole thing.
- HA state: `U.stateOf(stage, entityId)`; time: `stage.now()`,
  `CVRender.localParts(stage.now(), stage.tzOffsetMin)`; lab data:
  `stage.data.lab` (shape: `terrariumFixture()` in `scripts/dev-mock.js`).
- **Server feed contract** (`lib/household.js`): the lab is polled every 30 s.
  A good snapshot has `ok: true` and `at` (ms epoch). When a poll fails the
  server keeps the last good numbers but sets `ok: false, stale: true, error`.
  Any measurement may be `null` (unknown). So: treat `!data`, `ok === false`,
  `stale`, or `at` older than about 3 minutes as "can't hear"; draw `null`
  as unknown (grey), never as zero or fine.
- Count configured vs answered sources; if nothing answers, draw the
  "can't hear" state (design guide, rule 3).
- Animations: CSS keyframes with `-webkit-` prefixes, **defined in
  `public/render.css`** (the CSP blocks runtime `<style>` elements). Vary them
  per element with `el.style.animationDuration` / `animationDelay` (and the
  `webkit` twins); derive delays from `stage.now()` so redraws don't restart
  them. Need movement along a path of varying length? Animate a percentage
  (`left: 0%` -> `100%`) inside a positioned track, not pixel keyframes.
- SVG: building it with `innerHTML` is fine, but no `style="..."` attributes in
  the string (use `fill`/`stroke` attributes or classes).
- CSS for the widget goes in `public/render.css` under a short prefix
  (`.st-`). Chrome 44 CSS only. See AGENTS.md rule 6 (CSP).

## 3. Wire the file in (4 places)

1. `public/display.html`: `<script src="render-<id>.js"></script>`
2. `public/studio/index.html`: `<script src="/render-<id>.js"></script>`
3. `server.js`: add `render-<id>.js` to `DISPLAY_FILES` and the two GET
   allowlists that list `/render-aquarium.js` (search for it).
4. `tests/es5.test.js`: add it to `DISPLAY_JS`.

Miss one and the widget works in the editor but is blank (or 404s) on screens.

## 4. Mock data: `scripts/dev-mock.js`

Add the fake entities or fixture fields your scenes need (no real names).

- HA data: the mock's `POST /dev/state {"entity_id": {"state": ...}}` changes
  states live (see `smoke-aquarium.mjs`).
- Lab data: the mock only enables the lab feed when `FIREWALL_STATE` is set;
  it then serves `terrariumFixture(FIREWALL_STATE)`. For your own scenes, add
  a fixture function next to it that starts from `terrariumFixture()` and
  changes one thing per scene, selected by an env var (the Station uses
  `STATION_SCENE`), and start a fresh mock per scene. "Lab missing" = start
  the mock without the lab feed (a fixture returning `null` breaks the
  adapter); "stale" = return the fixture with `ok: false, stale: true`.

## 5. Tests

- `npm test` must pass (it includes the ES5 parser and banned-API checks).
- Add a unit test if you added logic outside the renderer (server feed,
  `viewNeeds`, catalog validation).

## 6. Smoke script: `scripts/smoke-<id>.mjs`

**Include a real-size scene.** Fixtures are small (4 hosts, 4 services); real
installs are not (one home lab has 4 hosts and about 30 probed services with
names like "home assistant" and "photo-library-backup"). Add a scene at least that
big, with long names, and check the screenshot for overlapping labels. The
first Station build passed every small scene and was unreadable on real data.

Copy `scripts/smoke-aquarium.mjs`: start the mock, create a view with your
widget, pair a display, walk each state from step 0, screenshot each, assert
the words that must be on screen, and **fail on any console error** (that is
how CSP violations surface). Prerequisites: Playwright + Chromium
(`PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs`) and python3 with
Pillow. If no browser is available, write it and say it is unrun.

## 7. Commit and report

- One commit (or a short series) with a message saying what a family member
  sees, e.g. "New Station widget: the lab as a transit map".
- Report: files changed, `npm test` output summary, smoke status (ran with N
  screenshots / not run and why), and open design questions.
- Don't bump the version, publish, deploy, or touch a live install: the
  operator does that (see AGENTS.md task index).
