# Changelog

## 2.13.0

- Initial Home Assistant add-on for amd64 and aarch64, built on-device.
- Automatic Supervisor HA connection and optional MQTT service discovery.
- Manual integration options, protected first sign-in, persistent private
  setup/agent secrets, and a server running as UID 10250.
- Studio and displays exposed on ports 3217 and 3216; no ingress.
- TLS MQTT is declined because CoreView supports plain MQTT only.
