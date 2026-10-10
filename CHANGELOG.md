# Changelog

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
