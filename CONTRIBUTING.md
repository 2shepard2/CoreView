# Contributing to CoreView Studio

Thanks for your interest. CoreView Studio is a hobby project that a family
uses every day, so it values things that keep working on old tablets and
are easy to run at home over cleverness.

## Before you open an issue

- Check it on the latest `main` and look through existing issues.
- Include steps to reproduce, and your setup: the screen's device and browser
  (Studio shows it on the screen's card), Docker version, reverse proxy, and
  which integrations you use (Home Assistant, Immich, Frigate, MQTT, WLED).

## Before you open a pull request

- Keep changes focused; explain what changed and why.
- Don't commit secrets, `.env`, `data/`, or photos.
- Update the docs when behaviour changes.
- Run the checks:

  ```bash
  ./scripts/scan-secrets.sh
  npm test
  docker compose build
  ```

  For UI changes, also run a headless walk-through against
  `node scripts/dev-mock.js` (see README "Develop"), and add screenshots.

## Ground rules in the code

- **The display page must keep working on Chrome 44.** Everything a screen
  loads (`public/render*.js`, `public/display.js`) is ES5;
  `tests/es5.test.js` enforces it. Studio's own pages can use modern
  JavaScript.
- **Widgets are defined once** in `lib/widgets.js` (fields, defaults, the
  minimum browser). The editor builds its forms from it and the server
  validates against it.
- **The scoreboard has two renderers that must match** (`public/scoreboard.js`
  and `firmware/beacon/components/coreview_scoreboard.h`); run
  `firmware/beacon/tools/scoreboard_parity.js` after touching either.
- **Displays only get what their view needs.** A screen can only fetch photos,
  cameras and data used by its own view; keep it that way.
- No runtime npm dependencies: Studio is one Node.js process.

## Security reports

Please don't put security problems in public issues. Use GitHub's private
"Report a vulnerability" on the repository's Security tab.
