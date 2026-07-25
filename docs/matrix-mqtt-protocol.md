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
  "scene": {
    "kind": "clock",
    "title": "Kitchen",
    "ticker": { "message": "Trash night" }
  }
}
```

`scene.kind` is one of `clock`, `status`, `notification`, or `unsupported`.
`unsupported` is an explicit, renderable fallback for browser-only View types
(for example maps and photo slideshows); it is never a silent failure.

Transient events use `coreview.matrix.event.v1`, carry a UUID `eventId`, a
`kind` of `notification` or `clear`, an optional RFC 3339 `expiresAt`, and a
severity (`info`, `success`, `warning`, `critical`). Events do not replace the
retained desired state.

## Target status and acknowledgement

Targets publish `coreview.matrix.status.v1` with `online`, `width`, `height`,
`colorDepth`, `rotation`, `features`, and optional firmware version. CoreView
uses it for observability; the server-side target configuration remains the
authority for compilation. After applying a state or event, targets publish
`coreview.matrix.ack.v1` with its `revision` or `eventId` and either `ok: true`
or a bounded error code.

## Capability policy

Matrix dimensions are per target, never hard-coded in CoreView. Target records
also declare color depth, rotation, and supported features. The reference
firmware may render a richer local idle animation, but CoreView scenes must use
only this protocol's portable primitives: text, short status fields, ticker,
severity, and the standard icon names.
