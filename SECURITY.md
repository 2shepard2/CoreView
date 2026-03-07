# CoreView Security Policy

## Supported Versions

CoreView is currently pre-release. Security fixes are applied to the latest commit on the primary branch.

## Reporting a Vulnerability

Please report vulnerabilities privately before public disclosure.

Recommended report content:
- affected endpoint or feature
- impact and attack preconditions
- minimal reproduction steps
- logs or request/response examples (with secrets removed)

Do not open public issues for unpatched critical findings.

## Security Model

CoreView has two trust planes:

1. Admin plane
- `/system`, section routes (`/views`, `/design`, `/automation`, `/targets`), and `/api/*` management endpoints
- authenticated with admin session cookie
- should run behind HTTPS

2. Screen plane
- kiosk/display clients connected over WebSocket
- runtime and media access scoped by signed media tokens
- no admin privileges

Integrations (Home Assistant, MQTT, Frigate, Immich) are treated as trusted local services and should not be exposed directly to untrusted networks without their own auth controls.

## Current Hardening Baseline

- bootstrap token required for first setup claim
- secret settings encrypted at rest in SQLite
- admin sessions use HttpOnly cookies with Secure support behind TLS/proxy
- login rate limiting and temporary lockout
- WebSocket upgrades require a valid device key hash and same-host Origin when present
- event webhooks require timestamped HMAC signatures with replay protection
- media proxy endpoints require admin auth or signed screen media token
- minimal unauthenticated health/status surface
- backup files written with restrictive permissions
- container runtime hardening: read-only rootfs, no-new-privileges, non-root app process

## Deployment Recommendations

- use reverse proxy + TLS for admin access
- set `ALLOW_INSECURE_HTTP=true` only when you intentionally accept LAN-only HTTP admin sessions and want to suppress warnings
- set `TRUST_PROXY=true` when proxy forwards `X-Forwarded-Proto`
- set `FORCE_SECURE_COOKIES=true` if proxy headers are non-standard
- keep `.env` untracked and never commit live tokens
- run `./scripts/scan-secrets.sh` before commit
- rotate integration credentials if exposure is suspected
- login and WebSocket throttles are in-memory and do not coordinate across multiple app instances

## Threat Model Notes

Primary risks:
- credential leakage from config files or logs
- unauthorized setup claim on fresh instance
- anonymous media proxy access
- brute-force login attempts
- over-privileged container runtime

Out of scope for app-layer mitigation alone:
- host compromise
- plaintext traffic interception on unmanaged networks
- insecure upstream integrations configured without auth
