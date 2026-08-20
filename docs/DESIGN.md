# Alerts & Forms — VS Code Extension: High-Level Design

Status: draft for review
Target: VS Code extension (TypeScript), not Visual Studio VSIX

## 1. What we are building

A VS Code extension that connects to a backend and does two things:

1. **Alerts.** The server pushes an alert; the extension shows it to the user with one or
   two action buttons; the user's choice (or dismissal) is posted back to the server.
2. **Form.** A permanent icon in the Activity Bar opens a sidebar containing a compute
   resource request form — GPU type and count, CPU cores, RAM, SSD — whose payload is
   posted to the server.

Everything else in this document exists to make those two flows reliable when the
network drops, the token expires, or the user has six windows open.

## 2. Decisions taken

| Question | Decision | Consequence |
|---|---|---|
| IDE | VS Code extension, TypeScript / Node | `.vsix` package; no VSIX/C# work |
| Server → client transport | **SSE**, long-poll fallback | Push latency without a WebSocket; survives most corporate proxies |
| Form fields | **Hardcoded** in the extension, except GPU Type's options | Simple and type-safe; field changes require a new release, GPU list does not (§5.4) |
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
- View title bar buttons (`menus: view/title`): refresh the GPU list, and "Open in
  Editor" (§8.8).
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
full-width editor panel (§8.8). With only five short fields the sidebar is in practice
adequate, so this is an escape hatch rather than a load-bearing part of the design.

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

`POST /api/v1/forms/resource-request/submissions` with header `Idempotency-Key: <uuid v4>`

```json
{
  "gpuType": "h100-80",
  "gpuCount": 4,
  "cpuCores": 32,
  "ramGb": 256,
  "ssdGb": 1024,
  "clientContext": {
    "extensionVersion": "0.1.0",
    "vscodeVersion": "1.9x.x",
    "platform": "linux",
    "optionsEtag": "W/\"g7c1\""
  }
}
```

Field contract:

| Field | Key | Type | Range | Required |
|---|---|---|---|---|
| GPU Type | `gpuType` | string id from `/form-options` | any returned id, incl. `none` | yes |
| Number of GPUs | `gpuCount` | integer | 1–8, or the option's `maxCount` | **only when** `gpuType != "none"` |
| CPU cores | `cpuCores` | integer | 1–256 | yes |
| RAM | `ramGb` | integer, GB | 1–2048 | yes |
| SSD | `ssdGb` | integer, GB | 1–2048 | yes |

`gpuCount` is **omitted entirely** when `gpuType` is `none` — not sent as `0` or `null`.
A request with `gpuType: "none"` and a `gpuCount` present is a client bug, and the server
should reject it with `422` rather than silently ignoring the field. Being strict here
means a future bug in the conditional logic surfaces immediately instead of quietly
provisioning the wrong thing.

`optionsEtag` lets the server see which version of the GPU list the client was rendering,
which turns "user picked a type we just retired" from a mystery into a one-line diagnosis.

Response `201 { "id": "req_...", "url": "https://..." }` — the client shows a notification
with an "Open" button linking to `url`.

Relevant `422` codes: `invalid_gpu_type` (unknown or retired id), `gpu_count_not_allowed`
(sent with `none`), `gpu_count_out_of_range` (exceeds that type's `maxCount`),
`out_of_range` (any numeric field). All are handled by §8.7.

### 5.4 Form options (server → client)

The one piece of the form that is not hardcoded.

`GET /api/v1/form-options` with `If-None-Match: <etag>` → `304` when unchanged.

```json
{
  "gpuTypes": [
    { "id": "none",    "label": "No GPU",            "maxCount": 0 },
    { "id": "a100-40", "label": "NVIDIA A100 40GB",  "maxCount": 8 },
    { "id": "h100-80", "label": "NVIDIA H100 80GB",  "maxCount": 4 }
  ]
}
```

Two deliberate choices:

- **The `none` option is server-supplied**, with the reserved id `none`, so its label is
  the backend's to word ("No GPU", "CPU only", …). The client still synthesises it if the
  server omits it, because a form with no way to say "no GPU" is broken — but that path
  logs a warning, since it means the contract was not honoured.
- **`maxCount` is per option.** A blanket 1–8 is almost certainly wrong: node topologies
  differ per accelerator, and hard-coding 8 in the extension means shipping a release to
  correct it. The client clamps to `min(maxCount, 8)` and falls back to 8 if the field is
  absent, so a server that never sends `maxCount` still behaves exactly as specified.

Order is preserved as sent — the backend controls what appears first. The client does not
re-sort.

### 5.5 Errors

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

- Rendering: plain HTML using `var(--vscode-*)` CSS variables — specifically the
  `--vscode-sideBar-*` and `--vscode-input-*` families — so it matches the user's theme in
  light, dark and high-contrast for free. No UI framework; five fields do not justify
  React's build tooling.
- Layout is single-column and fluid with labels above inputs, so it survives the sidebar
  being dragged narrow.
- CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`
  with `localResourceRoots` limited to `media/`.
- Message protocol:
  - webview → extension: `{ type: 'submit', payload }`, `{ type: 'draft', payload }`,
    `{ type: 'refreshOptions' }`
  - extension → webview: `{ type: 'init', draft, options, optionsState }`,
    `{ type: 'busy', value }`, `{ type: 'result', ok, error?, fieldErrors? }`

### 8.2 The fields

Declared once in `form/fields.ts` as a typed const; the renderer, the client-side
validator and the request body all derive from that single declaration. Even in a
hardcoded design this is what keeps a later server-driven schema a contained change rather
than a rewrite.

| Field | Control | Range | Notes |
|---|---|---|---|
| GPU Type | `<select>` | options from `/form-options` | Options are dynamic; the field itself is not |
| Number of GPUs | `<select>` 1…N | 1–`maxCount` (≤8) | Hidden when GPU Type is `none` |
| CPU cores | text, `inputmode="numeric"` | 1–256 | |
| RAM (GB) | text, `inputmode="numeric"` | 1–2048 | |
| SSD (GB) | text, `inputmode="numeric"` | 1–2048 | |

Two control choices worth justifying:

- **GPU count is a `<select>`, not a number input.** The range is at most eight discrete
  values, it is regenerated whenever GPU Type changes (because `maxCount` is per type), and
  a dropdown makes an out-of-range value unrepresentable rather than merely rejected.
- **The other three are `type="text"` with `inputmode="numeric"`, not `type="number"`.**
  `type="number"` has two properties that hurt here: its `.value` is the empty string when
  the user types something unparseable, so we cannot echo back what they actually typed;
  and its scroll-wheel behaviour silently changes the value when a user scrolls the
  sidebar with the cursor over the field. Reading raw text and validating it ourselves
  avoids both. `inputmode="numeric"` still gets the numeric keypad where that applies.

### 8.3 Conditional logic for GPU count

Rules, in the order they matter:

1. GPU Type is `none` → the count field is **hidden** (not merely disabled) and `gpuCount`
   is omitted from the payload.
2. GPU Type changes to a type whose `maxCount` is lower than the current selection → the
   count is clamped down to `maxCount`, with a one-line inline note explaining why, rather
   than silently changing a number the user chose.
3. Switching to `none` and back **restores the previous count** from the draft. Hidden
   fields keep their draft value; they are simply excluded from the payload. Losing a
   user's input because they toggled a dropdown twice is the kind of small betrayal that
   makes people distrust a form.

The extension re-derives all of this before POSTing. The webview decides what to *show*;
it never decides what to *send*.

### 8.4 GPU options: fetching, caching, and failure

The GPU list is the form's one external dependency, and it is on the critical path — a
user who cannot see the list cannot fill the form at all. So:

- **Cached** in `globalState` alongside its ETag. On open, the form renders from cache
  **immediately** and revalidates in the background with `If-None-Match`; a `304` costs
  nothing and a `200` swaps the list in place, preserving the current selection if its id
  still exists.
- **Refreshed** on: first activation, view becoming visible when the cache is older than
  15 minutes, an explicit refresh button in the view title, and after any
  `invalid_gpu_type` rejection.
- **Cold start with no cache and a failed fetch** → the form renders in an explicit error
  state ("Couldn't load GPU types") with a Retry button, and Submit disabled. Not an empty
  dropdown, and not a form the user fills in before discovering it cannot be sent.
- **Stale cache with a failed refresh** → the form stays usable with a quiet inline notice
  that the list may be out of date. Degraded beats blocked; the server validates
  `gpuType` on submit anyway, so a retired id fails loudly at the only point where it
  matters.
- **The selected id disappears** from a refreshed list → the selection is cleared and the
  field is marked with "This GPU type is no longer available." Silently substituting a
  different accelerator would be the worst possible behaviour here.

### 8.5 Draft persistence

The webview posts a debounced `draft` message on every change; the extension stores it in
`workspaceState` and replays it in `init`. This covers all four ways the form can go away:
collapsing the view, switching Activity Bar containers, closing the editor panel, and
reloading the window. The draft holds raw strings, not parsed numbers, so a half-typed
`12` in the RAM field survives a reload as `12` rather than being dropped for failing
validation.

### 8.6 Validation

**Validation runs twice on the client**: in the webview for immediate feedback (inline
messages, disabled Submit), and again in the extension before the POST, because a webview
is not a trustworthy input source. The server validates a third time and is authoritative.

The three free-text numerics share one strict parser:

```ts
const asInt = (raw: string): number | undefined => {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return undefined;   // rejects "", "1.5", "1e3", "0x10", "-1", "12abc"
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
};
```

`parseInt` is deliberately avoided: it accepts `"12abc"` as `12` and `"0x10"` as `16`,
which is exactly the class of silent misprovisioning we do not want. Range checks then
apply per field, with messages naming the bound ("RAM must be between 1 and 2048 GB").

Validation fires on blur and on submit, not on every keystroke — flagging `1` as invalid
while someone is still typing `128` trains users to ignore the error text.

### 8.7 Submit

Disable the form → validate in the extension → POST with an `Idempotency-Key` generated
once per submission attempt → on success clear the draft, reset the form to defaults, show
a confirmation notification with an "Open" button linking to the created record.

On `422`, map the server's field-level codes back onto the specific inputs via
`fieldErrors` so the user sees the problem next to the field rather than in a generic
banner. On network failure, re-enable the form and offer to queue the submission in the
outbox (§9.1).

On success the sidebar view **resets in place** rather than closing, since there is
nothing to close — the user is left looking at an empty ready form, which is the right
resting state for something people submit repeatedly.

### 8.8 "Open in Editor"

A button in the view title bar reopens the same form as a full-width `WebviewPanel` in the
editor area. The two hosts share one HTML generator, one message handler and one draft —
only the shell differs. With five short fields the sidebar is genuinely adequate, so this
is a convenience rather than a necessity; it is cheap enough to keep, and it is the escape
hatch if field count grows.

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
| 3 | API client + mock | `ApiClient` (auth, timeout, retry, typed errors) and a ~150-line Express mock server: `/me`, `/form-options` with ETag support, submission endpoint, and a CLI to push alerts | `GET /me` succeeds against the mock; a second `/form-options` call returns `304`; every error code maps correctly |
| 4 | Alerts via polling | `AlertService`: catch-up poll, notification with 1–2 buttons, response POST, dedupe set; `AlertTreeProvider` with inline action buttons, badge and welcome states | Push an alert from the mock CLI → it appears in both the notification and the view, badge increments, answering either way records once |
| 5 | SSE | `EventStream`: hand-rolled parser, heartbeat, jittered backoff, `Last-Event-ID` resume, long-poll fallback | Kill the mock mid-stream → client reconnects and receives an alert queued during the outage |
| 6 | Form | `WebviewView` in the sidebar, the five fields, options fetch + cache + error states, conditional GPU count, strict validation, submit, "Open in Editor" | Open from the Activity Bar → fill → submit → mock records the payload; `none` omits `gpuCount`; toggling to `none` and back restores the count; `1e3` and `12abc` are rejected; cold start with the mock down shows Retry, not an empty dropdown; collapsing the view preserves the draft |
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
| Sidebar too narrow for comfortable typing | Users avoid the form | Five short fields fit; fluid single-column layout plus "Open in Editor" (§8.8) |
| `WebviewView` torn down when hidden | Lost input, reported as a data-loss bug | Draft persistence on every change, tested explicitly in Phase 6 (§8.5) |
| Corporate proxy buffers SSE | Alerts arrive minutes late or never | Correct response headers; long-poll fallback; test behind the real proxy in Phase 5 |
| Token in `settings.json` leaks via Settings Sync or a commit | Credential exposure | Application-scoped setting, SecretStorage migration, redacting logger (§6.2) |
| Notification bursts | Users miss alerts | Coalescing into one notification + the alerts view and its badge (§7.3) |
| Duplicate alerts across windows | Ghost notifications | Dedupe + `409` handling (§9.3) |
| Hardcoded fields change | New release + user updates for every field tweak | Single `fields.ts` declaration keeps the later schema migration contained (§8.2) |
| GPU list unreachable on a cold start | Form is unusable, not merely degraded | Cached list + explicit error state with Retry instead of an empty dropdown (§8.4) |
| Lenient numeric parsing | Silently provisioning the wrong resources | Strict integer parser, no `parseInt`; server validates independently (§8.6) |
| GPU type retired between render and submit | Request provisioned against a dead type | `optionsEtag` on submit, `invalid_gpu_type` → refresh + clear selection, never substitute (§8.4) |
| Remote dev has no route to the server | Extension silently dead | `extensionKind` + one remote test (§9.4) |

## 12. Open questions

Resolved: the form fields are specified in §5.3 and §8.2. Phase 6 is unblocked.

Assumptions made while specifying them — each is a decision the backend can overturn
cheaply, but they are decisions, so they are listed rather than buried:

1. **`maxCount` is per GPU type**, defaulting to 8 when the server omits it (§5.4). If the
   limit really is a flat 1–8 across every accelerator, the field can be dropped and
   nothing else changes.
2. **The `none` option comes from the server** with the reserved id `none`. The client
   synthesises it if absent, but logs a warning.
3. **RAM and SSD accept any integer** in 1–2048 GB. If the backend only provisions certain
   increments (powers of two, multiples of 8), say so and the controls become steppers or
   dropdowns — better to constrain the input than to reject it after the fact.
4. **No defaults.** Every field starts empty and the user fills all of them. If there is a
   common configuration worth pre-filling, a default set would measurably reduce effort.
5. **No cross-field limits.** Nothing currently stops 1 CPU core with 2048 GB of RAM, or
   8 H100s with 1 core. If the backend enforces ratios or per-user quotas, the client
   should know them so it can warn before submission rather than after.

Still open:

6. **Alert lifetime.** Should an unanswered alert expire client-side and report `expired`,
   or persist until answered across restarts?
7. **Server-side routing.** How does the server decide *which* user gets an alert — is
   there a user registry, or does the client announce itself on connect?
8. **Distribution.** Public Marketplace, a private/internal gallery, or a `.vsix` file
   passed around? This changes the update story and whether we need a version check.
9. **Multiple submissions.** May a user have several requests in flight, or is one at a
   time sufficient? The single sidebar form view in §8 assumes one at a time.
10. **Telemetry.** Any requirement to report delivery/response metrics beyond what the
    server already sees?
