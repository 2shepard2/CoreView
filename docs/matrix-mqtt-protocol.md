# CoreView Matrix MQTT protocol

Status: draft v1. This is the public transport contract for constrained pixel
matrix targets such as ESPHome/HUB75 displays. It is intentionally separate
from CoreView's browser/WebSocket screen protocol.

## Topics

With `MQTT_TOPIC_ROOT=home/signage` and a target ID of `kitchen-matrix`:

| Direction | Topic | Retained |
| --- | --- | --- |
| CoreView → target | `home/signage/matrix/kitchen-matrix/state` | yes |
| CoreView → target | `home/signage/matrix/kitchen-matrix/event` | no |
| target → CoreView | `home/signage/matrix/kitchen-matrix/status` | yes |
| target → CoreView | `home/signage/matrix/kitchen-matrix/ack` | no |

The target must only subscribe to its own `state` and `event` topics. Broker
ACLs should likewise limit its publish rights to its own `status` and `ack`
topics.

## Desired state

CoreView publishes this payload whenever the assigned View or its effective
runtime override changes. `revision` strictly increases per target; a client
must ignore an older revision. A retained state lets a restarted target render
without waiting for another CoreView change.

```json
{
  "schema": "coreview.matrix.state.v1",
  "target": "kitchen-matrix",
  "revision": 42,
  "issuedAt": "2026-07-25T19:30:00.000Z",
  "display": { "width": 96, "height": 32, "colorDepth": 4, "rotation": 0 },
  "theme": {
    "background": "#000000",
    "primary": "#e6e8ed",
    "secondary": "#0080ff",
    "accent": "#ffb000",
    "critical": "#ff2000",
    "effectPalette": "neon",
    "brightness": 64
  },
  "scene": {
    "kind": "clock",
    "title": "Kitchen",
    "ticker": { "message": "Trash night" }
  }
}
```

`scene.kind` is one of `clock`, `status`, `notification`, `effect`, `music`, or `unsupported`.
`unsupported` is an explicit, renderable fallback for browser-only View types
(for example maps and photo slideshows); it is never a silent failure.

Matrix-only custom widgets may emit an `effect` scene with an effect name,
palette, speed, intensity, and optional text. Effects are generated locally by
the target; CoreView sends parameters, never a pixel stream. The reference
firmware supports `scanner`, `rainbow_waves`, `aurora`, `digital_rain`, `fire`,
`twinkle`, `color_vortex`, and `confetti`.

Notification scenes may also include an optional `icon` (`info`, `warning`,
`success`, `door`, `lock`, `motion`, `water`, or `fire`) and `flashBorder`.
These are presentation hints: clients that do not support them can render the
same title, detail, and severity without loss of meaning.

Music scenes carry a `mode` (`spectrum`, `meter`, or `pulse`) and a
`visualizer` object containing normalized 0–255 `bands`, `level`, `peak`, and
an `active` flag. They may include now-playing `title` and `detail`. This is
live display data only; CoreView never sends or relays audio.

`theme` is the effective CoreView Theme after normal assignment, schedules, and
manual overrides are resolved. All colors are six-digit CSS hex values and
`brightness` is an integer from 1 through 255. Clients that do not implement
theme support may ignore this object. Effects use `theme.effectPalette`, so a
theme change restyles both normal scenes and local animations consistently.

Transient events use `coreview.matrix.event.v1`, carry a UUID `eventId`, a
`kind` of `notification` or `clear`, an optional RFC 3339 `expiresAt`, and a
severity (`info`, `success`, `warning`, `critical`). Events do not replace the
retained desired state.

## Target status and acknowledgement

Targets publish retained `coreview.matrix.status.v1` on MQTT connection and as
a periodic heartbeat (the reference firmware reports every 30 seconds). It
contains `online`, `width`, `height`, `colorDepth`, `rotation`, `features`, and
an optional firmware version. CoreView uses it for observability; the
server-side target configuration remains the authority for compilation. After
applying a state or event, targets publish `coreview.matrix.ack.v1` with its
`revision` or `eventId` and either `ok: true` or a bounded error code. A valid
acknowledgement also refreshes the target's liveness in CoreView.

An unclaimed reference Beacon also includes a six-digit `claimCode` in its
status payload. CoreView uses this only to confirm physical possession while an
administrator claims the pending target; it is not a replacement for MQTT ACLs.

## Capability policy

Matrix dimensions are per target, never hard-coded in CoreView. Target records
also declare color depth, rotation, and supported features. The reference
firmware may render a richer local idle animation, but CoreView scenes must use
only this protocol's portable primitives: text, short status fields, ticker,
severity, and the standard icon names.

The reference renderer currently presents one custom status widget at a time.
It centers text that fits and marquees text that does not; profiles with
multiple custom widgets are intentionally treated as browser-only until Matrix
paging is introduced. The reference 32-pixel-tall hardware profile reserves a
middle ticker lane when possible, temporarily hiding the status detail so the
ticker remains legible.
