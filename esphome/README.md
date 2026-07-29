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
not require Home Assistant's native API or direct network access to CoreView.
It also applies the active CoreView Theme's Matrix colors, effect palette, and
brightness locally; older CoreView servers that omit `theme` continue to render
with the reference defaults.

## Quick start

Copy the complete contents of this `esphome/` directory into your ESPHome
configuration directory before compiling. The complete configuration in
`examples/coreview-beacon.yaml` is designed to become
`<esphome-config>/coreview-beacon.yaml`, alongside
the `packages/` and `hardware/` directories. Preserve that layout: its package
references are relative and will fail if only the example file is copied. The
shared base package intentionally lives under `packages/` so ESPHome Dashboard
does not present it as a flashable device.

Set `wifi_ssid`, `wifi_password`, `mqtt_broker`, `mqtt_username`, and
`mqtt_password` in ESPHome secrets, then change the target ID and hardware
profile as appropriate. Validate from the ESPHome environment before an OTA or
serial flash:

```bash
esphome config /config/esphome/coreview-beacon.yaml
```

On first MQTT connection, the Matrix displays a six-digit claim code and
reports it with its capabilities. In CoreView, select that pending Beacon,
choose a compatible View, and save the Matrix target using the displayed
code—no second flash is required.

The included hardware profile matches the draft Beacon: an ESP32-S3 and six
32×16 HUB75 panels arranged 3×2 (96×32). It is an example, not a requirement.
Create a profile for other boards, pinouts, panel chains, or geometries.

## What the reference firmware provides

- A portable retained-state MQTT client with revision acknowledgements.
- First-connection claim-code display and capability reporting.
- Theme-aware foreground, background, accent, critical color, palette, and
  brightness handling.
- Clock and one-field status scenes, including text fitting/marquee behavior.
- Matrix-only local effects: `scanner`, `bouncing_text`, `rainbow_waves`,
  `aurora`, `digital_rain`, `fire`, `twinkle`, `color_vortex`, and `confetti`.
  Scanner and Bouncing Text use the one-word display text configured on their
  Matrix Effect widget.
- Notification/alert presentation with optional standard icons and flashing
  border, plus transient ticker support.
- SendSpin Music Visualizer scenes: spectrum bars, level meter, and pulse
  modes driven by normalized live data from CoreView (never audio).
- A Home Assistant-native control card exposed by ESPHome: Matrix mode,
  lighting effect, palette, brightness, speed, intensity, restart, Wi-Fi,
  uptime, scene revision, and online status. Controls request changes from
  CoreView over MQTT; they do not bypass Themes or retained state.
- The bundled RGB Matrix HUB75 S3 hardware profile also supports the board's
  ES7210-connected microphones for the Matrix-only **Audio Reactive** widget.
  It analyzes room sound locally into eight display bands and immediately
  discards the samples—no microphone audio is published, stored, or sent to
  CoreView. Use automation to select that profile when music is playing.

CoreView sends scenes and effect parameters, not a pixel stream. That keeps
the MQTT traffic small and lets the firmware remain responsive on different
panel geometries. Browser-only content such as camera streams, maps, and photo
slideshows is deliberately rejected or rendered as an explicit unsupported
scene instead of silently failing.

## ESPHome configuration

The example expects these secrets:

```yaml
wifi_ssid: "your-wifi"
wifi_password: "your-password"
mqtt_broker: "mqtt.example.net"
mqtt_username: "coreview-beacon"
mqtt_password: "change-me"
```

`mqtt_broker` is a host name or IP address only—do not include `http://` or a
port such as `:1883`. ESPHome uses MQTT port 1883 by default; configure a
different port in the MQTT block if your broker requires it.

Keep each Beacon restricted to its own MQTT topic prefix with broker ACLs.
The protocol document lists the exact topics and directions.

## Add a new hardware profile

1. Copy a profile from `hardware/` and give it a descriptive name.
2. Set the panel chain, geometry, color depth, rotation, and GPIO wiring for
   the board.
3. Reference it from a complete configuration under `examples/` (or from your
   own ESPHome configuration).
4. Run an ESPHome configuration validation, then flash the device (serial or
   OTA) and watch the logs until it joins Wi-Fi and MQTT.
5. In CoreView, claim the pending Beacon, confirm the reported capabilities,
   and assign a compatible View.

Changing hardware geometry belongs in the hardware profile, not in
`coreview-matrix-base.yaml`. This keeps the CoreView protocol and reusable
renderer independent of a specific panel size.
