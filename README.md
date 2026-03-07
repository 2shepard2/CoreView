# CoreView

CoreView is a self-hosted smart signage control plane.

It provides a centralized way to register displays, design reusable content, assign runtime views, and automate behavior from Home Assistant, MQTT, Frigate, and optional Immich.

## Core Model

CoreView is built around a view-based runtime model:
- `Widgets` are reusable content blocks
- `Profiles` compose content layouts and defaults
- `Themes` define visual presentation
- `Views` bind profile + theme and act as the runtime abstraction layer
- `Screens` consume views
- URL-published views also consume views (no screen enrollment required)
- `Rules` and manual overrides apply temporary runtime changes

Runtime is computed as:
- Assigned view defaults
- Plus rule/manual temporary overrides (when active)

## Navigation and IA

Top-level routes:
- `/system`
- `/views`
- `/design`
- `/automation`
- `/targets`

Section structure:
- `System`: Status, Setup, Help
- `Views`: view creation, assignment, URL publishing
- `Design`: Profiles, Widgets, Themes
- `Automation`: Rules, Banners, Tickers, Manual Control
- `Targets`: Screens, Groups

Each section includes contextual **How This Connects** relationship panels to show direct dependencies (for example: Widgets -> Profiles -> Views -> Screens).

## Visual System

CoreView uses an industrial dark visual system:
- calm, infrastructure-style surfaces
- low-noise hierarchy for operational use
- red as controlled accent for active/critical emphasis
- no marketing gradients/glow treatment

## Features

- Single URL screen enrollment with pairing code
- Screen inventory with friendly names and group membership
- View-first runtime model for both enrolled screens and published URLs
- Custom widgets (clock, entity, status, weather, text, map, photo, camera)
- Reusable banners and tickers with Home Assistant entity interpolation
- Rules engine:
  - schedule triggers
  - Home Assistant state triggers
  - Frigate event triggers
- Manual control with temporary overrides and manual rule trigger
- Home Assistant entity discovery and state cache
- MQTT command/event transport
- Frigate camera/snapshot integration
- Optional Immich photo slideshow integration
- Encrypted secret storage
- Config export/import and nightly backups

## Deployment (Docker)

Deployment assets are in `deployments/signage-server`.

Key files:
- `docker-compose.yml`
- `install.sh`
- `server/server.js`
- `server/public/app.html`
- `server/public/index.html`

Runtime storage:
- `./data/signage.db`
- `./data/backups/`
- `./data/app-secret.key`

## Prerequisites

- Linux host/VM with Docker Engine
- Docker Compose plugin (`docker compose`)
- Reachability to required integrations:
  - MQTT broker
  - Home Assistant
- Optional integrations:
  - Frigate
  - Immich
- Recommended: reverse proxy + stable DNS name

## Quick Start

From `deployments/signage-server`:

```bash
./install.sh
```

If `.env` does not exist, first run creates it and exits.
Run again to start containers.

Manual alternative:

```bash
docker compose up -d --build
```

Open:

```text
http://<host>:3210/system
```

## First Run Checklist

1. Open `/system` and complete **Initial Setup**.
2. Set admin password and provide a bootstrap token through `COREVIEW_BOOTSTRAP_TOKEN` or `BOOTSTRAP_TOKEN` before first startup.
3. Configure integrations in `System -> Setup -> Integrations`.
4. Create at least one `Theme` and one `Profile` in `Design`.
5. Create at least one `View` in `Views`.
6. Register screens in `Targets -> Screens` and assign each a view.
7. Verify runtime in `System -> Status`.

## Operating Workflow

Recommended sequence:

1. `Targets -> Screens, Groups`
2. `Design -> Widgets, Profiles, Themes`
3. `Views -> bind profile/theme and assign to screens`
4. `Automation -> Rules, Banners, Tickers`
5. `Automation -> Manual Control` for testing
6. `System -> Status` for live validation

Use this rule of thumb:
- persistent state -> update the assigned `View` and referenced design assets
- event/time response -> use `Rules`
- ad-hoc temporary action -> use `Manual Control`

## Backups and Restore

CoreView supports:
- nightly automatic backups (2:00 AM local server time)
- manual backup now
- export configuration JSON
- import configuration JSON (full replacement)

Recommended practice:
- keep nightly backups enabled
- create manual backup before major edits/upgrades
- preserve the full `data/` directory

## Security Notes

- Admin APIs require authenticated session
- Admin sessions are allowed over HTTP, but CoreView warns unless `ALLOW_INSECURE_HTTP=true` is set explicitly
- Media proxy endpoints require admin session or scoped media token
- Event webhook requests require `X-CoreView-Timestamp` and `X-CoreView-Signature` HMAC headers
- Secrets are encrypted at rest in SQLite using `data/app-secret.key`
- Keep `data/app-secret.key` with DB backups for full recovery

## Reverse Proxy Notes

CoreView is typically fronted by a reverse proxy.

Recommended behavior:
- route application traffic to the container port (`3210` by default)
- terminate TLS at proxy
- if you intentionally operate over LAN-only HTTP, set `ALLOW_INSECURE_HTTP=true` to suppress warnings after reviewing the risk
- keep admin UI on trusted network paths
- use one stable URL for screen clients and operators

## Updating

```bash
cd deployments/signage-server
docker compose pull
docker compose up -d --build
```

After update:
- open `/system`
- verify integration health
- verify registered screen presence and runtime
