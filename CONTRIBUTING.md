# Contributing to CoreView

Thanks for contributing.

CoreView is a self-hosted control plane for automation-driven smart displays. The project values clarity, security, and operational simplicity over cleverness.

## Before You Open an Issue

- Confirm the behavior on the latest `main`
- Check existing issues first
- Include concrete reproduction steps
- State your environment clearly:
  - browser/device type
  - Docker version
  - reverse proxy setup
  - enabled integrations

## Before You Open a Pull Request

- Keep changes scoped
- Prefer explicit, readable code over abstraction for its own sake
- Avoid introducing backward-compatibility layers unless they are truly necessary
- Do not commit secrets, `.env`, runtime DBs, or local media
- Update docs when behavior changes

## Development Expectations

- Preserve the View-first runtime model
- Treat security behavior as product behavior, not optional polish
- Avoid adding hidden state or dual sources of truth
- Prefer removing obsolete code over layering on top of it

## Local Checks

Run the existing checks before opening a PR:

```bash
./scripts/scan-secrets.sh
node --check server/server.js
docker compose build
```

If you change frontend inline scripts, also validate the admin and display HTML script blocks.

## Pull Request Guidelines

Please include:

- What changed
- Why it changed
- Any security implications
- Any migration or upgrade implications
- Screenshots for UI changes when relevant

Small, focused PRs are preferred over broad refactors unless the refactor is the point of the change.

## Feature Requests

Feature requests are welcome, but they should be grounded in:

- a clear operator problem
- a coherent place in the existing architecture
- realistic implementation and maintenance cost

## Security Reports

Do not file sensitive security issues as public bug reports if they could expose users or deployments. Use a private maintainer contact path if one is available.
