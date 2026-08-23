# Changelog

## 0.1.0

First release. Distributed as a `.vsix`; see the README for installation.

### Alerts

- Server-pushed alerts with one or two action buttons, shown as notifications
  and listed in the Activity Bar with one-click inline actions.
- Alerts persist until answered or withdrawn by the server, surviving restarts.
  A restored backlog produces one summary notification rather than replaying
  each alert.
- A burst collapses into a single notification; every alert stays individually
  recoverable from the view.
- An answer given while offline is recorded locally and sent when the network
  returns, exactly once.

### Machine configuration

- The machine's current GPU, CPU, RAM and SSD shown as an editable form, with
  sliders paired with text boxes for exact values.
- Applying previews first, so the confirmation names which change forces a
  restart and states the cancellation window before you decide.
- A change in flight can be cancelled inside its window, with a countdown run
  against the server's clock.
- Failure and cancellation both revert; the machine is never left in between.
- A form built from stale data is refused rather than allowed to overwrite a
  change made elsewhere.

### Operating

- Credentials resolve from settings, secret storage, or a file, with the client
  id read from a file that the extension never generates.
- No telemetry. **Acme Alerts: Report Issue** copies redacted diagnostics to the
  clipboard.
