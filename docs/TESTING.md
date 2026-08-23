# Testing

Three layers, in increasing cost and decreasing coverage.

## Unit (`npm test`)

Plain Node, no VS Code. Covers everything under `src/core/` plus
`src/api/errors.ts`, `src/log.ts` and `src/manifest.test.ts`. These are the
rules the rest of the extension is built from: credential resolution, alert
bookkeeping, NDJSON framing, backoff, form validation, the slider scale, the
confirmation text, clock skew, the outbox and version comparison.

`src/manifest.test.ts` checks the half of an extension the compiler never sees —
menu commands that exist, `viewsWelcome` links that resolve, `when` clauses
naming states the code can set, and the declared icon and webview assets being
present. This is why `npm run check` builds *before* it tests.

## Against the mock (`npm test`, `src/api/client.mocksrv.test.ts`)

Still plain Node, but starts the real Go mock behind a real grpc-gateway. These
caught the wire-format assumptions a hand-written fetch stub would have agreed
with: the `{"result": …}` stream envelope, `uint64` arriving as a JSON string,
and absent-versus-zero for optional fields. Skips cleanly when Go is absent.

## In a real VS Code (`npm run test:integration`)

`@vscode/test-cli` launches an extension host and runs `src/test/*.itest.ts`.
Downloads VS Code on first run, so it needs network access to
`update.code.visualstudio.com`.

Everything is real except two surfaces a test cannot click, which are injected
instead: the notification (`Notifier`) and the confirmation modal (`Confirmer`).

## What automation does not cover

These need a person, and are worth walking before a release.

| Check | Why automation misses it |
| --- | --- |
| The form renders correctly at a narrow sidebar width | No way to assert on a webview's layout |
| Sliders drag, snap to the scale, and show tick marks | Cannot drive input events inside a webview |
| Light, dark and high-contrast themes | Colours come from VS Code variables at render time |
| A real notification appears, with its buttons in the right order | The notifier is injected in tests |
| The confirmation modal is readable and its diff lines up | The confirmer is injected in tests |
| The cancel countdown ticks visibly and stops at zero | Timing inside a webview |
| The Activity Bar badge shows the right count | Badge state is not readable from the API |
| Keyboard-only operation of the form | No accessibility harness here |

A quick pass: run `make mock`, install the `.vsix`, push an alert, answer it
from both the notification and the view, then change a value and apply it with
`--apply-delay=20s` so the applying state and countdown are visible.

## Known gaps

- The five `*.itest.ts` files each carry their own copies of `MemoryMemento`,
  `memorySecretStorage`, `waitForServer` and the alert helpers. Worth extracting
  into a shared fixture module; left as is rather than refactoring five working
  suites late in the build.
- The webview script has no unit tests of its own. Its logic lives in
  `src/core/machineForm.ts`, which is heavily covered; what remains in
  `src/webview/form.ts` is DOM assembly.
