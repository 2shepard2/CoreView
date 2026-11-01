# CoreView for Home Assistant

Build wall displays in Studio, then open a display page on each screen. This
add-on supports Home Assistant OS and installations with Supervisor, on amd64
and aarch64. Home Assistant Container/Core users should use the repository's
Docker Compose instructions instead.

## Install and first sign-in

1. In **Settings → Add-ons → Add-on store → ⋮ → Repositories**, add
   `https://github.com/2shepard2/CoreView`.
2. Refresh the store, select **CoreView**, and install. The image builds on
   your machine from the matching CoreView release tag; internet access is
   needed. No separate Docker host is required.
3. Leave **Connect Home Assistant** enabled. If the Mosquitto broker add-on
   is installed and running, its connection is detected automatically.
4. Start CoreView and open its **Log** tab. Copy the first sign-in setup code.
5. Click **Open Web UI**, or open `http://<ha-host>:3217`. Enter the setup
   code and choose the household admin username and password. Treat the code
   as a secret; it is printed only while Studio has no admin account.
6. On each display, open `http://<ha-host>:3216`, then pair its code in Studio.

There is no ingress/sidebar panel in v1. Studio and displays use their own
ports. Change the host ports in the add-on's **Network** section if needed;
use those mapped ports in the URLs above. Keep these ports on your trusted
LAN or behind an authenticated HTTPS reverse proxy.

## Options

Restart the add-on after changing options. Blank integration fields leave
that feature off or available to configure in Studio's **Settings**. When an
integration is set in add-on options (or automatically), its whole connection
is read-only in Studio; change it here instead. Turning automatic HA off
makes HA configurable in Studio, including its own long-lived access token.

| Option | Default | Purpose |
| --- | --- | --- |
| `connect_home_assistant` | `true` | Use Supervisor's HA connection and token; no manual HA token needed. |
| `cookie_secure` | `false` | Set `true` when Studio is accessed through HTTPS. |
| `settings_lock` | `false` | Make all integration settings read-only in Studio. |
| `immich_url` | blank | Immich server, e.g. `http://immich.local:2283`. |
| `immich_api_key` | blank | Immich API key; use an account limited to albums you want displayed. |
| `frigate_url` | blank | Frigate API, commonly `http://ccab4aaf-frigate:5000` for the Frigate add-on. |
| `jellyfin_url` | blank | Jellyfin server, e.g. `http://jellyfin.local:8096`. |
| `jellyfin_api_key` | blank | Jellyfin API key. |
| `tomtom_api_key` | blank | TomTom Traffic, Routing and Search API key for maps and drive times. |
| `prometheus_url` | blank | Prometheus server for the optional Terrarium widget. |
| `mqtt_url` | blank | Manual plain MQTT URL, e.g. `mqtt://core-mosquitto:1883`; blank enables service discovery. |
| `mqtt_username` | blank | Manual broker user; used only with a manual `mqtt_url`. |
| `mqtt_password` | blank | Manual broker password; used only with a manual `mqtt_url`. |
| `mqtt_topic_root` | `home/signage` | LED Matrix topic prefix. |

Manual MQTT settings replace all discovered MQTT settings. A missing broker
leaves CoreView running, and you can configure one in Studio or in these
options. Discovery runs on startup; restart after installing a broker.
CoreView supports plain MQTT only. A discovered `ssl: true` broker or
manual `mqtts://` URL is declined with a log message, so credentials are never
sent to a TLS endpoint through the plain TCP client. Use a trusted local
plain MQTT listener for this version.

For Frigate, verify the add-on hostname in your own installation: other
Frigate variants can have different names. For Immich running on another
host, use that host's LAN URL, not `localhost` (which means CoreView's own
container). The same applies to Jellyfin and Prometheus.

`cookie_secure: false` allows sign-in over plain HTTP on your LAN. Enable it
when your reverse proxy supplies HTTPS; then browsers will only send Studio's
session cookie over HTTPS. Enabling it while visiting Studio over HTTP will
prevent sign-in from sticking. The add-on does not terminate HTTPS itself.

## Data and security

Supervisor persists and backs up `/data`: Studio state, saved connections,
and generated `secrets/agent_token` and `secrets/setup_code`. Both generated
secrets survive restarts and restores. Do not share backups or add-on logs
from an unclaimed installation. Option keys and the Supervisor HA token are
written to private files under `/tmp/secrets` (0600); these are recreated at
startup. Home Assistant also stores option values in `/data/options.json`.
The Supervisor token is removed from the server child's environment.

Startup briefly runs as root to prepare Supervisor's mounted `/data` and
hand its contents to UID/GID 10250. It then drops supplementary groups and
runs the launcher and server as the `studio` user. Existing data symlinks
are rejected. No host networking, devices, Docker API, extra privileges or
AppArmor exceptions are requested. The time zone comes from Supervisor.

## Troubleshooting

- **No HA data:** enable automatic HA, restart, and select HA entities in a
  view. The socket opens when a view needs entities. If using Studio's manual
  HA settings, check its URL and long-lived token instead.
- **MQTT unavailable:** start your broker, then restart CoreView, or supply a
  plain `mqtt://` URL and its credentials. A TLS broker is unsupported in v1.
- **Startup failed:** check options and `/data` permissions. Startup errors
  deliberately omit option values and API responses. Empty/corrupt persistent
  secret files and corrupt Studio state cause startup to stop; restore a
  known-good backup rather than silently replacing them.
- **Display cannot reach CoreView:** use the HA host's LAN address and the
  mapped display port, not Supervisor's internal hostnames.

Design notes and the Supervisor WebSocket decision are in
`docs/home-assistant-addon.md` in the repository.
