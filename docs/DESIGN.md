# Alerts & Forms — VS Code Extension: High-Level Design

Status: draft for review
Target: VS Code extension (TypeScript), not Visual Studio VSIX

## 1. What we are building

A VS Code extension that connects to a backend and does two things:

1. **Alerts.** The server pushes an alert; the extension shows it to the user with one or
   two action buttons; the user's choice (or dismissal) is posted back to the server.
2. **Form.** A permanent icon in the Activity Bar opens a sidebar containing a form with
   a small fixed set of fields plus Submit/Cancel; the submitted payload is posted to the
   server.

Everything else in this document exists to make those two flows reliable when the
network drops, the token expires, or the user has six windows open.

## 2. Decisions taken

| Question | Decision | Consequence |
|---|---|---|
| IDE | VS Code extension, TypeScript / Node | `.vsix` package; no VSIX/C# work |
| Server → client transport | **SSE**, long-poll fallback | Push latency without a WebSocket; survives most corporate proxies |
| Form fields | **Hardcoded** in the extension | Simple and type-safe; field changes require a new release |
| Auth | **API token from settings**, fallback to a known local file | No IdP work; token handling needs care (§6) |
| Entry point | **Activity Bar container** with a form view and an alerts view | Permanent icon in the left strip; form is one click away (§3) |

Open items are listed in §12.

## 3. The "toolbar button" — the Activity Bar

VS Code's equivalent of a toolbar is the **Activity Bar**: the vertical icon strip on the
left edge holding Explorer, Search, Source Control and so on. An extension can contribute
its own icon there, and clicking it opens a dedicated sidebar. Since the form is a primary
user-facing feature rather than an occasional utility, that is the placement we take.

### 3.1 What we contribute

```jsonc
"contributes": {
  "viewsContainers": {
    "activitybar": [
      { "id": "acmeAlerts", "title": "Alerts", "icon": "media/activity-bar.svg" }
    ]
  },
  "views": {
    "acmeAlerts": [
      { "id": "acmeAlerts.form",    "name": "New Request", "type": "webview" },
      { "id": "acmeAlerts.pending", "name": "Alerts",      "type": "tree"    }
    ]
  }
}
```

Two views inside one container:

- **`acmeAlerts.form`** — a `WebviewView` rendering the form *inside the sidebar*. One
  click on the Activity Bar icon and the user is looking at the form; there is no
  intermediate panel to open. This is the primary surface.
- **`acmeAlerts.pending`** — a `TreeView` listing outstanding and recently answered
  alerts. This is not decoration: it is what makes alerts recoverable when a notification
  is missed or auto-dismissed, and it replaces the QuickPick workaround for alert bursts
  (§7.3).

The Activity Bar icon must be a monochrome 24×24 SVG drawn with `currentColor`, or VS Code
will not theme it correctly.

### 3.2 The unread badge

A `TreeView` exposes `view.badge = { value: n, tooltip: '3 alerts awaiting response' }`,
which VS Code renders as a native numeric badge on the Activity Bar icon — the same
treatment Source Control uses for pending changes. This is a better unread indicator than
anything we could build in the status bar, and it is one line of code.

### 3.3 Empty and signed-out states

`contributes.viewsWelcome` fills a view before it has content, with markdown plus command
buttons. Two states worth authoring:

- No token configured → "Sign in to start receiving alerts" with a `[Sign In]` button
  bound to `acmeAlerts.signIn`.
- Connected, nothing pending → "No alerts. You're all caught up."

This turns the first-run experience into something self-explanatory instead of an empty
grey rectangle.

### 3.4 Secondary entry points

- Command Palette: `Acme Alerts: New Request`, `Acme Alerts: Sign In`,
  `Acme Alerts: Show Log`. Free, and how power users will actually reach the feature.
- View title bar buttons (`menus: view/title`): refresh, and "Open in Editor" (§8.2).
- A status bar item is **no longer needed** for the unread count — the Activity Bar badge
  covers it. Optional later if we want a persistent connection-status indicator.

### 3.5 Cost of this choice

The Activity Bar container takes a permanent slot in every user's window, whether or not
they have anything pending. For a feature users are expected to interact with regularly
that is the right trade; for a rarely-used utility it would be intrusive. Users who
disagree can hide it via right-click → Hide, so the escape hatch exists.

### 3.6 The narrow-width constraint

The sidebar defaults to roughly 300px. A handful of stacked fields fits comfortably; a
long free-text field is cramped. The design accounts for this with a single-column layout
that degrades gracefully, and an "Open in Editor" action that reopens the same form as a
full-width editor panel (§8.2).

## 4. Architecture

```
┌──────────────────────── VS Code extension host (Node) ────────────────────────┐
│                                                                               │
│  extension.ts  ── activation, command + view provider registration, disposal  │
│        │                                                                      │
│        ├── ConfigService      settings, token resolution, change watching     │
│        ├── ApiClient          fetch wrapper: auth header, retry, error map    │
│        ├── EventStream        SSE connect / parse / heartbeat / backoff       │
│        │        │                                                             │
│        │        └──> AlertService   dedupe → showInformationMessage → respond │
│        │                                                                      │
│        ├── FormViewProvider   WebviewView in the sidebar (primary surface)    │
│        │   FormPanel          same form as an editor panel ("Open in Editor")  │
│        │        └── webview/  index.html + form.js + form.css (CSP, nonce)    │
│        ├── AlertTreeProvider  pending/recent alerts + Activity Bar badge       │
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
import `vscode`. Only `extension.ts`, `AlertService`, the view
providers and `ConfigService` touch the VS Code API.

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
the reconnect loop, switch both views to their signed-out `viewsWelcome` state (§3.3), and
show one notification with a "Sign In" button. Do not loop on a bad token.

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

### 7.3 Alert bursts, and the alerts view

Ten alerts at once produce ten stacked notifications, and the user will miss most of them.
The `acmeAlerts.pending` tree view is the answer: notifications become the *fast path*,
and the view is the durable record.

- Every incoming alert is added to the view, whether or not its notification is seen.
- If more than 3 alerts are outstanding, individual notifications stop and a single
  "N alerts pending" notification appears, whose button reveals the view
  (`vscode.commands.executeCommand('acmeAlerts.pending.focus')`).
- Selecting an alert in the view re-presents it — as a modal dialog for a definitive
  answer, since the original notification cannot be reopened.
- Each tree item carries inline action buttons (`menus: view/item/context`,
  `group: "inline"`) for the alert's one or two responses, so the common case is answered
  in one click without opening anything.
- Answered alerts stay in a collapsed "Recent" node for the session, dimmed with the
  chosen response in the item description.

This also fixes the ghost-notification problem from §9.3 in the direction that matters: a
duplicate notification in another window cannot be closed, but the *view* in every window
reflects true state on the next event.

## 8. The form

### 8.1 Primary surface: a WebviewView in the sidebar

Registered with `vscode.window.registerWebviewViewProvider('acmeAlerts.form', provider,
{ webviewOptions: { retainContextWhenHidden: false } })`.

The important behavioural difference from a webview panel: **a `WebviewView` is torn down
when hidden** — when the user collapses it or switches to another Activity Bar container —
and `resolveWebviewView` runs again on return. We deliberately leave
`retainContextWhenHidden` off rather than pinning the webview in memory for the whole
session; the draft-persistence mechanism below already makes teardown invisible to the
user, and it is the same mechanism we need for a window reload anyway. One state
mechanism, not two.

- Fields are hardcoded in one module (`form/fields.ts`) as a typed const, so the renderer,
  the validator and the request body all derive from a single declaration. Even in a
  hardcoded design this is what keeps a later server-driven schema a contained change
  rather than a rewrite.
- Rendering: plain HTML using `var(--vscode-*)` CSS variables — specifically the
  `--vscode-sideBar-*` and `--vscode-input-*` families — so it matches the user's theme in
  light, dark and high-contrast for free. No UI framework; the form is small enough that
  React would be more build tooling than payoff.
- Layout is single-column and fluid, with no fixed pixel widths, so it survives the
  sidebar being dragged narrow. Labels sit above inputs rather than beside them.
- CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`
  with `localResourceRoots` limited to `media/`.
- Message protocol:
  - webview → extension: `{ type: 'submit', payload }`, `{ type: 'draft', payload }`,
    `{ type: 'cancel' }`
  - extension → webview: `{ type: 'init', draft }`, `{ type: 'busy', value }`,
    `{ type: 'result', ok, error? }`

### 8.2 "Open in Editor"

A button in the view title bar reopens the same form as a full-width
`WebviewPanel` in the editor area, for users who want room to write. The two hosts share
one HTML generator, one message handler and one draft — only the shell differs, so this
costs well under a hundred lines. The draft transfers, so the switch is seamless
mid-typing.

### 8.3 Draft persistence

The webview posts a debounced `draft` message on every change; the extension stores it in
`workspaceState` and replays it in `init`. This covers all four ways the form can go away:
collapsing the view, switching Activity Bar containers, closing the editor panel, and
reloading the window.

### 8.4 Validation and submit

**Validation runs twice on the client:** in the webview for immediate feedback (disabled
Submit, inline messages), and again in the extension before the POST, because a webview is
not a trustworthy input source. The server validates a third time and is authoritative.

Submit flow: disable the form → POST with an `Idempotency-Key` generated once per
submission attempt → on success clear the draft, reset the form, show a confirmation
notification with an "Open" button linking to the created record → on failure re-enable
the form with the error shown inline and offer to queue it in the outbox.

Note the difference from the old panel design: on success the sidebar view **resets in
place** rather than closing, because there is nothing to close. That is a better outcome —
the user sees an empty ready form rather than a disappearing panel.

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

**Recommendation: option 1** for v1, with the `409` path implemented properly. The alerts
tree view (§7.3) softens this considerably: even if a stale notification lingers in
another window, that window's view shows the alert as answered on the next event, so the
user always has one place showing the truth.

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
| 1 | Skeleton | `yo code` scaffold, TS strict, ESLint, `onStartupFinished` activation, Activity Bar container + icon, placeholder views, output channel, settings contributed | F5 opens a dev host; the Activity Bar icon appears and opens a sidebar with both views |
| 2 | Config & auth | `ConfigService` with the three-source resolution, SecretStorage migration, Sign In command, redacting logger | Unit tests cover all three sources + precedence + 401 invalidation |
| 3 | API client + mock | `ApiClient` (auth, timeout, retry, typed errors) and a ~150-line Express mock server with a CLI to push alerts | `GET /me` succeeds against the mock; every error code maps correctly |
| 4 | Alerts via polling | `AlertService`: catch-up poll, notification with 1–2 buttons, response POST, dedupe set; `AlertTreeProvider` with inline action buttons, badge and welcome states | Push an alert from the mock CLI → it appears in both the notification and the view, badge increments, answering either way records once |
| 5 | SSE | `EventStream`: hand-rolled parser, heartbeat, jittered backoff, `Last-Event-ID` resume, long-poll fallback | Kill the mock mid-stream → client reconnects and receives an alert queued during the outage |
| 6 | Form | `WebviewView` in the sidebar, hardcoded fields, CSP + nonce, theme variables, validation, submit, "Open in Editor" panel sharing the same code | Open from the Activity Bar → fill → submit → mock records the payload; invalid input blocks Submit; collapsing the view and returning preserves the draft |
| 7 | Reliability | Outbox, draft persistence, alert-burst coalescing, 409 handling | Submit with the mock stopped → restart mock → submission arrives exactly once; 10 alerts at once produce one notification and 10 view entries |
| 8 | Tests | Unit (parser, backoff, token resolution, outbox, validation) + `@vscode/test-electron` integration (commands registered, view container resolves, webview view renders) + manual matrix incl. a narrow sidebar and high-contrast theme | CI green on Linux/macOS/Windows |
| 9 | Packaging | `vsce package`, README, CHANGELOG, icon, telemetry opt-out honoured | A `.vsix` installs cleanly on a machine that never had the dev setup |
| 10 | Ops | Structured logs, a "Report Issue" command that dumps redacted diagnostics, version pinning between client and server | Support can diagnose a user issue from one pasted log |

Rough sizing: phases 1–4 are the first useful milestone. Phase 5 is the one that always
takes longer than estimated, because reconnect edge cases only appear under real network
conditions.

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Activity Bar slot is intrusive for low-frequency users | Users hide the container and stop seeing alerts | Notifications remain the primary alert channel and work with the container hidden (§3.5) |
| Sidebar too narrow for comfortable typing | Users avoid the form | Fluid single-column layout plus "Open in Editor" (§8.2) |
| `WebviewView` torn down when hidden | Lost input, reported as a data-loss bug | Draft persistence on every change, tested explicitly in Phase 6 (§8.3) |
| Corporate proxy buffers SSE | Alerts arrive minutes late or never | Correct response headers; long-poll fallback; test behind the real proxy in Phase 5 |
| Token in `settings.json` leaks via Settings Sync or a commit | Credential exposure | Application-scoped setting, SecretStorage migration, redacting logger (§6.2) |
| Notification bursts | Users miss alerts | Coalescing into one notification + the alerts view and its badge (§7.3) |
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
   sufficient? The single sidebar form view in §8 assumes one at a time.
6. **Telemetry.** Any requirement to report delivery/response metrics beyond what the
   server already sees?
