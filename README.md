# CoreView

CoreView is a self-hosted control plane for managing smart displays. It integrates Home Assistant, MQTT, Frigate, and custom content into a unified runtime model built for reliability and clarity.

CoreView is designed for home labs, internal dashboards, and smart office environments where operators need deterministic control over distributed screens.

## Overview

CoreView separates control from presentation.

Operators use a structured admin interface to define content, automation rules, and runtime targets. Screen clients connect over WebSocket and render assigned Views in real time.

The system is built around a View-first model that eliminates dual bindings and ambiguous runtime state.

## Architecture at a Glance

CoreView operates as:

Operator  
-> Admin UI  
-> Control Plane (Node.js + SQLite)  
-> WebSocket Runtime Channel  
-> Screen Clients (Firestick, browser kiosk, HDMI display)

External integrations feed the control plane:

Home Assistant

MQTT

Frigate

Immich (optional)

All persistent state lives in the local data directory.

## Core Model

CoreView uses a View-based runtime abstraction.

Theme  
Defines visual styling.

Profile  
Defines layout structure and widget composition.

View  
Binds Theme and Profile into a runtime object.

Screen  
Is assigned exactly one View.

Screens never bind directly to Profiles or Themes. This guarantees a single source of truth for runtime presentation.

## Information Architecture

Top-level routes:

`/system`  
Platform status, setup, and diagnostics

`/views`  
View creation and assignment

`/design`  
Profiles, widgets, and themes

`/automation`  
Rules, banners, tickers, manual control

`/targets`  
Screens and groups

Admin operators should bookmark:

`http://host:3210/system`

Screen clients should load:

`http://host:3210/`

The root path automatically resolves to the display client.

## First Run

Set `COREVIEW_BOOTSTRAP_TOKEN` in your environment.

Start the container.

Open `/system` and complete onboarding.

Create a Theme.

Create a Profile.

Create a View.

Assign the View to a Screen.

## Docker Deployment

Clone the repository:

```bash
git clone <repo-url> coreview
cd coreview
```

Create a `.env` file.

Start:

```bash
docker compose up -d --build
```

CoreView listens on port `3210` by default.

## Data Directory

All persistent state is stored in:

`./data/`

This includes:

`signage.db`

encrypted secrets

backup files

Do not delete this directory during upgrades.

Before major upgrades, create a manual backup of the data directory.

## Upgrading

Before upgrading:

Stop the container.

Back up the data directory.

Pull the latest repository.

Rebuild and restart.

Review `CHANGELOG.md` for breaking changes before updating.

## Runtime Model

Screen clients connect via WebSocket and authenticate using device keys.

Admin sessions use signed tokens with timing-safe comparison.

Webhook integrations use HMAC signing with timestamp validation.

Published Views use signed tokens with expiration.

Media tokens are short-lived and rotated.

## Intended Use

CoreView is designed for:

Home lab environments

Internal dashboards

Smart office displays

LAN-based automation systems

It is not intended to operate as a public multi-tenant SaaS platform.

## Reverse Proxy

If exposing CoreView outside a trusted LAN, it must run behind HTTPS.

Common reverse proxy options:

Nginx

Traefik

Caddy

Nginx Proxy Manager

When using a reverse proxy, configure `TRUST_PROXY` appropriately and ensure forwarded headers are correct.

## Security Summary

CoreView enforces:

Device key authentication for screen clients

Timing-safe token validation

HMAC-signed webhook events

Content Security Policy headers

Strict security headers

Secure cookie handling when served over HTTPS

Refer to `SECURITY.md` for full details.
