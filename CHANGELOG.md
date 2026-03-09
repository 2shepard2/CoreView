# Changelog

All notable changes to CoreView should be documented in this file.

## 1.0.0

Initial cohesive product baseline.

Core platform:
- single-URL device provisioning with pairing codes
- server-owned screen runtime with reconnect restore
- SQLite-backed configuration and runtime state
- encrypted-at-rest secret settings using an instance-local key
- admin onboarding, login, and server-side integration settings
- JSON export/import plus nightly automatic backups

First-class objects:
- screens
- groups (including built-in virtual `all`)
- profiles
- themes
- banners
- tickers
- rules

Rules engine:
- Frigate event triggers
- Home Assistant state triggers
- scheduled daily triggers
- transient override actions for:
  - overlay
  - theme
  - profile
  - banner
  - ticker

Integrations:
- Home Assistant live entity/state data
- Frigate MQTT event ingestion
- MQTT transport for screen messaging
- Immich-backed photo slideshow support

Dashboard and UX:
- top-level navigation aligned to the product model
- `System Status` as the default view
- `Screens` and `Groups` promoted to top-level management surfaces
- explicit create/edit modes with selected-chip highlighting
- `Temporary Overrides` replaces the old command-style operator workflow
- setup split into integration and backup concerns

Authoring improvements:
- custom profile widget builder
- custom widgets now support:
  - weather
  - status
- grouped ticker builder with guard rails
- HA entity pickers and token insertion helpers
- banner/ticker server-side templating against the HA cache

Operational improvements:
- screen remove/unregister flow with immediate return to provisioning
- screen re-registration flow validated
- integration health reflected in hero and per-card status lines
