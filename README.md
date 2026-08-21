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

## Development

```bash
npm install
npm run check          # typecheck + lint + unit tests + build
npm run watch          # rebuild on change, then F5 in VS Code
```

`F5` (**Run Extension**) opens a second VS Code with the extension loaded: the
bell icon appears in the Activity Bar and opens a sidebar holding the **Machine**
and **Alerts** views.

Unit tests (`npm test`, vitest) run in plain Node and cover code that does not
import `vscode` — plus `src/manifest.test.ts`, which checks the half of the
extension the compiler never sees: menu commands that exist, welcome-view links
that resolve, the declared icon being present.

Integration tests (`npm run test:integration`) run inside a real VS Code via
`@vscode/test-cli` and assert that the extension activates, registers its
commands, and resolves both views. They download VS Code on first run, so they
need network access to `update.code.visualstudio.com`.
