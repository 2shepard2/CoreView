# CoreView Security Model

CoreView is designed for controlled, self-hosted environments. It provides clear security boundaries between admin control, runtime displays, and external integrations.

This document describes the threat model and operator responsibilities based on the current implementation.

## Deployment Assumptions

CoreView assumes one of the following:

It is running on a trusted LAN.

It is behind a properly configured HTTPS reverse proxy.

If exposed outside a trusted LAN, HTTPS is required.

## Authentication Model

### Admin Access

Password-based login

Session tokens signed with HMAC

Timing-safe token verification

Secure cookies automatically used under HTTPS

Login throttling and temporary lockout

### Screen Clients

Each screen is enrolled with a device key.

The server stores a `device_key_hash` in SQLite.

Screen identity is validated against the stored `device_key_hash` during WebSocket connection.

WebSocket upgrades validate the request path and enforce same-host Origin validation when an Origin header is present.

### Event Webhook Ingress

The event webhook ingress surface requires:

`X-CoreView-Timestamp`

`X-CoreView-Signature`

Signatures use HMAC SHA256 over the timestamp and request body.

A five-minute replay window is enforced.

## Token Model

CoreView uses HMAC-signed tokens for:

Admin sessions

Media access

Published Views

Token verification uses timing-safe comparison.

Media tokens are short-lived and maintained in server memory.

Published View tokens include expiration.

## Data Sensitivity

The data directory contains:

SQLite database

Device key hashes

Integration credentials

Encrypted secrets

Backup archives

Active media tokens are not persisted on disk.

Filesystem-level compromise may allow impersonation of screens or access to stored integration secrets.

Protect host-level access accordingly.

## Network Security

CoreView:

Sends strict security headers

Applies a Content Security Policy

Does not enable permissive CORS by default

Validates WebSocket upgrade requests for expected path

If `TRUST_PROXY` is enabled, forwarded headers must originate from a trusted reverse proxy.

## External Integrations

CoreView integrates with:

Home Assistant

MQTT

Frigate

Immich

MQTT brokers must enforce ACLs. CoreView assumes the broker is trusted infrastructure.

## Credential Rotation

If compromise is suspected:

Rotate the admin password

Rotate the event webhook token

Rotate integration credentials

Re-enroll devices if necessary

## Not a Public SaaS

CoreView is not designed to operate as:

A multi-tenant public service

An internet-facing SaaS without infrastructure controls

Operators are responsible for proper network isolation and TLS termination.
