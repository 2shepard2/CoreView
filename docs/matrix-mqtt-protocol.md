# CoreView Matrix MQTT protocol

The contract between CoreView Studio and an LED matrix sign (the reference
target is the ESPHome "CoreView Beacon" firmware in `firmware/beacon/`, a
96x32 HUB75 panel). Studio sends a compact scene description; the sign draws
it locally. Studio never streams pixels to this kind of target.

It is the same protocol CoreView V1 used, so a V1 Beacon works with Studio
unchanged.

## Topics

With `MQTT_TOPIC_ROOT=home/signage` (the default) and a target ID of
`coreview-beacon`:

| Direction | Topic | Retained |
| --- | --- | --- |
| Studio → sign | `home/signage/matrix/coreview-beacon/state` | yes |
| sign → Studio | `home/signage/matrix/coreview-beacon/status` | yes |
| sign → Studio | `home/signage/matrix/coreview-beacon/ack` | no |
| sign → Studio | `home/signage/matrix/coreview-beacon/control` | no |

The target ID is set in the firmware (`coreview_target_id`) and must match the
Matrix target in Studio. If your broker has ACLs, let the sign subscribe only
to its own `state` topic and publish only to its own `status`, `ack` and
`control` topics.

## Desired state (`state`)

Studio publishes a retained state whenever what the sign should show changes.
`revision` strictly increases per target, and a sign ignores anything older
than what it already applied. Because the message is retained, a sign that
restarts picks up the current scene straight away.

```json
{
  "schema": "coreview.matrix.state.v1",
  "target": "coreview-beacon",
  "revision": 42,
  "issuedAt": "2026-10-10T19:30:00.000Z",
  "display": { "width": 96, "height": 32, "colorDepth": 6, "rotation": 0,
               "features": ["clock", "status", "notification", "ticker", "icons"],
               "controls": { "mode": "display", "effect": "fire", "palette": "neon" } },
  "theme": {
    "background": "#000000", "primary": "#e6e8ed", "secondary": "#0080ff",
    "accent": "#ffb000", "critical": "#ff2000", "effectPalette": "neon", "brightness": 64
  },
  "scene": { "kind": "clock", "title": "Out:72", "ticker": { "message": "Trash night" } }
}
```

`theme` is the colour theme for the current time of day (Studio's Matrix
settings). Colours are six-digit hex; `brightness` is 1-255.

### Scene kinds

| `scene.kind` | Fields | When Studio sends it |
| --- | --- | --- |
| `clock` | `title` (line under the clock), optional `ticker.message` | the default |
| `notification` | `title`, `detail`, `severity` (`info`, `success`, `warning`, `critical`), optional `icon` (`info`, `warning`, `success`, `door`, `lock`, `motion`, `water`, `fire`), `flashBorder` | an alert or notification from Home Assistant |
| `scoreboard` | see below | a watched team is playing |
| `effect` | `effect`, `palette`, `speed`, `intensity`, optional `text` | "Lights" mode |
| `music` | `mode` (`local_pulse_rings`, `local_orbit`, `local_waterfall`) | "Music" mode (the sign's own microphones; no audio goes over the network) |

Effects: `scanner`, `bouncing_text`, `rainbow_waves`, `aurora`,
`digital_rain`, `fire`, `twinkle`, `color_vortex`, `confetti`, `starfield`,
`plasma`, `fireworks`, `lava`, `life`, `ripples`, `pong`. Palettes: `neon`,
`ocean`, `sunset`, `forest`, `party`. `scanner` and `bouncing_text` show
`text` (one word, up to 16 characters).

### Scoreboard

```json
{
  "kind": "scoreboard",
  "homeLabel": "KC", "homeScore": "21",
  "guestLabel": "DEN", "guestScore": "24",
  "period": "Q4", "remainingTime": "2:05",
  "leftOn": true, "rightOn": false,
  "leftColor": "#e31837", "rightColor": "#fc4c02",
  "leftLogo": "<base64>", "rightLogo": "<base64>",
  "ticker": "3RD & 4 AT DEN 38", "tickerSpeed": 9
}
```

The field names are V1's and the sign draws them **by position**: `home*` is
the LEFT slot and `guest*` the RIGHT slot. Studio puts the away team on the
left and the home team on the right. `leftOn` / `rightOn` light the possession
dot under that side's score, in `leftColor` / `rightColor`.

`leftLogo` / `rightLogo` are optional team logos: base64 of raw RGB, 3 bytes
per LED, row by row, black = off. They are 18x18 (972 bytes), or 15x15 when
either score has three digits. Empty means "draw the initials instead".
Logos make the payload a few KB; ESPHome reassembles MQTT messages larger than
its buffer, so this is fine on the reference firmware.

Scores come from the [Team Tracker](https://github.com/vasqued2/ha-teamtracker)
integration's sensors (`sensor.<league>_<team>`), which also provide the logo
URLs; Studio downloads and shrinks the logos itself.

## Sign status (`status`)

The sign publishes a retained `coreview.matrix.status.v1` when it connects and
every 30 seconds: `online`, `width`, `height`, `features`, and optionally
`firmware` and `claimCode`. Studio shows it on the Matrix card ("Online", last
seen). The MQTT last-will sets `online: false`.

## Acknowledgement (`ack`)

After applying a state, the sign publishes `coreview.matrix.ack.v1` with the
`revision` and `ok: true` (or `ok: false` and a short `error`). Studio shows
the last confirmed revision on the Matrix card.

## Control requests (`control`)

The firmware also exposes ESPHome entities in Home Assistant (mode, effect,
palette, brightness, speed, intensity, the two effect words). Changing one does
not change the sign directly: the sign publishes a non-retained request

```json
{ "schema": "coreview.matrix.control.v1", "control": "effect", "value": "Digital Rain" }
```

and Studio validates it, saves it, and publishes a new `state` revision. That
keeps Studio, themes, alerts and Home Assistant from fighting over the sign.
Controls: `mode` (`Display`, `Lights`, `Music`), `effect`, `palette`,
`brightness`, `speed`, `intensity`, `audio_mode`, `scanner_text`,
`bouncing_text`. Alerts and notifications still take priority over Lights and
Music.
