# Alerts & Forms — VS Code Extension: High-Level Design

Status: draft for review
Target: VS Code extension (TypeScript), not Visual Studio VSIX

## 1. What we are building

A VS Code extension that connects to a backend and does two things:

1. **Alerts.** The server pushes an alert; the extension shows it to the user with one or
   two action buttons; the user's choice (or dismissal) is posted back to the server.
2. **Form.** A persistent button in the VS Code chrome opens a panel with a small fixed
   set of fields plus Submit/Cancel; the submitted payload is posted to the server.

Everything else in this document exists to make those two flows reliable when the
network drops, the token expires, or the user has six windows open.

## 2. Decisions taken

| Question | Decision | Consequence |
|---|---|---|
| IDE | VS Code extension, TypeScript / Node | `.vsix` package; no VSIX/C# work |
| Server → client transport | **SSE**, long-poll fallback | Push latency without a WebSocket; survives most corporate proxies |
| Form fields | **Hardcoded** in the extension | Simple and type-safe; field changes require a new release |
| Auth | **API token from settings**, fallback to a known local file | No IdP work; token handling needs care (§6) |

Open items are listed in §12.

## 3. The "toolbar button" — what that actually means in VS Code

VS Code has no classic toolbar to add a button to. The realistic homes for a global,
always-available action are:

| Surface | Always visible | Notes |
|---|---|---|
| **Status bar item** (bottom bar) | Yes | Closest thing to a toolbar button; can carry a pending-alert count |
| Editor title bar icon (`menus: editor/title`) | Only with a file open | Good secondary placement |
| Activity bar view container | Yes, but costs a whole sidebar slot | Overkill for one form |
| Command Palette entry | On demand | Free, always add it |

**Proposal:** a status bar item (`$(bell) Alerts`) as the primary entry point, plus a
Command Palette command (`Acme Alerts: Open Form`) and an optional editor-title icon.
The status bar item doubles as the unread indicator: `$(bell) Alerts` normally,
`$(bell-dot) Alerts 3` with a warning background when alerts are pending.

Flagging this early because "button on toolbar" maps to a status bar item, which sits at
the *bottom* of the window, not the top. If a top-of-window placement is a hard
requirement, the editor title bar is the only option and it disappears when no editor is
open.

## 4. Architecture

```
┌──────────────────────── VS Code extension host (Node) ────────────────────────┐
│                                                                               │
│  extension.ts  ── activation, command + status bar registration, disposal     │
│        │                                                                      │
│        ├── ConfigService      settings, token resolution, change watching     │
│        ├── ApiClient          fetch wrapper: auth header, retry, error map    │
│        ├── EventStream        SSE connect / parse / heartbeat / backoff       │
│        │        │                                                             │
│        │        └──> AlertService   dedupe → showInformationMessage → respond │
│        │                                                                      │
│        ├── FormPanel          singleton webview, draft persistence            │
│        │        └── webview/  index.html + form.js + form.css (CSP, nonce)    │
│        │                                                                      │
│        ├── Outbox             durable queue of unsent responses/submissions   │
│        └── Logger             OutputChannel "Acme Alerts"                     │
└───────────────────────────────────────────────────────────────────────────────┘
                    │  HTTPS                            ▲  SSE (text/event-stream)
                    ▼                                   │
┌───────────────────────────────── Server ──────────────────────────────────────┐
│  GET  /api/v1/events                      SSE stream of alerts                 │
│  GET  /api/v1/alerts/pending              catch-up / long-poll fallback        │
│  POST /api/v1/alerts/{id}/response        user's button choice or dismissal    │
│  POST /api/v1/forms/{formType}/submissions  form payload                       │
│  GET  /api/v1/me                          token validation, user identity      │
└───────────────────────────────────────────────────────────────────────────────┘
```

Module boundaries matter for one practical reason: `ApiClient`, `EventStream`, `Outbox`
and validation must be unit-testable without a running VS Code, so nothing in them may
import `vscode`. Only `extension.ts`, `AlertService`, `FormPanel` and `ConfigService`
touch the VS Code API.

## 5. Wire protocol

### 5.1 Alert (server → client, SSE event `alert`)

```json
{
  "id": "alt_01J8XZ...",
  "severity": "info",
  "title": "Deployment approval needed",
  "message": "build #4821 is waiting for your approval.",
  "modal": false,
  "buttons": [
    { "id": "approve", "label": "Approve", "isPrimary": true },
    { "id": "reject",  "label": "Reject" }
  ],
  "expiresAt": "2026-08-20T12:00:00Z"
}
```

Rules:
- `id` is server-assigned, globally unique, and is the dedupe key.
- `buttons` has 0–2 entries. The client truncates anything longer rather than failing.
- `severity` selects `showInformationMessage` / `showWarningMessage` / `showErrorMessage`.
- `modal: true` blocks the UI until answered. Use sparingly — it steals focus mid-typing.
- `expiresAt` past → client drops the alert silently and reports `expired`.

### 5.2 Alert response (client → server)

`POST /api/v1/alerts/{id}/response`

```json
{
  "outcome": "answered",          // answered | dismissed | expired
  "buttonId": "approve",          // null unless outcome == answered
  "respondedAt": "2026-08-20T11:58:03Z",
  "deviceId": "dev_9f2c..."
}
```

Idempotent on `(alertId, deviceId)`. A repeat POST returns `200`; a *different* answer to
an already-answered alert returns `409`, which the client logs and ignores (§9.3).

### 5.3 Form submission (client → server)

`POST /api/v1/forms/feedback/submissions` with header `Idempotency-Key: <uuid v4>`

```json
{
  "title": "Search is slow on large repos",
  "category": "bug",
  "priority": "high",
  "description": "...",
  "clientContext": {
    "extensionVersion": "0.1.0",
    "vscodeVersion": "1.9x.x",
    "platform": "linux"
  }
}
```

Response `201 { "id": "sub_...", "url": "https://..." }` — the client shows a
notification with an "Open" button linking to `url`.

The field set above is a **placeholder**. Since fields are hardcoded, the real list needs
to be pinned down before Phase 6; see §12.

### 5.4 Errors

Single shape for every non-2xx, so the client has one error path:

```json
{ "error": { "code": "unauthorized", "message": "token expired", "retryable": false } }
```

Client behaviour by status: `401/403` → re-resolve token, then prompt (§6.3);
`429` → honour `Retry-After`; `5xx`/network → outbox + backoff; `4xx` other → surface to
user, do not retry.

## 6. Authentication

### 6.1 Resolution order

1. Setting `acmeAlerts.apiToken` — if non-empty.
2. `SecretStorage` — where a token entered via the `Acme Alerts: Sign In` command lives,
   and where a token found in (1) is migrated to.
3. Token file — path from `acmeAlerts.tokenFilePath`, defaulting to
   `$XDG_CONFIG_HOME/acme-alerts/token` (`~/.config/...`), `%APPDATA%\acme-alerts\token`
   on Windows. Trimmed of whitespace; first line only.

The resolved token is cached in memory and invalidated on: settings change, secret
change, token-file change (fs watcher), and any `401`.

### 6.2 The problem with tokens in settings

`settings.json` is plaintext, is synchronised by Settings Sync, and gets committed by
accident when placed in `.vscode/settings.json`. So:

- The setting is declared `"scope": "application"` so it cannot be set per-workspace,
  which removes the "committed to the repo" failure mode.
- On first read from the setting, the extension copies the value into `SecretStorage` and
  offers a one-click "Clear from settings.json" action.
- On POSIX, if the token *file* is group- or world-readable, log a warning and show it
  once per session.
- The token is never written to the output channel; the logger redacts anything matching
  the token value and common `Bearer` patterns.

### 6.3 Failure handling

On `401`: drop the cached token, re-resolve from scratch (the file may have been
refreshed by an external tool), retry the request exactly once. If it fails again, stop
the reconnect loop, set the status bar to `$(bell-slash) Alerts — sign in`, and show one
notification with a "Sign In" button. Do not loop on a bad token.

## 7. Alert delivery

### 7.1 Connection lifecycle

- `activationEvents: ["onStartupFinished"]` — do not block startup.
- On activate: resolve token → `GET /api/v1/me` to validate → `GET /api/v1/alerts/pending`
  to catch up on anything missed while offline → open the SSE stream.
- SSE request carries `Authorization: Bearer`, `Accept: text/event-stream`, and
  `Last-Event-ID` when resuming. Server must send `Cache-Control: no-cache`,
  `X-Accel-Buffering: no`, and must not gzip the stream, or proxies will buffer it into
  uselessness.
- Server sends a `ping` comment every 25s. If the client sees no bytes for 60s it tears
  down the socket and reconnects — a half-open TCP connection is otherwise invisible.
- Reconnect backoff: 1s, 2s, 4s … capped at 60s, with ±20% jitter so a server restart
  does not produce a thundering herd. Reset on any successfully received event.
- After 5 consecutive SSE failures, fall back to long-poll
  (`GET /api/v1/alerts/pending?wait=30`) and retry SSE every 5 minutes.

**Implementation note:** the browser `EventSource` API cannot set an `Authorization`
header, and Node's native `EventSource` is not available across all VS Code versions we
would support. So we consume `fetch(...).body` and parse the SSE framing ourselves —
roughly 60 lines (split on `\n\n`, read `event:`/`data:`/`id:`/`retry:` fields) and fully
unit-testable. This is a deliberate choice, not an oversight.

### 7.2 Showing the alert

```ts
const picked = await vscode.window.showWarningMessage(
  alert.message,
  { modal: alert.modal, detail: alert.title },
  ...alert.buttons.map(b => b.label)
);
```

Two behaviours worth knowing, because they shape the UX:

- A notification **with buttons stays on screen until the user acts**; one without buttons
  auto-hides after a few seconds. Every alert therefore needs at least one button, even if
  it is just "OK", or it will vanish unanswered.
- `showInformationMessage` returns a promise that resolves to the chosen label or
  `undefined` on dismissal. **There is no API to close a notification programmatically.**
  This matters in §9.3.

### 7.3 Alert bursts

Ten alerts at once produce ten stacked notifications, and the user will miss most of them.
Mitigation: if more than 3 alerts are outstanding, stop showing individual notifications
and switch to a single "N alerts pending" notification whose button opens a QuickPick
list of them. The status bar count is the always-on indicator.

## 8. The form

- A single webview panel (`vscode.window.createWebviewPanel`), **singleton** — a second
  invocation calls `panel.reveal()` instead of opening a duplicate.
- Fields are hardcoded in one module (`form/fields.ts`) as a typed const, so the webview
  renderer, the validator, and the request body all derive from one source. Even in the
  hardcoded design, having a single declaration is what makes a later server-driven schema
  a contained change rather than a rewrite.
- Rendering: plain HTML using `var(--vscode-*)` CSS variables so it matches the user's
  theme, light/dark/high-contrast, for free. No UI framework — the form is small enough
  that React would be more build tooling than payoff.
- CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`
  with `localResourceRoots` limited to the `media/` folder.
- Message protocol:
  - webview → extension: `{ type: 'submit', payload }`, `{ type: 'draft', payload }`,
    `{ type: 'cancel' }`
  - extension → webview: `{ type: 'init', draft }`, `{ type: 'busy', value }`,
    `{ type: 'result', ok, error? }`
- **Drafts:** instead of `retainContextWhenHidden` (which keeps the whole webview alive in
  memory), the webview posts a debounced `draft` message on every change; the extension
  stores it in `workspaceState` and restores it in `init`. Closing the panel mid-form and
  reopening it does not lose typing.
- **Validation runs twice:** in the webview for immediate feedback (disable Submit, inline
  messages), and again in the extension before the POST, because the webview is not a
  trustworthy source. The server validates a third time and is authoritative.
- Submit flow: disable the form → POST with an `Idempotency-Key` generated once per
  submission attempt → on success, clear draft, close panel, show a confirmation
  notification → on failure, re-enable the form with the error inline and offer to queue
  it in the outbox.

## 9. Reliability

### 9.1 Outbox

Alert responses and form submissions are user intent that must not evaporate because the
network blipped. Both go through a durable queue in `globalState`:

- Each entry: `{ id, kind, url, body, idempotencyKey, attempts, nextAttemptAt }`.
- Flushed on: successful send of anything else, SSE reconnect, extension activation, and a
  60s timer while non-empty.
- Bounded at 100 entries and 7 days; older entries are dropped with a log line.
- Because every entry carries an idempotency key, replaying after an ambiguous failure is
  safe.

### 9.2 Duplicate delivery

SSE is at-least-once — a reconnect with `Last-Event-ID` can legitimately re-deliver.
The client keeps a bounded set of the last ~200 seen alert IDs (in `globalState`, with
timestamps, pruned at 7 days) and drops repeats before showing anything.

### 9.3 Multiple windows

Every open VS Code window is a separate extension host, so N windows means N SSE
connections for one user, and the same alert shown N times. Options:

1. **Server fans out to all connections; client dedupes and first response wins.** The
   duplicate notifications in the other windows cannot be closed programmatically (§7.2),
   so they linger; when the user clicks one, the response POST returns `409` and the
   client silently ignores it. Slightly untidy, no coordination needed.
2. **Leader election** — one window holds a lock (a lockfile with a heartbeat in the
   global storage path) and is the only one that connects. Clean UX, but lock handoff on
   crash is fiddly and it is the classic source of "no alerts at all" bugs.

**Recommendation: option 1** for v1, with the `409` path implemented properly. Revisit if
users complain about ghost notifications.

### 9.4 Remote development

In Remote-SSH / Dev Containers / Codespaces, extensions run on the remote host by default,
so the SSE connection would originate there — which may not have network access to the
alert server. Set `"extensionKind": ["ui", "workspace"]` to prefer the local side, and
test one remote scenario before release.

## 10. Build plan

Each phase is independently demoable. Phases 3–5 assume the mock server from Phase 3.

| # | Phase | Deliverable | Done when |
|---|---|---|---|
| 0 | Contract | This document + an OpenAPI file agreed with the backend team | Both sides sign off on §5 |
| 1 | Skeleton | `yo code` scaffold, TS strict, ESLint, `onStartupFinished` activation, status bar item, output channel, settings contributed | F5 opens a dev host showing the status bar item; clicking it logs |
| 2 | Config & auth | `ConfigService` with the three-source resolution, SecretStorage migration, Sign In command, redacting logger | Unit tests cover all three sources + precedence + 401 invalidation |
| 3 | API client + mock | `ApiClient` (auth, timeout, retry, typed errors) and a ~150-line Express mock server with a CLI to push alerts | `GET /me` succeeds against the mock; every error code maps correctly |
| 4 | Alerts via polling | `AlertService`: catch-up poll, notification with 1–2 buttons, response POST, dedupe set | Push an alert from the mock CLI → notification appears → server records the answer |
| 5 | SSE | `EventStream`: hand-rolled parser, heartbeat, jittered backoff, `Last-Event-ID` resume, long-poll fallback | Kill the mock mid-stream → client reconnects and receives an alert queued during the outage |
| 6 | Form | Webview panel, hardcoded fields, CSP + nonce, theme variables, validation, submit | Open from status bar → fill → submit → mock records the payload; invalid input blocks Submit |
| 7 | Reliability | Outbox, draft persistence, alert-burst coalescing, 409 handling | Submit with the mock stopped → restart mock → submission arrives exactly once |
| 8 | Tests | Unit (parser, backoff, token resolution, outbox, validation) + `@vscode/test-electron` integration (commands registered, panel opens) + manual matrix | CI green on Linux/macOS/Windows |
| 9 | Packaging | `vsce package`, README, CHANGELOG, icon, telemetry opt-out honoured | A `.vsix` installs cleanly on a machine that never had the dev setup |
| 10 | Ops | Structured logs, a "Report Issue" command that dumps redacted diagnostics, version pinning between client and server | Support can diagnose a user issue from one pasted log |

Rough sizing: phases 1–4 are the first useful milestone. Phase 5 is the one that always
takes longer than estimated, because reconnect edge cases only appear under real network
conditions.

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| "Toolbar" expectation vs. status bar reality | UX surprise at demo | Settled in §3 before any code |
| Corporate proxy buffers SSE | Alerts arrive minutes late or never | Correct response headers; long-poll fallback; test behind the real proxy in Phase 5 |
| Token in `settings.json` leaks via Settings Sync or a commit | Credential exposure | Application-scoped setting, SecretStorage migration, redacting logger (§6.2) |
| Notification bursts | Users miss alerts | Coalescing + status bar count (§7.3) |
| Duplicate alerts across windows | Ghost notifications | Dedupe + `409` handling (§9.3) |
| Hardcoded fields change | New release + user updates for every field tweak | Single `fields.ts` declaration keeps the later schema migration contained (§8) |
| Remote dev has no route to the server | Extension silently dead | `extensionKind` + one remote test (§9.4) |

## 12. Open questions

1. **Form fields.** The exact list, types, validation rules, and which are required. §5.3
   is a placeholder standing in until this is answered — it blocks Phase 6, nothing earlier.
2. **Alert lifetime.** Should an unanswered alert expire client-side and report `expired`,
   or persist until answered across restarts?
3. **Server-side routing.** How does the server decide *which* user gets an alert — is
   there a user registry, or does the client announce itself on connect?
4. **Distribution.** Public Marketplace, a private/internal gallery, or a `.vsix` file
   passed around? This changes the update story and whether we need a version check.
5. **Multiple submissions.** May a user have several forms in flight, or is one at a time
   sufficient? The singleton panel in §8 assumes one at a time.
6. **Telemetry.** Any requirement to report delivery/response metrics beyond what the
   server already sees?
