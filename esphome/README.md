# CoreView Matrix for ESPHome

This directory is the reference client for CoreView's Matrix MQTT transport.
It is intended for RGB HUB75 panels, but CoreView itself does not assume a
specific panel dimension.

## Layout

- `coreview-matrix-base.yaml` — portable MQTT state consumer and renderer.
- `hardware/` — board and panel wiring profiles.
- `examples/` — complete starting configurations.

The base package reads the retained state topic documented in
[`docs/matrix-mqtt-protocol.md`](../docs/matrix-mqtt-protocol.md), publishes
availability/status, and acknowledges applied revisions. It deliberately does
not require Home Assistant's native API. It also applies the active CoreView
Theme's Matrix colors, effect palette, and brightness locally; older CoreView
servers that omit `theme` continue to render with the reference defaults.

## Quick start

Use the example in place, or copy the complete `esphome/` directory into your
ESPHome configuration directory so its relative package paths remain valid.
Set `wifi_ssid`, `wifi_password`, `mqtt_broker`, `mqtt_username`, and
`mqtt_password` in ESPHome secrets, then change the target ID and hardware
profile as appropriate. On first MQTT connection, the Matrix displays a
six-digit claim code and reports it with its capabilities. In CoreView, select
that pending Beacon, choose a compatible View, and save the Matrix target using
the displayed code—no second flash is required.

The included hardware profile matches the draft Beacon: an ESP32-S3 and six
32×16 HUB75 panels arranged 3×2 (96×32). It is an example, not a requirement.
Create a profile for other boards, pinouts, panel chains, or geometries.
