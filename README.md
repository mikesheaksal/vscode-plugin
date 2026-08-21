# VS Code plugin

A VS Code extension with two jobs:

- **Alerts** — the backend pushes an alert, the user answers it with one or two buttons,
  the answer goes back to the server. Alerts persist until answered or revoked.
- **Machine configuration** — an Activity Bar view shows the machine's current GPU, CPU,
  RAM and SSD as an editable form. Applying a change reconfigures the machine directly.

The backend is Go (gRPC + grpc-gateway); the extension talks JSON to the gateway.

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture, transport, identity, reliability,
  phased build plan, risks.
- [`proto/acme/alerts/v1/alerts.proto`](proto/acme/alerts/v1/alerts.proto) — the contract.
  `buf generate` produces Go stubs, the gateway, OpenAPI, and the extension's TypeScript
  types from it.
