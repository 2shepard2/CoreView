# Beacon 2.0 firmware (the 96x32 LED Matrix)

ESPHome firmware for a CoreView "Beacon": an ESP32-S3 driving six 32x16 HUB75
LED panels as one 96x32 sign. CoreView Studio tells it what to show over MQTT
(protocol: [`docs/matrix-mqtt-protocol.md`](../../docs/matrix-mqtt-protocol.md));
the Beacon draws everything itself: a morphing clock, alerts with icons, a
ticker, sports scoreboards with team logos, and animated effects (fire,
fireworks, lava lamp, the game of life, pong, ...), plus seven local
music visualizers driven by its own microphones (bars, waterfall, pulse
rings, orbit, ridgeline, inferno, warp, or a mix of them).

## Hardware

The reference build:

- An **ESP32-S3 HUB75 driver board** with 16 MB flash and octal PSRAM (the
  profile was made for the "RGB Matrix HUB75 S3" board, which also has two
  microphones on an ES7210 audio chip; without them only Music mode is lost).
- **Six 32x16 HUB75 panels** (1/8 scan with an E line is fine), chained as
  3 columns x 2 rows, starting top right (`layout: TOP_RIGHT_DOWN`).
- A 5 V supply sized for the panels (about 2-4 A for six small panels at the
  default brightness).

Pin map (HUB75 → ESP32-S3 GPIO), from `hardware/beacon2-hub75-96x32.yaml`:

| R1 | G1 | B1 | R2 | G2 | B2 | A | B | C | D | E | CLK | LAT | OE |
| -- | -- | -- | -- | -- | -- | - | - | - | - | - | --- | --- | -- |
| 6 | 4 | 5 | 17 | 7 | 15 | 8 | 18 | 10 | 9 | 16 | 12 | 11 | 13 |

Microphones (ES7210 over I2C): SDA 1, SCL 2. A different board or panel
arrangement only needs a copy of the hardware file with your pins and
`panel_width` / `panel_height` / `layout_cols` / `layout_rows`.

## Files

| Path | What |
| --- | --- |
| `coreview-beacon.yaml` | the device: its name, `coreview_target_id`, and which packages to use |
| `packages/beacon2-base.yaml` | Wi-Fi, MQTT, the CoreView protocol, the Home Assistant control card |
| `hardware/beacon2-hub75-96x32.yaml` | board, panels, microphones, and the draw loop |
| `components/` | the C++ engine (`beacon_engine.h`), pixel fonts, scoreboard, audio analyser (`coreview_audio_dsp.h`; `coreview_audio_reactive.h` feeds it the microphone) |
| `tools/` | font generator, desktop preview, scoreboard parity check |

## Build and flash

You need [ESPHome](https://esphome.io) (tested with 2026.8.2; it uses the built-in
`hub75` and `es7210` components): the ESPHome add-on in
Home Assistant, or `pip install esphome` on any computer.

1. Copy this folder (`coreview-beacon.yaml`, `packages/`, `hardware/`,
   `components/`) into your ESPHome config folder (`/config/esphome` for the
   add-on).
2. Create or extend `secrets.yaml` there:

   ```yaml
   wifi_ssid: "YourWiFi"
   wifi_password: "your-wifi-password"
   mqtt_broker: "192.168.1.10"      # your MQTT broker (e.g. Home Assistant's Mosquitto)
   mqtt_username: "coreview-beacon"
   mqtt_password: "the-mqtt-password"
   ```

3. In `coreview-beacon.yaml`, keep or change `coreview_target_id`. It must
   match the Matrix target in Studio (Studio's default is `coreview-beacon`).
   The clock uses the time zone of the machine ESPHome builds on. If that's
   not the sign's, add a line `timezone: America/New_York` (yours) under
   `- platform: sntp` in the `time:` block of `packages/beacon2-base.yaml`.
4. **First flash** (USB): connect the board, then
   `esphome run coreview-beacon.yaml` and pick the serial port (or use
   "Install → Plug into this computer" in the ESPHome dashboard). Hold the
   board's BOOT button while plugging in if it isn't detected.
5. **Later updates** go over Wi-Fi:
   `esphome run coreview-beacon.yaml --device <the Beacon's IP>`.

After boot the sign shows a short splash, then a claim screen until Studio
publishes its first state. In Studio, set `MQTT_URL`, open the Matrix card's
Settings and tick **Studio drives the Matrix**. The card turns "Online" when
the Beacon's heartbeat arrives, and shows each revision the sign confirms.

The firmware also adds the Beacon to Home Assistant through the ESPHome
integration (a control card: mode, effect, palette, brightness, speed). Those
controls go through Studio (see the protocol doc), so Studio, themes and alerts
never fight over the sign.

If an update ever fails to boot, ESPHome's safe mode kicks in after a few
crashes and still accepts an over-the-air flash of the previous version.

## Preview on a desktop

The engine is plain C++17, so the same drawing code runs on a PC:

```bash
g++ -std=c++17 -O2 -fno-rtti -Icomponents tools/preview.cpp -o /tmp/beacon-preview
/tmp/beacon-preview effect:fireworks /tmp/fw.raw     # or boot clock alert ticker theme music scoreboard
python3 tools/preview.py /tmp/fw.raw /tmp/fw.gif 5   # needs Pillow
```

Scenarios: `boot`, `clock`, `alert`, `ticker`, `theme`, `music`,
`scoreboard`, `countdown`, `effect:<name>[:<palette>]`, and
`local:<audio mode>:<file.raw>[:<palette>[:<seconds>]]`, which runs a real
recording through the firmware's analyser:

```bash
ffmpeg -ss 45 -t 20 -i song.flac -ac 1 -ar 16000 -f s16le /tmp/song.raw
/tmp/beacon-preview local:ridgeline:/tmp/song.raw:sunset /tmp/rl.raw
```
 After editing glyphs in
`tools/fonts.py`, regenerate them with
`python3 tools/fonts.py > components/beacon_fonts.h`.

## Scoreboard

`components/coreview_scoreboard.h` draws exactly the same pixels as
`render()` in Studio's `public/scoreboard.js`, so Studio's preview is exact:
team logos at the edges (away left, home right), 6x11 score digits, the period
on top and the clock between the scores; 15 px logos and narrower digits when a
score has three digits; initials over the score when there's no logo. Studio
downloads and shrinks the logos and sends them in the state message. After
changing either renderer, check they still match:

```bash
node tools/scoreboard_parity.js [folder of logo PNGs]   # needs g++; must print N/N identical
```

## Notes

- 6-bit colour: 8 bits drops the refresh rate on a 192-pixel-wide chain to
  about 50 Hz, which flickers on camera and to some eyes.
- The draw loop runs at about 37 frames per second.
- Music: the analyser does a 512-point FFT 62 times a second into 32
  mel-spaced bands, each against its own noise floor under one shared
  auto-gain, and counts bass onsets as beats. The microphone samples are
  never stored or sent. Every 2 s it logs a line like
  `level=180 loud=140 beats=812 |%%#*+=-:...|` (ESPHome logs, debug level).
- The Beacon doesn't remember the last applied revision across reboots, so it
  always applies the retained state after a restart.
- This replaces V1's reference firmware and speaks the same protocol: a V1
  CoreView server can drive it too (without logos and the newer effects).
