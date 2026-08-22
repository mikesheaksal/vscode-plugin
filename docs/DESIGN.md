# Alerts & Forms — VS Code Extension: High-Level Design

Status: draft for review
Target: VS Code extension (TypeScript), not Visual Studio VSIX

## 1. What we are building

A VS Code extension that connects to a backend and does two things:

1. **Alerts.** The server pushes an alert; the extension shows it to the user with one or
   two action buttons; the user's choice (or dismissal) is posted back to the server.
2. **Machine configuration.** A permanent icon in the Activity Bar opens a sidebar showing
   the machine's current configuration — GPU type and count, CPU cores, RAM, SSD — as an
   editable form. Applying a change reconfigures the machine **directly**; there is no
   approval step, which is why §8 spends as much space on confirmation and concurrency as
   on rendering fields.

Everything else in this document exists to make those two flows reliable when the
network drops, the token expires, or the user has six windows open.

## 2. Decisions taken

| Question | Decision | Consequence |
|---|---|---|
| IDE | VS Code extension, TypeScript / Node | `.vsix` package; no VSIX/C# work |
| Backend | **Go**, gRPC + grpc-gateway | Contract lives in `.proto`; the extension talks JSON to the gateway (§5) |
| Server → client transport | **Server-streaming RPC** (NDJSON over chunked HTTP), long-poll fallback | Push latency without a WebSocket; simpler client parser than SSE (§5.1) |
| Alert lifetime | Persist until answered or **revoked by the server** | No client-side expiry; alerts survive restarts (§7.4) |
| Identity | Client-id file on the machine, token separately (§6) | Server routes alerts by client id |
| Distribution | **`.vsix` passed around** | No auto-update, so version skew is a first-class concern (Phase 9) |
| Telemetry | **None** | The extension reports nothing beyond the six RPCs |
| Form fields | **Hardcoded** in the extension, except GPU Type's options | Simple and type-safe; field changes require a new release, GPU list does not (§5.4) |
| Form semantics | **Edit the current machine**, applied directly by the backend | Destructive: server-computed preview, confirmation, cancellation window, optimistic concurrency (§8.7–§8.9) |
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
      { "id": "acmeAlerts.machine", "name": "Machine",     "type": "webview" },
      { "id": "acmeAlerts.pending", "name": "Alerts",      "type": "tree"    }
    ]
  }
}
```

Two views inside one container:

- **`acmeAlerts.machine`** — a `WebviewView` rendering the machine configuration form
  *inside the sidebar*. One click on the Activity Bar icon and the user is looking at
  their machine's current settings; there is no intermediate panel to open. This is the
  primary surface.
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

- Command Palette: `Acme Alerts: Show Machine`, `Acme Alerts: Sign In`,
  `Acme Alerts: Show Log`. Free, and how power users will actually reach the feature.
- View title bar buttons (`menus: view/title`): refresh the GPU list, and "Open in
  Editor" (§8.10).
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
full-width editor panel (§8.10). With only five short fields the sidebar is in practice
adequate, so this is an escape hatch rather than a load-bearing part of the design.

## 4. Architecture

```
┌──────────────────────── VS Code extension host (Node) ────────────────────────┐
│                                                                               │
│  extension.ts  ── activation, command + view provider registration, disposal  │
│        │                                                                      │
│        ├── ConfigService      settings, token resolution, change watching     │
│        ├── ApiClient          fetch wrapper: auth header, retry, error map    │
│        ├── EventStream        stream connect / NDJSON parse / heartbeat / backoff │
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
                    │  HTTPS                            ▲  chunked NDJSON stream  
                    ▼                                   │
┌──────────────────── Server (Go, gRPC + grpc-gateway) ─────────────────────────┐
│  GET  /api/v1/client                      identity + min client version        │
│  GET  /api/v1/events                      server-stream of alerts (NDJSON)     │
│  GET  /api/v1/alerts:pending              catch-up / long-poll fallback        │
│  POST /api/v1/alerts/{id}/response        user's button choice or dismissal    │
│  GET  /api/v1/machine/config              catalogue + current config + limits  │
│  POST /api/v1/machine/config:preview      what would this change do?           │
│  POST /api/v1/machine/config:apply        apply a new configuration            │
│  POST /api/v1/machine/changes/{id}:cancel abort within the cancel window       │
└───────────────────────────────────────────────────────────────────────────────┘

Module boundaries matter for one practical reason: `ApiClient`, `EventStream`, `Outbox`
and validation must be unit-testable without a running VS Code, so nothing in them may
import `vscode`. Only `extension.ts`, `AlertService`, the view
providers and `ConfigService` touch the VS Code API.

## 5. Wire protocol

**The contract is [`proto/acme/alerts/v1/alerts.proto`](../proto/acme/alerts/v1/alerts.proto).**
That file is the source of truth; this section covers only what the projection from gRPC
onto JSON/HTTP means for the client, which is not visible in the annotations themselves.

Eight RPCs:

| RPC | HTTP | Purpose |
|---|---|---|
| `GetClientInfo` | `GET /api/v1/client` | Validate token + client id, learn `min_client_version` |
| `SubscribeEvents` | `GET /api/v1/events` | Server stream of alerts, revocations, heartbeats |
| `ListPendingAlerts` | `GET /api/v1/alerts:pending` | Catch-up on activation; long-poll fallback |
| `RespondToAlert` | `POST /api/v1/alerts/{alert_id}/response` | Record the user's answer |
| `GetMachineConfig` | `GET /api/v1/machine/config` | GPU catalogue + current config + bounds + any change in flight |
| `PreviewMachineConfig` | `POST /api/v1/machine/config:preview` | What would this change do? Restart? Valid? |
| `ApplyMachineConfig` | `POST /api/v1/machine/config:apply` | Apply a new configuration directly |
| `CancelMachineChange` | `POST /api/v1/machine/changes/{change_id}:cancel` | Abort within the cancellation window |

### 5.1 The streaming response is NDJSON, not SSE

This corrects an assumption in the earlier draft of this document, and it is the single
most important thing for the client author to know.

grpc-gateway renders a server-streaming RPC as a chunked HTTP response carrying **one JSON
object per line**, each wrapped in a result envelope:

```
{"result":{"sequence":"41","heartbeat":{"serverTime":"2026-08-20T10:00:00Z"}}}
{"result":{"sequence":"42","alert":{"alertId":"alt_01J8XZ","severity":"SEVERITY_WARNING",...}}}
{"error":{"code":16,"message":"token expired","details":[]}}
```

Consequences, all of which the client handles:

- **No `data:` framing, no SSE comments.** The parser splits on `\n` and JSON-parses each
  line — simpler than the SSE parser the earlier draft called for, and there is no reason
  to bolt SSE framing onto the gateway with a custom marshaler just to match a document.
- **Unwrap `.result`.** A line carrying `.error` instead is a terminal `google.rpc.Status`;
  the stream is over and the client reconnects (or stops, on `UNAUTHENTICATED`).
- **No `Last-Event-ID`, no browser auto-reconnect.** Resumption is the `last_sequence`
  request field. Since we were reconnecting by hand anyway (§7.1), nothing is lost.
- **Heartbeats must be in-band**, because there are no SSE comment frames. Hence the
  `Heartbeat` variant in the `Event` oneof.
- **Buffering is still the risk it always was.** The Go handler must call `Flush()` per
  message, and any proxy in front needs `X-Accel-Buffering: no` and no response
  compression, or events arrive in clumps. This is what the long-poll fallback exists for.
- **The server must send a heartbeat immediately on stream open.** grpc-gateway does not
  flush response headers until the first message, so a stream that opens with nothing to
  say leaves the client's `fetch()` unresolved — indistinguishable from a server that
  never answered — until the first 25s tick. Found by the Phase 3 integration tests, which
  hung on exactly this; the mock now sends one and the real backend must too.

### 5.2 JSON field naming

We use **default proto3 JSON**: `lowerCamelCase` field names, enums as their full string
names (`"SEVERITY_WARNING"`), `uint64` as a **string** (`"sequence": "42"`), and
`google.protobuf.Timestamp` as RFC 3339.

That means the gateway must be built with the standard marshaler and **not**
`UseProtoNames: true` — otherwise the server emits `gpu_type_id` while the generated
TypeScript expects `gpuTypeId`, and the mismatch will not show up until runtime.
`EmitUnpopulated` stays **false**, which is what keeps an unset `gpu_count` genuinely
absent from the JSON rather than serialised as `0` (§8.3).

The `uint64`-as-string rule catches people out: `sequence` is a quoted string in JSON and
must be parsed with `BigInt` or compared as a string, not read as a number.

### 5.3 Identity and idempotency travel in the body, not in headers

`Idempotency-Key` and the client id are request **fields**, not HTTP headers, even though
headers would be the more conventional REST choice. The reason is specific to
grpc-gateway: its default incoming-header matcher forwards only a fixed set of permanent
HTTP headers plus anything prefixed `Grpc-Metadata-`. A custom `Idempotency-Key` header
would silently not arrive unless the server installs a `WithIncomingHeaderMatcher`, and
"silently not arrive" is the worst possible failure mode for an idempotency key.

Putting them in the message makes them part of the contract, visible in the generated
types on both sides, and identical whether a caller speaks gRPC or JSON.

`Authorization` is the exception and stays a header — it is on the permanent list, it is
what every HTTP client and proxy already understands, and it is not part of the domain.

### 5.4 Errors

Standard gRPC statuses, mapped by the gateway. The codes the client acts on:

| gRPC code | HTTP | Client behaviour |
|---|---|---|
| `INVALID_ARGUMENT` | 400 | Field-level errors mapped back onto inputs (§8.8); never retried |
| `UNAUTHENTICATED` | 401 | Re-resolve the token once, then prompt; stop reconnecting (§6.3) |
| `PERMISSION_DENIED` | 403 | Token is not authorized for this client id; prompt, do not retry |
| `NOT_FOUND` | 404 | Unknown alert or client id; drop from the view and log |
| `FAILED_PRECONDITION` | 400 | Alert already revoked or answered elsewhere; refresh the view |
| `ABORTED` | 409 | Conflicting answer to an already-answered alert; log, do not surface |
| `RESOURCE_EXHAUSTED` | 429 | Honour `Retry-After`, back off |
| `UNAVAILABLE` / network | 503 | Outbox + backoff (§9.1) |

Note there is no 422 — gRPC has no equivalent, so validation failures are
`INVALID_ARGUMENT` → 400 carrying `google.rpc.BadRequest` with a `FieldViolation` per bad
field. The `field` string matches the proto path (`spec.ram_gb`), which is what lets the
client map a violation to the right input without a bespoke error vocabulary. **When
cross-field limits arrive later, they need no client change** — a new violation on
`spec.cpu_cores` renders next to the CPU field automatically.

### 5.5 What the mock confirmed

Phase 3 put a Go mock behind a real grpc-gateway and pointed the client at it, so the
claims in this section are now observations rather than expectations:

```
{"result":{"sequence":"1","alert":{"alertId":"alt_1","severity":"SEVERITY_WARNING", ...}}}
```

- The stream envelope is `{"result": …}` per line, with no `data:` framing.
- `sequence` is a **JSON string**, as the uint64 rule predicts.
- Field names are lowerCamelCase; enums are full string names.
- `EmitUnpopulated: false` keeps an unset `gpu_count` genuinely absent, and also means
  `requiresRestart` is **omitted rather than `false`** — the client must treat absent as
  false, which the generated types do.
- `INVALID_ARGUMENT` carries `google.rpc.BadRequest` with `fieldViolations[].field` set to
  the proto path, so `spec.ram_gb` maps straight onto the RAM input.

### 5.6 Code generation

`make generate` produces, from the one file: Go message and gRPC stubs, the grpc-gateway
mux, an OpenAPI v2 document, and **TypeScript types for the extension**. Two templates,
because the Go side must not regenerate the googleapis imports it gets from published
modules while the TypeScript side has no published equivalent to depend on. The client speaks JSON to the gateway rather than
gRPC, but generating its types from the same proto means a field rename breaks the
TypeScript build instead of a user's form. That is most of the payoff of doing this
proto-first, and it costs one plugin entry.

`buf breaking` in CI against the main branch runs from day one, because the .vsix
distribution model (Phase 9) means old clients stay in the field indefinitely.

Plugins are **local, not remote**, and the googleapis imports are **vendored** under
`proto/third_party`: the buf.build registry is not reachable from every environment this
repo builds in, and a contract that cannot be regenerated in CI is not much of a contract.
`make tools` installs everything. Generated output is committed, so building the extension
needs only npm and building the mock needs only Go.

### 5.7 If grpc-gateway is dropped

Nothing above except §5.1–5.3 depends on it. The six operations, their payloads, the
persistence and revocation semantics, and every client behaviour in §7–§9 are transport
decisions, not gateway decisions. Serving the same JSON from plain `net/http` handlers
would change three things and no more: the streaming envelope stops being
`{"result": …}` and becomes the bare `Event` per line, field naming becomes whatever the
Go structs say, and error bodies need a shape of their own in place of `google.rpc.Status`.
The proto stays useful as the contract document either way.

## 6. Identity and authentication

Two separate things, and conflating them is the mistake to avoid: the **client id** says
*which machine this is* and is what the server routes alerts to; the **token** proves the
caller is allowed to act as it.

### 6.0 The client id

Read from a file on the user's machine — `acmeAlerts.clientIdFilePath`, defaulting to
`$XDG_CONFIG_HOME/acme-alerts/client-id` (`~/.config/...`) and
`%APPDATA%\acme-alerts\client-id` on Windows. First line, trimmed.

- **Never generated by the client.** A self-invented id is one the server has never heard
  of, so it routes nothing and the user sees an extension that silently does nothing. A
  missing file is a configuration error and is surfaced as one: both views switch to a
  `viewsWelcome` state naming the exact path that was searched, with a "Reload" button.
- **Watched for changes** with an fs watcher, so provisioning the file makes the extension
  come alive without a window reload.
- **Not a secret**, so it travels as an ordinary request field and appears in query
  strings and access logs. That is fine *provided* the server enforces the pairing: it
  must reject a token that is not authorized for the presented client id with
  `PERMISSION_DENIED`. Without that check, any valid token could subscribe to any
  client's alerts — the client id would become an authorization bypass rather than a
  routing key.
- **A single credentials file is also accepted.** If the token file (or the client-id
  file) contains JSON with `client_id` and `token` keys, both are taken from it. One file
  to provision is a better operator story than two, and it costs about ten lines.

### 6.1 Token resolution order

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

On `UNAUTHENTICATED` (401): drop the cached token, re-resolve from scratch (the file may
have been refreshed by an external tool), retry the request exactly once. If it fails
again, stop the reconnect loop, switch both views to their signed-out `viewsWelcome` state
(§3.3), and show one notification with a "Sign In" button. Do not loop on a bad token.

On `PERMISSION_DENIED` (403) the token is valid but not paired with this client id. That
is a provisioning error, not an expiry, so retrying and re-prompting for a token both
waste the user's time: report it as "This token is not authorized for client
`<id>`" and stop.

## 7. Alert delivery

### 7.1 Connection lifecycle

- `activationEvents: ["onStartupFinished"]` — do not block startup.
- On activate: resolve client id and token → `GetClientInfo` to validate both and read
  `min_client_version` → restore persisted alerts into the view (§7.4) →
  `ListPendingAlerts` to reconcile with the server → open the event stream.
- The stream request carries `Authorization: Bearer`, plus `client_id` and `last_sequence`
  as query parameters. The Go handler must `Flush()` after every message, and any proxy
  in front needs `X-Accel-Buffering: no` and no response compression, or events arrive in
  clumps instead of promptly.
- The server sends a `Heartbeat` event every 25s. If the client sees no bytes for 60s it
  tears down the socket and reconnects — a half-open TCP connection is otherwise
  invisible.
- Reconnect backoff: 1s, 2s, 4s … capped at 60s, with ±20% jitter so a server restart does
  not produce a thundering herd. Reset on any successfully received event.
- After 5 consecutive stream failures, fall back to long-poll
  (`ListPendingAlerts` with `wait_seconds=30`) and retry the stream every 5 minutes.
- **The polling fallback needs a floor between requests.** `ListPendingAlerts` returns
  immediately whenever anything is already outstanding, so a client that re-polls as soon
  as the previous call returns spins as fast as the network allows for as long as the user
  leaves an alert unanswered. Phase 4 found this the moment a test left an alert sitting.
  The client waits at least 5s after any poll that came back with alerts; an empty poll
  already blocked for its full `wait_seconds` and re-polls straight away.

**Implementation note:** the client consumes `fetch(...).body` and splits the NDJSON
stream on newlines, unwrapping each line's `result` field (§5.1). That is a handful of
lines and fully unit-testable. Note that the browser `EventSource` API would not have
worked here regardless — it cannot set an `Authorization` header — so hand-rolling the
reader was always going to be necessary.

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

### 7.2a Coalescing is a time window, not a batch

The earlier draft decided individual-versus-summary per batch of arriving alerts, which
worked while polling returned alerts in groups. Over the stream each alert is its own
event, so six arriving together produced three individual notifications and then
summaries — the exact stacking the rule exists to prevent. Phase 5 found this the moment
the stream replaced polling.

Fresh alerts are therefore collected for a short window (300ms) before anything is shown,
and the individual-or-summary decision is made once over that window. Two things fall out
of it:

- The window is the same code path for both sources, so polling and streaming announce
  identically.
- An alert that is withdrawn inside the window is dropped from the announcement rather
  than announced and immediately removed. Replay after a reconnect makes that sequence
  ordinary, not exotic.

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
  in one click without opening anything. VS Code menus are static, so the item's
  `contextValue` carries the button count (`acmeAlert:1` / `acmeAlert:2`) and the second
  action's `when` clause keys off it — a one-button alert must not show a phantom second
  action.
- Answered alerts stay in a collapsed "Recent" node for the session, dimmed with the
  chosen response in the item description.

This also fixes the ghost-notification problem from §9.3 in the direction that matters: a
duplicate notification in another window cannot be closed, but the *view* in every window
reflects true state on the next event.

### 7.4 Lifetime, revocation, and persistence

**An alert has no client-side expiry.** It stays outstanding until the user answers it or
the server withdraws it. Two things follow:

- **Alerts are persisted** in `globalState` — id, contents, sequence, and whether a
  notification has already been shown — and restored into the alerts view on activation.
  An alert that arrives while VS Code is closed, or that the user never got round to
  answering, is still there tomorrow.
- **On restart, persisted alerts are not re-notified individually.** They repopulate the
  view and the badge; a single "N alerts awaiting your response" notification appears if
  any are outstanding. Replaying six-day-old notifications at every window open is how
  users learn to click things away without reading them.

`ListPendingAlerts` on activation, and on every stream (re)connect, is the reconciliation
step: the server is authoritative about what is still live, so anything persisted locally
but absent from that response was answered or revoked while we were away, and is dropped.

**Reconciliation must only ever run against that complete list.** A stream event is one
thing that happened, not a statement about what is outstanding; treating a single-alert
event as authoritative silently discards every other pending alert. Phase 5 shipped that
bug for exactly as long as it took the end-to-end tests to run.

**Revocation** arrives as an `AlertRevoked` event. The alert is removed from the view and
the badge decrements. If its notification is still on screen it cannot be closed
programmatically (§7.2), so the stale notification remains — clicking it posts a response
that the server rejects with `FAILED_PRECONDITION`, and the client shows "This alert is no
longer active" rather than an error. The view, not the notification, is the honest record.

## 8. The machine configuration form

The form edits a live machine and the backend applies changes directly, with no approval
step in between. That single fact drives most of what follows: a mis-click here
reconfigures somebody's machine, so the design spends more effort on confirming intent and
on not clobbering concurrent changes than it does on rendering five inputs.

### 8.1 Primary surface: a WebviewView in the sidebar

Registered with `vscode.window.registerWebviewViewProvider('acmeAlerts.machine', provider,
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
  - webview → extension: `{ type: 'apply', spec }`, `{ type: 'draft', spec }`,
    `{ type: 'discard' }`, `{ type: 'refresh' }`
  - extension → webview: `{ type: 'init', config, draft, state }`,
    `{ type: 'busy', value }`, `{ type: 'result', ok, error?, fieldErrors? }`,
    `{ type: 'configChanged', config }`

### 8.2 The fields

Declared once in `form/fields.ts` as a typed const; the renderer, the client-side
validator and the request body all derive from that single declaration. Even in a
hardcoded design this is what keeps a later server-driven schema a contained change rather
than a rewrite.

| Field | Control | Range | Notes |
|---|---|---|---|
| GPU Type | `<select>` | options from `GetMachineConfig` | Options are dynamic; the field itself is not |
| Number of GPUs | slider + readout | 1–`maxCount` (≤8) | Hidden when GPU Type is `none` |
| CPU cores | slider + text box | 1–256 | |
| RAM (GB) | slider + text box | 1–2048 | |
| SSD (GB) | slider + text box | 1–2048 | |

Three control choices worth justifying:

- **The numeric fields pair a slider with a text box, bound to the same value.** Neither
  alone is sufficient. A linear 1–2048 slider in a ~300px sidebar is roughly seven values
  per pixel, so it cannot land on an exact number; a bare text box makes exploring the
  range tedious. The slider reaches a shape quickly, the box says exactly 300 rather
  than 256.
- **Over a wide range the slider steps through a curated scale**, not every integer:
  powers of two plus their halfway points above 16, always including both bounds — about
  twenty positions for 1–2048, rendered as tick marks. Any integer is still accepted
  through the text box, so this constrains the *slider* without constraining the *value*.
  A typed value that is off-scale parks the handle at the nearest position and is left
  alone.
- **GPU count is a slider with a readout and no text box.** At most eight discrete values
  fit a slider exactly, so a box would add nothing — and the slider makes an out-of-range
  count unrepresentable rather than merely rejected, which is what the earlier dropdown
  was for.
- **The text boxes are `type="text"` with `inputmode="numeric"`, not `type="number"`.**
  `type="number"` has two properties that hurt here: its `.value` is the empty string when
  the user types something unparseable, so we cannot echo back what they actually typed;
  and its scroll-wheel behaviour silently changes the value when a user scrolls the
  sidebar with the cursor over the field. Reading raw text and validating it ourselves
  avoids both.

The slider commits on release rather than on every pixel, so validation and the
Apply/No-changes state do not flicker through a drag. Typing updates the Apply button
directly rather than through a re-render, since rebuilding the inputs would take the
caret away mid-keystroke.

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

### 8.4 Loading the config: catalogue, current values, and failure

`GetMachineConfig` returns everything the form needs in one call — the GPU catalogue, the
machine's **current configuration**, the numeric bounds, and any change already in flight.
One call rather than four, so the form cannot render half-configured.

**The form is the machine's current state, presented for editing.** That shapes the UI:

- Fields are pre-filled from `current`. A user who wants one more GPU changes one dropdown
  instead of retyping five values they must first go and look up.
- **Apply is disabled until something differs** from `current`, with the button reading
  "No changes" in that state. Applying a configuration identical to the running one is
  never what anyone meant, and here it would cost a reboot for nothing.
- Changed fields carry a modified marker, and the view title bar gets a **"Discard
  changes"** action. The user can always see exactly what they are about to change.
- A machine with **no current configuration** (`current` absent) gets an empty form, with
  Apply enabled as soon as it validates.
- If `current.gpu_type_id` is no longer in the catalogue, the field renders empty with
  "Your current GPU type is no longer offered", rather than silently pre-selecting
  something else. Note that in this state *any* apply necessarily changes the GPU, so the
  confirmation dialog (§8.7) says so explicitly — the preview will report the restart.

**Bounds come from `limits` when present**, falling back to the documented 1–256 cores,
1–2048 GB RAM, 1–2048 GB SSD, 1–8 GPUs. Three lines of fallback buys the ability to change
a bound without shipping a .vsix to everyone, which matters more than usual here (Phase 9).

Caching and failure:

- **Cached** in `globalState` with its `version`. On open the form renders from cache
  **immediately** and revalidates in the background; a changed `version` swaps the config
  in place, preserving the user's edits where the fields still exist.
- **Refreshed** on activation, on the view becoming visible when the cache is older than
  15 minutes, on an explicit refresh button, on every `MachineConfigChanged` event, and
  after any `ABORTED` or `INVALID_ARGUMENT` naming `spec.gpu_type_id`.
- **Cold start with no cache and a failed fetch** → explicit error state ("Couldn't load
  configuration") with Retry, Submit disabled. Not an empty dropdown, and not a form
  someone fills in before discovering it cannot be sent.
- **Stale cache with a failed refresh** → the form stays usable with a quiet notice that
  it may be out of date. Degraded beats blocked; the server validates on submit anyway.
  Note the *current values* may also be stale in this state, so the notice is not
  cosmetic: it is the difference between the user thinking they are editing their machine
  and knowing they might not be. Apply stays enabled — `expected_version` makes a stale
  apply fail safely (§8.9) rather than silently doing the wrong thing.

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

### 8.7 Confirming intent

Apply reconfigures a live machine with no approval step behind it, so the button is not
the point of no return — the confirmation is. And the confirmation is only worth having if
it states the *real* consequences, which the extension cannot work out for itself: a
restart is required by some changes and not others, and only the server knows which.

So Apply runs `PreviewMachineConfig` first, then shows a **modal dialog** built from the
result:

```
Apply these changes to your machine?

  GPU        NVIDIA A100 40GB x2  ->  NVIDIA H100 80GB x4   requires a restart
  CPU cores  32                   ->  64
  RAM        256 GB               ->  512 GB
  SSD        1024 GB                  (unchanged)

This will restart your machine. Running jobs will be terminated.
You can cancel within 30 seconds of starting.

                            [ Apply changes ]  [ Cancel ]
```

- **The restart notice is attributed to the field that causes it.** `ChangeEffect` carries
  a `field_path` and `requires_restart` per changed field, so the dialog says *the GPU
  swap* forces the reboot rather than warning about the change as an undifferentiated
  whole. A user who learns their disk increase is free will make different choices.
- **When nothing requires a restart, the warning is absent** and the dialog is a plain
  summary. Warning about a reboot that will not happen is how warnings stop being read.
- **Preview doubles as pre-flight validation.** The server checks the spec before anything
  destructive happens, so the user never confirms a change that is then rejected. This is
  also where a future cross-field limit surfaces — at preview time, next to the field, not
  after the commit.
- **The cancellation window is stated up front** (`cancellation_window_seconds`), because
  "you have 30 seconds to change your mind" is information people want *before* deciding,
  not after.
- **If preview fails, no dialog is shown.** A confirmation that cannot state its
  consequences is worse than none; the user gets a retryable error instead.
- **The dialog is not suppressible.** No "don't ask again". Destructive, infrequent, one
  extra click.
- Cancel returns to the form with edits intact. Cancelling is not discarding.

### 8.8 Applying, cancelling, and failing

`ApplyMachineConfig` returns as soon as the change is *accepted*, not when it is finished.

1. Validate in the extension → POST with `idempotency_key` and `expected_version`.
2. The response carries a `MachineChange` with status `APPLYING`. The form goes
   **read-only** with an "Applying changes…" state; the view shows the same, so progress
   is visible without opening the form.
3. Completion arrives as a **`MachineConfigChanged` event on the stream**, not by polling.
   The form refreshes, returns to editable, and a notification reports the outcome.
4. If the stream is down, fall back to polling `GetMachineConfig` every 15s while a change
   is pending, stopping when `pending_change` clears.

**The cancellation window.** `MachineChange.cancellable_until` is a deadline, so the
applying state shows a **Cancel button with a live countdown** — "Cancel (23s)" — which
disables itself when the deadline passes. Two details:

- The countdown is rendered against the server's clock, not the user's: the client tracks
  the offset from `ApplyMachineConfigResponse.server_time` and from heartbeats. A user
  whose laptop clock is four minutes fast would otherwise see the button vanish
  immediately.
- **The client's countdown is advisory.** The server decides whether a cancel arrived in
  time, so a click near the boundary can still lose the race. That returns
  `FAILED_PRECONDITION`, and the right response is "Too late to cancel — the change is
  being applied", staying in the applying state. It is a normal outcome, not an error.

**Failure and cancellation are the same thing to the machine.** The server reverts, so the
machine is on its previous configuration either way — there is no partial state to
represent, which removes an entire category of UI ("your machine may be in an inconsistent
state") that would otherwise be needed. The client says so plainly:

- Failed → "Couldn't apply changes. Your machine is unchanged." plus `failure_reason`.
- Cancelled → "Changes cancelled. Your machine is unchanged."

In both cases the user's edits stay in the form so they can adjust and try again, and the
refreshed `current` will match what they started from.

On `INVALID_ARGUMENT` (400), map the `google.rpc.BadRequest` field violations back onto the
specific inputs by their proto paths (`spec.ram_gb` → the RAM field). Since preview
validates first, reaching this on apply means something changed in between — refresh and
show what.

**A failed apply does not go in the outbox** — see §9.1, the one place where durable retry
is the wrong answer.

### 8.9 Concurrent changes

The form can sit open for an hour. In that time the machine may be reconfigured from
another window, another device, or by an administrator. Applying a form built from stale
data would silently revert that change.

`expected_version` prevents it: the client echoes back the `version` its form was rendered
from, and the server rejects a mismatch with `ABORTED` (409). The client refetches, shows
**what changed underneath** — "Your machine was changed elsewhere: RAM 256 → 512 GB" — and
leaves the user's edits in place so they can decide whether they still want them.
Re-applying is a deliberate second action, never automatic.

`MachineConfigChanged` events make this rare in practice: a change from another window
updates this one's form live, and an unedited form simply follows along. The precondition
catches the case where the event never arrived — which is exactly the case where guessing
would be worst.

### 8.10 "Open in Editor"

A button in the view title bar reopens the same form as a full-width `WebviewPanel` in the
editor area. The two hosts share one HTML generator, one message handler and one draft —
only the shell differs. With five short fields the sidebar is genuinely adequate, so this
is a convenience rather than a necessity; it is cheap enough to keep, and it is the escape
hatch if field count grows.

## 9. Reliability

### 9.1 Outbox

**Alert responses** are user intent that must not evaporate because the network blipped,
so they go through a durable queue in `globalState`:

- Each entry: `{ id, kind, url, body, idempotencyKey, attempts, nextAttemptAt }`.
- Flushed on: successful send of anything else, stream reconnect, extension activation, and a
  60s timer while non-empty.
- Bounded at 100 entries and 7 days; older entries are dropped with a log line.
- Because every entry carries an idempotency key, replaying after an ambiguous failure is
  safe.

**Config applies deliberately do not use it.** Replaying a machine reconfiguration minutes
later, once the network returns and the user has moved on, is what nobody wants: they may
have changed their mind, closed the laptop, or had somebody else adjust the machine
meanwhile. A failed apply fails visibly, the edits stay in the form, and retrying is a
fresh deliberate action with a fresh confirmation. Durability is right for recording an
answer and wrong for triggering a reboot.

### 9.2 Duplicate delivery

The stream is at-least-once — a reconnect with `last_sequence` can legitimately
re-deliver.
The client keeps a bounded set of the last ~200 seen alert IDs (in `globalState`, with
timestamps, pruned at 7 days) and drops repeats before showing anything.

### 9.3 Multiple windows

Every open VS Code window is a separate extension host, so N windows means N streaming
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
so the event stream would originate there — which may not have network access to the
alert server. Set `"extensionKind": ["ui", "workspace"]` to prefer the local side, and
test one remote scenario before release.

## 10. Build plan

Each phase is independently demoable. Phases 3–5 assume the mock server from Phase 3.

| # | Phase | Deliverable | Done when |
|---|---|---|---|
| 0 | Contract | This document + an OpenAPI file agreed with the backend team | Both sides sign off on §5 |
| 1 | Skeleton | `yo code` scaffold, TS strict, ESLint, `onStartupFinished` activation, Activity Bar container + icon, placeholder views, output channel, settings contributed | F5 opens a dev host; the Activity Bar icon appears and opens a sidebar with both views |
| 2 | Config & auth | `ConfigService` with the three-source resolution, SecretStorage migration, Sign In command, redacting logger | Unit tests cover all three sources + precedence + 401 invalidation |
| 3 | Contract + client + mock | `buf generate` wired up (Go stubs, gateway, OpenAPI, TS types); `ApiClient` over the generated types; a small **Go** mock implementing the service behind the real gateway, with a CLI to push and revoke alerts | `buf lint` and `buf breaking` pass in CI; `GetClientInfo` succeeds against the mock; every gRPC code maps to the documented client behaviour |
| 4 | Alerts via polling | `AlertService`: catch-up poll, notification with 1–2 buttons, response POST, dedupe set; `AlertTreeProvider` with inline action buttons, badge and welcome states | Push an alert from the mock CLI → it appears in both the notification and the view, badge increments, answering either way records once |
| 5 | Event stream | `EventStream`: NDJSON reader + `result` unwrap, heartbeat timeout, jittered backoff, `last_sequence` resume, long-poll fallback | Kill the mock mid-stream → client reconnects and receives alerts queued during the outage with no gap and no duplicate |
| 6 | Machine form | `WebviewView` in the sidebar, the five fields, config fetch + cache + error states, pre-fill from current, conditional GPU count, strict validation, "Open in Editor" | Open from the Activity Bar → current config is pre-filled → Apply is disabled until something differs; `none` omits `gpuCount`; toggling to `none` and back restores the count; `1e3` and `12abc` are rejected; cold start with the mock down shows Retry, not an empty dropdown; collapsing the view preserves the draft |
| 6b | Applying | Preview-driven confirmation dialog, `APPLYING` read-only state, cancel countdown with clock-skew correction, completion via `MachineConfigChanged`, poll fallback, `expected_version` conflict handling | Apply → preview runs → dialog attributes the restart to the field causing it, and omits the warning entirely for a restart-free change → Cancel keeps edits → confirm → form locks with a live countdown → cancel inside the window reverts and says the machine is unchanged → cancel after it shows "too late", not an error → mock completes → form unlocks with new current values; a change from a second window updates the first live; a stale-version apply shows what changed instead of clobbering it |
| 7 | Reliability | Outbox for alert responses, alert persistence + revocation, draft persistence, burst coalescing | Answer an alert with the mock stopped → restart → the answer arrives exactly once; an apply that fails offline is **not** replayed later; alerts survive a window reload without re-notifying; revoking an alert removes it from the view; 10 alerts at once produce one notification and 10 view entries |
| 8 | Tests | Unit (parser, backoff, token resolution, outbox, validation) + `@vscode/test-electron` integration (commands registered, view container resolves, webview view renders) + manual matrix incl. a narrow sidebar and high-contrast theme | CI green on Linux/macOS/Windows |
| 9 | Packaging & version skew | `vsce package`, README with install instructions, CHANGELOG, icon; `min_client_version` check with an actionable "update your .vsix" prompt | A `.vsix` installs cleanly on a machine that never had the dev setup; a deliberately old build shows the update prompt instead of failing obscurely |
| 10 | Ops | Structured logs and a "Report Issue" command that dumps redacted diagnostics to the clipboard. **No telemetry** — the extension reports nothing beyond the six RPCs | Support can diagnose a user issue from one pasted log |

Rough sizing: phases 1–4 are the first useful milestone. Phase 5 is the one that always
takes longer than estimated, because reconnect edge cases only appear under real network
conditions.

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Activity Bar slot is intrusive for low-frequency users | Users hide the container and stop seeing alerts | Notifications remain the primary alert channel and work with the container hidden (§3.5) |
| Sidebar too narrow for comfortable typing | Users avoid the form | Five short fields fit; fluid single-column layout plus "Open in Editor" (§8.10) |
| `WebviewView` torn down when hidden | Lost input, reported as a data-loss bug | Draft persistence on every change, tested explicitly in Phase 6 (§8.5) |
| Corporate proxy buffers the chunked stream | Alerts arrive minutes late or never | Per-message `Flush()`, `X-Accel-Buffering: no`, no compression; long-poll fallback; test behind the real proxy in Phase 5 |
| Token in `settings.json` leaks via Settings Sync or a commit | Credential exposure | Application-scoped setting, SecretStorage migration, redacting logger (§6.2) |
| Notification bursts | Users miss alerts | Coalescing into one notification + the alerts view and its badge (§7.3) |
| Duplicate alerts across windows | Ghost notifications | Dedupe + `409` handling (§9.3) |
| Hardcoded fields change | New release + user updates for every field tweak | Single `fields.ts` declaration keeps the later schema migration contained (§8.2) |
| GPU list unreachable on a cold start | Form is unusable, not merely degraded | Cached list + explicit error state with Retry instead of an empty dropdown (§8.4) |
| Lenient numeric parsing | Silently provisioning the wrong resources | Strict integer parser, no `parseInt`; server validates independently (§8.6) |
| GPU type retired between render and apply | Machine reconfigured onto a dead type | `expected_version` on apply, violation on `spec.gpu_type_id` → refresh + clear selection, never substitute (§8.4) |
| Accidental apply reconfigures a live machine | Lost running jobs, unplanned reboot | Preview-driven, non-suppressible confirmation naming which edit forces the restart, plus the cancellation window (§8.7, §8.8) |
| Client guesses whether a change restarts | Users warned wrongly, or not at all | Only the server decides; no dialog is shown if preview fails (§8.7) |
| Clock skew hides or fakes the cancel window | Cancel button unusable on a machine with a wrong clock | Countdown rendered against tracked server time; client countdown is advisory (§8.8) |
| Stale form reverts somebody else's change | Silent regression nobody notices | `expected_version` precondition → `ABORTED`, show what changed, never auto-reapply (§8.9) |
| Offline apply replayed later from a queue | Machine reboots long after the user moved on | Applies are excluded from the outbox by design (§9.1) |
| Remote dev has no route to the server | Extension silently dead | `extensionKind` + one remote test (§9.4) |
| `.vsix` never auto-updates | Old clients stay in the field indefinitely | `min_client_version` from `GetClientInfo` + `buf breaking` in CI; additive proto changes only (Phase 9) |
| Client-id file missing or unprovisioned | Extension appears to do nothing at all | Explicit `viewsWelcome` naming the searched path; never self-generate an id (§6.0) |
| Token valid but not paired with the client id | Silent cross-client alert delivery | Server must enforce the pairing and return `PERMISSION_DENIED` (§6.0) |

## 12. Settled, and what remains

Every question this document opened with is answered and folded into the design above:

| Question | Answer | Where it landed |
|---|---|---|
| Form fields | GPU type + count, CPU, RAM, SSD | §5 proto, §8.2 |
| RAM/SSD granularity | Any integer in range | §8.2 |
| Defaults | The machine's current configuration, from the backend | §8.4 |
| Cross-field limits | None for now, may change | §8.8 — arrives as field violations, no client change needed |
| Alert lifetime | Persist until answered; server may revoke | §7.4, `AlertRevoked` |
| Routing | Client-id file on the machine | §6.0 |
| Distribution | `.vsix` passed around | Phase 9, `min_client_version` |
| Multiple submissions | One at a time | §8.1, enforced by `pending_change` |
| Telemetry | None | Phase 10 |
| What the form is | **Change my machine**, applied directly | §8 throughout |

Two assumptions remain, both cheap for the backend to overturn:

1. **`max_count` is per GPU type**, defaulting to 8 when omitted. If the limit really is a
   flat 1–8 across every accelerator, drop the field and nothing else changes.
2. **The `none` option is server-supplied** with the reserved id `none`, so the backend
   words its label. The client synthesises it if absent, but logs a warning.

Everything the "applied directly" answer raised is now answered too:

| Question | Answer | Where it landed |
|---|---|---|
| Does applying always restart? | No — depends on the change | `PreviewMachineConfig`, §8.7 |
| Can an apply be cancelled? | Yes, briefly after it starts | `CancelMachineChange`, `cancellable_until`, §8.8 |
| What happens on failure? | Full revert to the old config | `ChangeStatus`, §8.8 |

Nothing is currently blocking. The next decision is when to start building, and Phase 1
depends on none of the above.
