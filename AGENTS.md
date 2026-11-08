# CoreView Studio: guide for coding agents

Read this first, then the doc for your task. Written for any agent (Claude,
Codex, MiniMax) working in this repo with no one to ask.

CoreView Studio is a household screen builder: people design **views** in the
Studio editor (WYSIWYG, widgets placed in percent of the screen), pair
**screens** (old tablets, frames, an Echo Show, Fire TV, browsers), and every
screen renders its view live. One Node server (`server.js`, no framework)
serves the editor, the display pages and an SSE stream.

## Task index

| You were asked to... | Read |
|---|---|
| add a new widget / dashboard / "world" (Aquarium, Terrarium style) | [docs/adding-a-widget.md](docs/adding-a-widget.md) + [docs/design-guide.md](docs/design-guide.md) |
| change how something looks | [docs/design-guide.md](docs/design-guide.md) |
| work with Home Assistant data | [docs/home-assistant.md](docs/home-assistant.md) |
| touch the kitchen Matrix / MQTT | [docs/matrix-mqtt-protocol.md](docs/matrix-mqtt-protocol.md) |
| the HA add-on | [docs/home-assistant-addon.md](docs/home-assistant-addon.md) |
| deploy to a live install, assign a view to a screen | not in this repo: the operator's own runbook for their install (agents: search the operator's knowledge base for "CoreView recipes") |

## Hard rules (breaking one breaks a real screen)

1. **Display code is ES5 for Chrome 44.** Everything in `public/render*.js`,
   `display.js` and their CSS runs on a 2015-era frame. No `let`/`const`,
   arrow functions, template strings, `fetch`, `Promise`, `includes`,
   `Object.assign`, CSS variables, `gap`, `clamp()`, `inset`, `#rrggbbaa`.
   `tests/es5.test.js` enforces most of it; add every new display file to its
   `DISPLAY_JS` list. Server and editor code (`server.js`, `lib/`,
   `public/studio/`) are modern Node/JS.
2. **No emoji or icon fonts in rendered output.** Old Android has no colour
   emoji. Draw with inline SVG or CSS. (`icon` in `lib/widgets.js` is only the
   editor's palette icon and may be an emoji.)
3. **Never show a calm picture that might be lying.** If a widget's data source
   doesn't answer, it says so plainly (grey/still + "Can't hear Home
   Assistant"), never the last good state as if live.
4. **This repo is exported publicly** (release exports go to GitHub). No real
   names, addresses, IPs, entity ids of a real house, tokens or screenshots of
   a real home in code, tests, fixtures or docs. Use the Parker demo family and
   `scripts/dev-mock.js` fixtures.
5. **Secrets never enter the repo or logs.** The server reads them from files
   (`secrets/`) or env; don't add a new secret without an operator.
6. **Display pages run under a strict Content-Security-Policy**
   (`style-src 'self'; script-src 'self'`, see `CSP` in `server.js`). No
   `<style>` elements created at runtime, no `style="..."` in markup or
   `innerHTML` strings, no inline scripts or `on*=` attributes. Set styles
   through `element.style.prop = ...` (allowed); keyframes and classes live in
   `public/render.css`. A violation is silent in tests but shows as a console
   error in the smoke run, and on a real screen the style simply never applies.
7. **Saved views are validated by the server** against `lib/widgets.js`. A
   field you don't declare there is dropped on save.

## Layout

- `server.js`: HTTP server, SSE, auth, static allowlists for display files.
- `lib/widgets.js`: the widget catalog (fields, defaults, `minChrome`) and
  `viewNeeds()` (which data feeds a view needs).
- `lib/*.js`: data sources (Home Assistant, Immich, Prometheus `lab.js`,
  Jellyfin, maps, drives...).
- `public/render.js`: the shared renderer (`CVRender.create/register/util`).
- `public/render-<family>.js`: widget renderers, one family per file.
- `public/render.css`, `public/display.*`: display page; `public/studio/`: editor.
- `scripts/dev-mock.js`: full local preview with fake HA/Immich/lab data.
- `scripts/smoke-*.mjs`: headless Chromium walk-throughs with screenshots.
- `tests/*.test.js`: `node --test`.

## Commands

```bash
npm ci                 # once (dev dependency: acorn)
npm test               # all unit tests, including the ES5 check
node scripts/dev-mock.js            # local preview; prints the Studio and display URLs
FIREWALL_STATE=healthy node scripts/dev-mock.js   # same, with the lab (Terrarium) fixture
PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node scripts/smoke-aquarium.mjs /tmp/out
                       # example smoke: needs Playwright + Chromium (point PLAYWRIGHT at
                       # index.mjs, not index.js) and python3 with Pillow (the mock makes sample photos)
```

## Done means

`npm test` passes, the new display file is in the ES5 list, a smoke script for
the feature exists and (where a browser is available) has run with **zero
console errors** (CSP violations count; `npm test` can't see them), and the commit message says what a family member would see. If you
couldn't run the smoke script (no browser), say so in your report: don't claim
it passed.
