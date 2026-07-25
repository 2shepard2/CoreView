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
not require Home Assistant's native API.

## Quick start

Use the example in place, or copy the complete `esphome/` directory into your
ESPHome configuration directory so its relative package paths remain valid.
Set `wifi_ssid`, `wifi_password`, `mqtt_broker`, `mqtt_username`, and
`mqtt_password` in ESPHome secrets, then change the target ID and hardware
profile as appropriate. Create a Matrix target in CoreView with the same ID.

The included hardware profile matches the draft Beacon: an ESP32-S3 and six
32×16 HUB75 panels arranged 3×2 (96×32). It is an example, not a requirement.
Create a profile for other boards, pinouts, panel chains, or geometries.
