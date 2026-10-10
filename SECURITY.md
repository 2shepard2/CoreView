# Security

CoreView Studio is meant for a home network: a household admin, a handful of
screens, and services like Home Assistant on the same LAN. It is not designed
to be exposed to the internet.

## Reporting a problem

Use GitHub's private **Report a vulnerability** on the Security tab, not a
public issue.

## Deployment assumptions

- Studio runs on a trusted LAN, behind a reverse proxy that terminates HTTPS.
- Sign-in cookies are `Secure` by default. `COOKIE_SECURE=0` turns that off for
  plain-HTTP testing on your own network only.
- Optionally, `deploy/ingress-guard.sh` drops traffic to Studio's ports from
  anything but the reverse proxy (Docker-published ports bypass the host's
  normal firewall rules).
- The container runs as a non-root user with a read-only filesystem, no Linux
  capabilities and `no-new-privileges` (see `docker-compose.yml`).

## Studio (the admin side, port 3217)

- One household admin account, created on first visit with a one-time code
  from `secrets/setup_code` (without that file, setup is refused).
- Passwords are stored as scrypt hashes with a random salt and checked in
  constant time.
- Sessions are random 256-bit IDs in an HttpOnly cookie; only a SHA-256 of the
  ID is stored, so the data file never holds a usable session. Sessions last 30
  days.
- Requests that change anything need the `X-Studio` header and an `Origin`
  that exactly matches the site (cross-site request protection).
- Scripts may use `Authorization: Bearer <agent_token>` (from
  `secrets/agent_token`) instead of a session. Treat that file like a
  password.

## Displays (port 3216)

- A browser that opens the display page gets a random device key in an
  HttpOnly cookie; only its SHA-256 is stored. An admin attaches it to a screen
  by typing the 4-character code it shows. Unpairing deletes the device.
- A display can only fetch photos from albums in its own views, camera images
  for its own camera pop-up and "who came by" cameras, and the Home Assistant
  states and data its views use.
- Touch actions (add a calendar event, tick a to-do, run a script, turn off
  Grandkids mode) are checked on the server against the widgets on that
  screen's published views. The screen PIN is stored hashed, with a short
  lock-out after repeated wrong tries.
- Responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`; pages carry a Content-Security-Policy.

## Secrets and data

- Integration secrets (Home Assistant token, Immich key, MQTT password, agent
  token) are files in `./secrets`, mounted read-only and never sent to
  browsers. Immich photos and Frigate images are fetched by Studio and passed
  through, so screens never see those credentials.
- `data/studio.json` holds the views, screens, password hash, session hashes
  and device-key hashes. Protect the host and the `data/` folder accordingly.

## Integrations

- The Home Assistant token can do whatever its user can. Use a dedicated user
  if you want to limit what touch actions can reach.
- MQTT: give the LED sign and Studio their own broker users, and use ACLs so
  the sign can only use its own topics.
- The WLED panel receives unauthenticated UDP (DDP) frames, as WLED always
  does; anything on the LAN can draw on it.

## Rotating credentials

If you suspect a leak: change the admin password, replace the files in
`./secrets` (and the matching token/key in each service), restart the
container, and unpair and re-pair displays if needed.
