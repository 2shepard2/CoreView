# Music Assistant and SendSpin

CoreView can act as a SendSpin **display client**. This optional integration
lets Music Assistant supply playback state, now-playing metadata, and
visualizer frames for SendSpin-aware CoreView widgets and renderers.

It is intentionally not an audio output or a Music Assistant API integration:

- CoreView does not play, relay, or store audio.
- CoreView does not require a Music Assistant URL, token, username, or
  password.
- CoreView does not use a configured Music Assistant address for the adapter;
  it waits for Music Assistant to connect inward.
- Music Assistant connects to the SendSpin endpoint exposed by CoreView.

This direction keeps CoreView portable: an installation without Music
Assistant can leave the integration unused, while an installation with Music
Assistant chooses whether and where to register the CoreView client.

## Architecture

```text
Music Assistant (SendSpin server)
  -> WebSocket client connection
  -> CoreView SendSpin adapter (:8928/sendspin by default)
  -> local adapter status API
  -> CoreView runtime
  -> browser and Matrix-capable visualizer widgets
```

The adapter is a separate container so the Python SendSpin SDK is isolated from
the CoreView Node.js application. It persists only a generated client identity
under `data/sendspin/`, allowing Music Assistant to recognize the same
CoreView display client after a container recreation.

## Setup

1. Start CoreView normally with Docker Compose. The adapter is included in the
   standard stack and exposes TCP port `8928` by default.
2. Open CoreView **System** settings and copy the displayed CoreView SendSpin
   Client Endpoint. It has the form:

   ```text
   ws://<coreview-host>:8928/sendspin
   ```

3. In Music Assistant, add that host/port as a SendSpin manual discovery
   address, then reload its SendSpin provider if needed. The CoreView adapter
   deliberately does not advertise mDNS from its Docker network, so manual
   registration is the reliable setup path.
4. Confirm CoreView reports **Connected** and lists the `metadata@v1` and
   `visualizer@v1` roles.

The endpoint uses the browser's current CoreView hostname. When accessing
CoreView through a reverse proxy or a different hostname, make sure that name
and port resolve from the Music Assistant host. The endpoint must be reachable
from Music Assistant; the adapter status API is internal to the Compose
network and is not published.

## Configuration and security

`SENDSPIN_CLIENT_PORT` controls the external host port and defaults to `8928`.
Inside the Compose network the adapter always listens on `8928`; this setting
only changes the host-to-container port mapping. Set it in `.env` before
starting Compose if the host port is occupied, then use that same port in the
manual Music Assistant endpoint.

```dotenv
SENDSPIN_CLIENT_PORT=8928
```

The adapter listens only for a SendSpin server connection. Treat it like any
other trusted LAN integration: do not expose the port publicly, and restrict
network access to the Music Assistant host or trusted network where practical.

CoreView writes only its own stable SendSpin client identity under
`data/sendspin/`; it does not persist Music Assistant credentials or a target
Music Assistant address for this adapter flow.

## Troubleshooting

- **Waiting for Music Assistant to connect:** Verify the endpoint is added in
  Music Assistant, port `8928` is reachable from its host/container, then
  reload the SendSpin provider.
- **Adapter unavailable:** Check `coreview-sendspin-adapter` is running and
  healthy with `docker compose ps` and inspect its logs with
  `docker compose logs sendspin-adapter`.
- **Connected but no frames:** Start playback in Music Assistant and verify
  its audio-analysis/visualizer capability is enabled. CoreView can remain
  connected while playback is stopped.

The integration status is diagnostic only at this stage; it does not alter
existing CoreView screens or Matrix Beacons unless a SendSpin-aware widget is
added to a View.
