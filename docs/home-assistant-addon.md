# Home Assistant add-on (v1)

Status: built (Codex, 2026-10-31), reviewed and tested on HAOS (Claude, 2026-11-01).
First released in 2.13.0.
Original design: Claude, 2026-10-31. The design below is retained for reference.

## Implementation decisions and changes

- Supervisor's socket is `ws://supervisor/core/websocket`, as documented in
  [Home Assistant's communication guide](https://contributors.home-assistant.io/apps/guides/communication/).
  The add-on sets opt-in `HA_WS_URL`; `lib/hass.js` keeps its existing
  `/api/websocket` default. REST remains `http://supervisor/core/api/...`.
- Releases from 2.13.0 include the `HA_WS_URL` override, so the add-on
  downloads its own version's tag unpatched. (A build-time patch for older
  tags was dropped in review: the add-on never builds an older tag.)
- Plan correction: `lib/mqtt.js` uses `net.connect` and the existing Settings
  validator accepts only `mqtt:`. Setting `mqtts://` would still send plain
  TCP credentials. TLS discovery/manual URLs are therefore declined with
  one plain log line, leaving MQTT configurable in Studio. Adding TLS support
  to the main client is separate work outside this change's permitted files.
- Root is used only for mounted-data ownership preparation; the launcher
  drops groups/GID/UID to 10250 before spawning the server, forwarding stop
  signals and propagating its exit status. No root runtime fallback.
- Discovery is bounded to 10 seconds and failures leave MQTT unset. Manual
  credentials never mix with discovered credentials. Setup/agent secrets
  persist at mode 0600, temporary secret files are recreated at mode 0600,
  and malformed persistent secrets/state fail closed.
- Review (Claude, 2026-11-01, Home Assistant OS, Supervisor 2026.10.5): `build.yaml`
  is deprecated and its `build_from` regex rejects `node:22-alpine`, and
  Supervisor always passes `BUILD_FROM=ghcr.io/home-assistant/base` (no Node),
  so the Dockerfile pins `FROM node:22-alpine` and `build.yaml` is gone. Optional
  options must not default to `""` (`url?` rejects it), so only the booleans and
  the topic root have defaults. Verified live: HA auto-connect (Supervisor
  socket, 1953 entities), MQTT auto-discovery (`core-mosquitto`), server as
  UID 10250, secrets 0600, display pairing and Studio setup pages render.
- Optional artwork is omitted. Ingress, GHCR, armv7, and runtime dependencies
  remain out of v1. Docker/Compose configuration is unchanged.

## Review build

The build context must be `ha-addon/`. Supervisor supplies `BUILD_VERSION`.
For a branch review, serve a `git archive` tarball from a directory reachable
by the Docker builder and override the download URL:

```sh
git archive --format=tar.gz --prefix=coreview/ HEAD > /tmp/coreview-review.tar.gz
# Serve the tarball over HTTP using your usual review tooling.
docker build --build-arg BUILD_VERSION=2.13.0 \
  --build-arg COREVIEW_TARBALL_URL=http://<review-host>:<port>/coreview-review.tar.gz \
  -t coreview-addon-review ha-addon
```

Run it with a disposable `/data` containing `options.json` and a fake
`SUPERVISOR_TOKEN` to check startup, ownership, secret modes, setup-code
logging and stop behavior. Then install as a local HA add-on and verify
HA entities, REST calendars, MQTT and display pairing with real Supervisor
services. After the matching release is published, also build once without
the URL override to verify the public archive.
The worker does not have Docker and makes no live infrastructure changes.

## Original design

## Why

Many CoreView users run Home Assistant OS on a Pi or a small box and have no
separate Docker host. An add-on lets them install CoreView from the HA add-on
store (custom repository URL) and skip most of the setup: HA and MQTT connect
themselves. The Docker/Compose install stays exactly as it is.

## Shape

```
repository.yaml              # HA custom-repository manifest (repo root)
ha-addon/                    # the add-on (folder = one add-on)
  config.yaml                # name, slug coreview, version, arch, ports, options/schema
  build.yaml                 # build_from: node:22-alpine for amd64/aarch64 (armv7 optional)
  Dockerfile                 # fetches the tagged CoreView release; no npm install needed
  run.js                     # entrypoint: /data/options.json + Supervisor -> env + secret files -> server.js
  DOCS.md                    # shown on the add-on's Documentation tab
  CHANGELOG.md
  icon.png, logo.png         # optional; reuse existing artwork if any
```

### Image / build

- v1: no prebuilt images. Supervisor builds `ha-addon/Dockerfile` on the device.
  The build context is only `ha-addon/`, so the Dockerfile downloads the
  release tarball for its version (`https://github.com/2shepard2/CoreView/archive/refs/tags/v${VERSION}.tar.gz`)
  and copies `package.json server.js lib public` the same way the root
  Dockerfile does. CoreView has no runtime npm dependencies, so this builds in
  seconds on any arch. Keep a build arg to point at another tarball for local
  testing.
- `ha-addon/config.yaml` `version` must equal `package.json` `version`; add a
  test that fails when they drift (releases bump both).
- Later (not v1): multi-arch images on GHCR from a tag workflow, then `image:`.

### Runtime (run.js, Node, no extra packages)

- `DATA_DIR=/data` (HA persists and backs it up). Ports 3216 (displays) and
  3217 (Studio) exposed via `ports:` so users can remap; `webui:
  http://[HOST]:[PORT:3217]`.
- `TZ` comes from Supervisor already; don't override.
- Secrets: write option values to files under `/tmp/secrets` (0600) and set the
  matching `*_FILE` env vars (`HA_TOKEN_FILE`, `MQTT_PASSWORD_FILE`,
  `IMMICH_KEY_FILE`, `JELLYFIN_KEY_FILE`, `TOMTOM_KEY_FILE`). Never log them.
- `agent_token` and `setup_code`: generate once into `/data/secrets/` (0600) if
  missing. Print the setup code to the add-on log on start while Studio is
  unclaimed, so first sign-in stays protected (see `lib/auth.js`).
- `COOKIE_SECURE`: option `cookie_secure`, default `false` (HA installs are
  usually plain HTTP on the LAN); DOCS explains when to turn it on.
- Map run.js's options -> env with a pure exported function and unit-test it.

### Home Assistant (automatic)

- `homeassistant_api: true`. Option `connect_home_assistant` (default true):
  set `HA_URL=http://supervisor/core` and the token file from
  `SUPERVISOR_TOKEN`. `lib/hass.js` builds `root + "/api/websocket"`; check
  which socket path Supervisor's proxy serves (`/core/websocket` vs
  `/core/api/websocket`) and, if needed, add the smallest change
  (e.g. an optional `HA_WS_URL` override) without changing the Docker path's
  behaviour. REST calls via `http://supervisor/core/api/...` should work as is.
- When false, set nothing, so Studio's Settings page can configure HA by hand.
- Note: server-provided settings make that service read-only in Studio
  (`lib/connections.js`). That is intended.

### MQTT (automatic, for the LED Matrix)

- `services: [mqtt:want]`. If `mqtt_url` option is blank, ask
  `GET http://supervisor/services/mqtt` (Bearer `SUPERVISOR_TOKEN`); on success
  set `MQTT_URL=mqtt://host:port` (mqtts if `ssl`), `MQTT_USERNAME`, password
  file. If no broker is available, leave MQTT unset and log one plain line.

### Other options (all optional, blank = feature off or set in Studio)

`immich_url`/`immich_api_key`, `frigate_url` (DOCS: Frigate add-on is
`http://ccab4aaf-frigate:5000`), `jellyfin_url`/`jellyfin_api_key`,
`tomtom_api_key`, `prometheus_url`, `mqtt_url`/`mqtt_username`/`mqtt_password`
(manual override), `mqtt_topic_root` (default `home/signage`),
`settings_lock` (default false). Use `password` schema type for keys and `url?`
/ `str?` for optional fields.

### Security

No `host_network`, `privileged`, `full_access`, `docker_api`, or device
access. Default AppArmor. Runs as the non-root `studio` user (UID 10250) if
`/data` permissions allow; otherwise document why it can't.

## Docs

- `ha-addon/DOCS.md`: install (add repository URL), first sign-in (setup code
  in the log), ports, displays (open `http://<ha-host>:3216` on each screen),
  options table, HTTPS/cookie note, Frigate/Immich examples.
- README: short "Install as a Home Assistant add-on" section linking DOCS.md,
  next to the existing Docker quick start.

## Not in v1

- Ingress / sidebar panel: Studio uses absolute paths (`/api/...` in
  `public/studio/*`) and has its own sign-in; displays can't use ingress
  anyway. Revisit if users ask.
- GHCR prebuilt images, armv7 testing, HA "Container"/"Core" installs (those
  users already have Docker).

## Acceptance

- `npm test` passes, including the new version-match and options->env tests.
- Root `Dockerfile`, `docker-compose.yml` and `.env.example` behaviour unchanged.
- Review (Claude): build the add-on image from the branch against a local
  tarball, run it with a fake `/data/options.json`, then install it on the
  lab's HA as a local add-on and check HA + MQTT auto-connect and a display page.
