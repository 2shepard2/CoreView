# Changelog

## 2.13.0 (2026-11-01)

- New: **Home Assistant add-on.** On Home Assistant OS, add this repository
  in the add-on store and install CoreView: no separate Docker host needed.
  Home Assistant connects by itself, and a Mosquitto broker add-on is found
  automatically for the LED Matrix. The first sign-in code is in the add-on
  log. See [`ha-addon/DOCS.md`](ha-addon/DOCS.md). The Docker install is
  unchanged.
- **Terrarium**: a firewall cloud in the sky (2.12): temperature, root disk,
  memory, swap, load and uptime from node_exporter, with rain when it's
  offline. Configure it with the new `LAB_FIREWALL_*` settings; it stays
  hidden without them. `LAB_POOL_NOTE` labels the pool's vial.

## 2.11.1 (2026-10-26)

- Fix: **Map** widgets went to "waiting for zone" after the centre zone changed
  in Home Assistant (zone.home changes whenever someone comes home). Live
  updates now keep a zone's location, and a gas sensor's street, like the first
  load does.

## 2.11.0 (2026-10-25)

- New **Gas prices** widget: rows of Home Assistant price sensors (the
  GasBuddy integration), regular and premium columns, cheapest first, the
  best price in each column highlighted, the station's street under its name.

## 2.10.0 (2026-10) — Wake on a door, ambient idle screens

- A view can **wake on a door**: in the view settings, list entities (a door, the garage door, a motion sensor) and a view to switch to. When one opens or turns on, the screen switches there; that view's own "go back after" setting returns it, and every new opening restarts the countdown. Made for a garage TV that sits idle until someone comes through.
- New **Ambient** widget: a slow full-screen animation for idle screens (northern lights, lava lamp or drifting stars) in five colour sets, drawn small and scaled up so Fire TV sticks and old frames keep up.

## 2.9.0 (2026-10) — Radar, traffic and drive times

- New **Map** widget: a dark street map around home (or any Home Assistant zone) with the **weather radar** loop (the last 50 minutes, US NEXRAD, no key needed) or **live traffic** (TomTom). Studio fetches and caches the tiles, so a TomTom key never reaches the screens, and plain image tiles keep it running on Chrome 44.
- New **Drive times** widget: minutes from home with live traffic to each place you list (a zone, "lat,lon" or an address), grouped by who goes there, green / amber / red by how much traffic adds.
- **TomTom** on the Settings page: its Test says which of Traffic, Routing and Search the key may use.

## 2.8.0 (2026-10) — Holiday themes

- Screens can dress up for the holidays. **Halloween**: cobwebs in the corners, jack-o'-lanterns flickering in a low fog, bats crossing now and then, a ghost drifting up, a spider dropping from its web, and lightning flickers in the evening (never at night). **Thanksgiving**: autumn leaves drifting down. **Christmas**: snow and a string of twinkling lights. **New Year's**: sparkles and confetti showers, with five minutes of confetti at midnight on January 1.
- **Holiday theme** on the Screens page: by the calendar (the default), one theme always, or off. Each screen's **More…** has **Holiday decorations**: Full, Light (corners and the odd visitor, for screens people read) or Off. Screen thumbnails show the decorations.
- Decorations sit over the widgets and under pop-ups, never take a touch, and use only SVG and CSS transforms (no emoji: Android 6 has no bat), so the oldest frames keep up. The setting is in backups.

## 2.7.3 (2026-10) — Lights at a glance

- A Button set to **Turn on / off** now shows whether its light or switch is on: lit tiles glow warm, off tiles dim. The toast says what happened ("Shower on") instead of "done".

## 2.7.2 (2026-10) — Where a view is really used

- A view that a screen only reaches by a link (a tap anywhere, an idle return, a button, a photo tap) no longer says "Not on any screen". The Views page says "Opened from “Home” on Kitchen", and the editor's **Where it's used** lists the screens that use it as their main view and every view that links to it, with the link and where that view shows.
- The editor checks a linked view against every screen that can open it: widgets an older display can't run are greyed out, shape warnings name those screens, and the status says how many screens it's live on.
- A view that other views link to can't be deleted until those links are removed. Before, the tap quietly stopped working.

## 2.7.1 (2026-10) — Screens page keeps up

- Choosing a view for a screen redraws its card right away. Before, the card waited for a live update from the server, and a page whose live connection had dropped (after a Studio restart, say) kept showing the old view.
- A reload always shows the saved view, never a choice the browser remembered.

## 2.7.0 (2026-10) — Thermostats

- New **Thermostats** widget: each thermostat's temperature and humidity, Off / Cool / Heat, and − / + for the target. Quick taps on − / + become one change. A screen can only change the thermostats listed in its widget, to modes the thermostat offers, inside its own limits.

## 2.6.1 (2026-10) — Any screen with a browser

- The README now says up front what was true all along: CoreView isn't tied
  to Android. Any screen with a browser can be a display, with setup tips for
  iPads, Android, Windows tablets and a Raspberry Pi, and an honest list of
  what has been tested (now including a real iPad Pro on iPadOS 27).
- The display page opens full screen when it's saved to an iPad or iPhone
  home screen (and as an app on Android).

## 2.6.0 (2026-10) — Beacon music modes

- The Beacon (96x32 Matrix) has a new music analyser and uses the whole sign
  in Music mode: a smoother Waterfall, new Pulse Rings and Orbit, and four new
  modes, Bars, Ridgeline, Inferno and Warp, plus Mix, which rotates through
  them. Music mode follows the effect palette. Needs the Beacon 2.2 firmware.

## 2.5.8 (2026-10) — Dryer done on time

- The WLED panel now understands a dryer's anti-wrinkle mode (a short tumble
  every few minutes after the run). "Dryer done" shows 12 minutes after the
  run instead of 12 minutes after the last tumble, which could be after the
  clothes were already out, with nothing left to clear it.
- The tumbles no longer clear the message either. It clears once the drum
  has been still for 7 minutes after moving (the door was opened, so the
  tumbles stopped), when the next load starts, or after 2 hours. The washer
  works as before.

## 2.5.7 (2026-10) — WLED panel setup

- The WLED card is now called "WLED panel" on a new install (it was "Bedroom
  matrix"), and Settings has a Name field to call it what you like. An
  existing install keeps its name.
- Settings, the Screens page and the docs say plainly that only 16x16 WLED
  matrices work for now (the docs used to say any size), and where a new user
  sets one up.

## 2.5.6 (2026-10) — Moving a screen to another view

- Choosing a different view for a screen in Studio now always shows that
  view. Before, if the screen was showing a view that the new one links to
  (for example the view a tap opens), it stayed there until a reload.

## 2.5.5 (2026-10) — Settings hints

- The Immich card on the Settings page says where albums are chosen (each
  Photo slideshow, in the view editor) and how to keep other albums private.
- The Prometheus card says what the Terrarium expects and points to the
  README.
- README: a short "Photos (Immich)" section.

## 2.5.4 (2026-10) — Linked views update on publish

- Publishing a view now updates every screen that reaches it by a link (a tap,
  an idle return, a button), not only screens that show it as their main view.
  Before, a screen kept its old copy of a linked view until it reloaded, so a
  newly added "go back after N seconds" never fired.

## 2.5.3 (2026-10) — Slideshows in step

- Photo slideshows follow the server's clock: every screen showing an album,
  and Studio's live thumbnails of it, show the same photo and change at the
  same moment. Shuffle is still random, but the same on every screen, with a
  new order on each pass through the album.

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
