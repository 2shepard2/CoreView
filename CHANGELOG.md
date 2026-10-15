# Changelog

## 2.5.2 (2026-10) — Review fixes

- Month calendar: a cell too short for an event line shows coloured dots
  beside the date instead of clipped text, and the fit is measured rather
  than guessed.
- New README pictures of a household board and the logo scoreboard, with the
  scripts that make them.
- Restoring a backup no longer sets the Matrix back to an older revision
  (the Beacon ignored updates until Studio caught up).
- Changing or switching off Frigate stops the old watcher for good, even if
  it was waiting for an answer.
- Screens drop Jellyfin/Prometheus data as soon as that connection is
  changed or switched off, and a late answer from the old server is ignored.
- MQTT gives up on a broker that accepts the connection but never answers
  (10 s) and tries again, instead of waiting forever.
- A connection save that can't be written to disk changes nothing, so
  saving again works.

## 2.5.1 (2026-10) — Security fixes

- Keys are never sent along a redirect (Immich, Jellyfin, Home Assistant).
- After a connection's address changes, a request still under way to the old
  address no longer picks up the new key.

## 2.5.0 (2026-10) — Connections from the browser

- Set up **Home Assistant, MQTT, Immich, Frigate, Jellyfin and Prometheus on
  the Settings page**: address, user name (MQTT) and key. Studio tests the
  settings before saving (or "save anyway"), asks for your password again,
  and reconnects without a restart.
- Keys are write-only: stored in `data/connections.json` (readable only by
  Studio), never shown again, never in backups. **A saved key belongs to its
  address**: change the address and the key is forgotten, so a key can't be
  sent somewhere new.
- Anything set in `.env` / `secrets/` still wins and makes that service
  read-only in the browser (secret-sync style setups keep working as before).
  `SETTINGS_LOCK=1` makes every service read-only.

## 2.4.0 (2026-10) — Settings page

- **Settings** in Studio's sidebar: each connection (Home Assistant, MQTT,
  Immich, Frigate, Jellyfin, Prometheus) with its address, status and a
  **Test** button; the LED signs and their firmware; change the admin
  password (signs out other browsers); **download a backup** of screens,
  views and sign settings and **restore** it (the password, sign-ins and
  drawings are never in a backup; the previous setup is kept on the server as
  `data/studio.json.before-restore-*`); version and time zone.
- Addresses and keys are still set in `.env` and `secrets/`, not in the
  browser.

## 2.3.0 (2026-10) — Timers, Now showing

- **Now showing** widget: a movie-theatre poster for Jellyfin. Rotates
  through recently added movies and shows (new episodes grouped by show) and
  switches to what someone is watching, with a progress line. Set
  `JELLYFIN_URL` and put an API key in `secrets/jellyfin_api_key`.

- **Timer pop-up**: Home Assistant timers (`timer.*`) show as a countdown card
  over any screen's view (running, paused, a flashing "Done!"). Set per screen.
  Unlike V1's timer tile, the screen counts down by itself.
- **Matrix countdown**: new scene kind `countdown` with Beacon firmware 2.1
  (big digits, a progress line, "TIMER DONE" with a flashing border); older
  firmware shows the end time as text.

## 2.2.0 (2026-10) — CoreView Studio

A rewrite of CoreView as a drag-and-drop screen builder. Replaces V1 (whose
history is still in this repository).

- **Studio**: a canvas editor that uses the same renderer as the screens;
  drafts, preview and publish; linked views (tap to switch, idle to go back);
  live thumbnails of every screen; pairing by an on-screen code; night dimming
  and screen PINs.
- **Widgets**: photos (Immich), clock, text, weather, sky, Home Assistant
  tiles, status icons and tiles, calendar (add/erase from the screen), who's
  home, to-do lists, kids' chores, time since, buttons, who came by (Frigate),
  cards, and the Terrarium homelab view.
- **Whiteboard**: a big-print marker calendar, sticky note and drawing board
  for a grandparent's touch frame, with a Grandkids mode locked by the screen
  PIN.
- **Camera pop-up**: Frigate person detection pops a camera's live view up on
  chosen screens.
- **LED Matrix (96x32)**: driven over V1's MQTT protocol; colour themes by time
  of day, Home Assistant alerts, notifications and marquee, Lights and Music
  modes, and a sports scoreboard with team logos (away left, home right).
- **Beacon 2.0 firmware**: one C++ engine with hand-drawn pixel fonts, a
  morphing clock, scene transitions, new effects (fireworks, lava lamp, life,
  ripples, pong), 6-bit colour at ~37 fps, and a desktop preview tool.
- **Bedroom matrix (16x16 WLED)**: animated home scenes (arrivals, doors,
  cameras, dogs, washer and dryer, alerts) streamed over DDP only while
  something is happening, with quiet hours.

## 1.x — CoreView V1

The original CoreView: a control plane with themes, profiles and views, rule
automation, MQTT Matrix Beacons and a Sendspin music adapter. See the git
history before 2.2.0.
