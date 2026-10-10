# Home Assistant setup

CoreView Studio reads Home Assistant over its WebSocket API and calls a few
services when someone taps a screen (add a calendar event, tick off a to-do,
run a script). Everything else is optional.

## 1. A long-lived access token

In Home Assistant: your profile → **Security** → **Long-lived access tokens**
→ **Create token**. Put it in `secrets/ha_token` (just the token, nothing
else) and set `HA_URL` in `.env`, for example `http://homeassistant.local:8123`.

Studio uses the token for every screen, so a user with normal (non-admin)
rights is enough if you only use read-only widgets. Touch actions (calendar,
to-do lists, buttons) need a user that may call those services.

## 2. Message helpers for the LED Matrix (optional)

The Matrix shows an alert, a notification or a scrolling marquee when one of
three text helpers changes. Create them in **Settings → Devices & services →
Helpers → Text**, or in YAML:

```yaml
input_text:
  coreview_alert_text:
    name: CoreView alert
    max: 255
  coreview_notification_text:
    name: CoreView notification
    max: 255
  coreview_marquee_text:
    name: CoreView marquee
    max: 255
```

Then send a message from any automation or script:

```yaml
action: input_text.set_value
target:
  entity_id: input_text.coreview_alert_text
data:
  value: "Water leak in the laundry room"
```

| Helper | On the 96x32 Matrix | On the 16x16 bedroom matrix |
| --- | --- | --- |
| `coreview_alert_text` | red, flashing, 90 s | flashing warning sign, 90 s |
| `coreview_notification_text` | notification, 60 s | bell, 60 s |
| `coreview_marquee_text` | ticker under the clock, 110 s | (not shown) |

Only a **change** fires a message, and the text is captured at that moment, so
an automation may clear the helper right after setting it. Setting the same
text twice in a row does nothing (set it to "" first). Durations and cooldowns
are in the Matrix card's **Settings** on Studio's Screens page.

## 3. Sports scores (optional)

The Matrix scoreboard reads [Team Tracker](https://github.com/vasqued2/ha-teamtracker)
sensors (install it from HACS, add one sensor per team). Add the sensors to the
watch list in the Matrix card's **Settings**; when a watched team's game is live the
clock becomes a scoreboard with both teams' logos, then shows the final score
for 5 minutes.

## 4. The 16x16 bedroom matrix (WLED, optional)

Any WLED 2D matrix works. In WLED:

1. **Config → LED Preferences / 2D Configuration**: set it up as a 2D matrix
   (16x16 or your size) so WLED's own effects look right.
2. **Config → Sync Interfaces → Realtime**: tick **Receive UDP realtime**.
   Studio sends DDP on UDP port 4048 (on whenever realtime is on). The
   **timeout** (default 2.5 s) is how long after a scene ends WLED goes back
   to its own effect.

Then in Studio, on the **Bedroom matrix** card: Settings → WLED address, add
the people, doors, cameras and laundry sensors you want, tick **Studio drives
the matrix**, and use **Try a scene** to check the picture is the right way up
(Settings has rotate and mirror).

What it reacts to:

| Scene | Home Assistant entity | Shows while |
| --- | --- | --- |
| Someone came home | `person.*` | the state changes to `home` (30 s) |
| Door open | a door `binary_sensor` | it is `on`, up to the limit (15 min) |
| Garage door up | a garage `binary_sensor` | same |
| Person on a camera | Frigate's `binary_sensor.<camera>_person_occupancy` | it is `on` (at least 20 s) |
| Dogs need out | an `input_datetime` (last time out) + an `input_number` (minutes) | the last outing is older than the minutes, in daytime |
| Washer / dryer done | a vibration sensor's `moving` / `vibration` `binary_sensor` | 15+ min of shaking, then 12 still minutes; until the next bump or 2 h |
| Notification / alert | the helpers above | as above |

Quiet hours (default 21:00-06:00) keep only alerts and cameras, dimmed.

## 5. Frigate (optional)

Set `FRIGATE_URL` (Frigate's HTTP API, no login needed on a LAN). Screens can
then pop up a camera's live view when Frigate sees a person (per screen:
**Camera pop-up** on the Screens page), and the **Who came by** widget shows
recent events. The Frigate camera names are read from its API.
