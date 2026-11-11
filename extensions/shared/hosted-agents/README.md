# Hosted agents

This directory hosts watchable, steerable Pi agents in terminal multiplexer panes on either Herdr or Rex. The council skill, Arena, and Swarm share the host. The council skill opens its seats through `council-host.ts` and asks them through the same request lifecycle. Short headless work uses `../child-agent-runner.ts`.

The modules use Node APIs and injected effects. Only `state-reporter.ts` imports Pi extension types, as an env-gated lifecycle hook registered from `kstack.ts`. The skill CLI loads the modules through Node's TypeScript stripping.

## Modules

| Module | Purpose |
| --- | --- |
| `terminal-backend.ts` | `TerminalBackend` port, normalized status/error and exec types, and `selectTerminalBackend(env)`. |
| `backends.ts` | Backend construction, and `connectTerminal`, which preflights once and returns a `TerminalSession` (backend plus the caller's live pane and tab). |
| `node-exec.ts` | Bounded `execFile` runner shared by both CLI gateways; reports abort, timeout, missing binary, and overflow as typed failures. |
| `clock.ts` | Injectable time source for polling and retry delays. |
| `herdr/herdr-cli.ts` | Bounded, validated JSON gateway over the `herdr` CLI; maps Herdr errors onto port error codes. |
| `herdr/herdr-backend.ts` | Herdr adapter over the gateway. |
| `rex/rex-cli.ts` | Bounded, validated gateway over the `rex` CLI; maps Rex exit codes onto port error codes. |
| `rex/rex-backend.ts` | Rex adapter over the gateway and sidecar state files. |
| `agent-state.ts` | Sidecar state-file schema (`version: 1`) and atomic reader/writer. |
| `state-reporter.ts` | Env-gated Pi extension hook that writes the sidecar on `session_start`, `agent_start`, and `session_tree`. |
| `agent-spec.ts` | `HostedAgentSpec`, the hosted Pi argv, and agent-name rules. |
| `agent-host.ts` | Pane allocation, startup, and host disposal. |
| `hosted-agent.ts` | One agent's request lifecycle: ask, resume, cancellation, and disposal; `attachHostedAgent`. |
| `response.ts` | Validates a request-tagged terminal response from Pi's session JSONL. |
| `session-usage.ts` | Incremental usage accounting for one request. |
| `layout.ts` | Grid pane-placement decisions (`keepFraction` ratios). |
| `fanout.ts` | Bounded start-and-ask lifecycles with ordered results. |
| `council-host.ts` | Council seat placement, backend and tab binding, start reconciliation, seat asker, and closing seat panes. |
| `cli.mjs` | Skill-facing `preflight`, `fanout`, and `council` commands. |

Model resolution lives in `../resolve-model.ts`. The council's ledger, wire protocol, and round engine live in `../council/` and take the seat asker as an injected effect.

## Backend selection and preflight

Kstack selects the multiplexer from environment variables alone and refuses if both Herdr and Rex are present:

- `HERDR_ENV=1` selects Herdr. Preflight then requires `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts` (`herdr integration install pi`), and a reachable Herdr server. It reads the caller's live tab from `herdr pane layout`, because `HERDR_TAB_ID` goes stale after `herdr pane move`.
- `REX_SESSION` or `REX_BLOCK` selects Rex. Preflight then requires both variables, a reachable Rex server at API revision 12 or newer (`rex whoami --json`), a live caller block exposing `program_status`, and a `pi` record in the caller block's `program_status` proving that this Pi build emits OSC 7501.
- If both or neither are set, selection refuses before spawning `herdr` or `rex`.

Skills run `node <kstack>/extensions/shared/hosted-agents/cli.mjs preflight` before doing work.

## Host contract

`openAgentHost` creates one unfocused tab (a Rex window) in the caller's session or workspace. Pane allocation is serialized, while startup and prompting may run concurrently. Each pane uses its assigned agent cwd. If the first agent's cwd differs from the tab cwd, the host allocates another pane rather than reusing the root shell. A new pane may not have reached its shell prompt when startup begins; the host retries `pane_busy` up to three times, one second apart. It does not retry blocked or ambiguous launches. Startup failures consume their reserved pane. The host validates the agent's reported cwd at startup and before each new request, and refuses a new request while the agent is working on a human turn. It never focuses, splits, or closes the caller's pane.

Use `openAgentHost` when Kstack creates and owns the agents in a new tab, and `openPaneHost` when the agents should share the caller's tab as panes split off the caller's own pane. `openPaneHost` accepts a fixed `direction` for that split and `maxColumns` for the agent grid inside it; councils use `right` and one column, so seats stack to the right of the caller. `layout.ts` expresses splits as `keepFraction` (the source pane's share); the Herdr adapter passes it directly as `--ratio`, while the Rex adapter converts it to `--ratio round((1 - keepFraction) * 100)` (clamped to `1..99`) and maps `down` to `below`. A `HostedAgentSpec.exactName` uses that agent name verbatim: no random suffix, and a name conflict fails instead of retrying. Every failed `start` reports the pane it reserved and the name it tried, when known.

Use `attachHostedAgent` only for an existing agent in a user- or skill-owned pane. It takes the agent's `AgentRef` (name, pane, and sidecar path on Rex) and a connected `TerminalSession`, and attaches the request lifecycle without creating a tab or repeating preflight. For these attached agents, cancellation sends Escape (`esc` on Herdr, `escape` on Rex) and never sends Ctrl+C or closes the pane. `attachHostedAgent` refuses the caller's pane.

### Identity, status, and Rex limitations

- **Herdr** owns a global unique agent-name registry (`[a-z][a-z0-9_-]{0,31}`), starts Pi via `herdr agent start`, and reports the session path through `herdr-agent-state.ts`.
- **Rex** has no agent registry: block labels are display-only and not unique. Kstack launches Pi from a `0700` shell script in the pane, sets `KSTACK_HOSTED_AGENT_STATE`, and verifies identity by matching the sidecar `pid` against both the OSC 7501 `program_status` `owner.pid` and the block's live process tree. Exact-name conflict checks scan live `pi` blocks by label on a best-effort basis; council manifests and sidecars remain authoritative.
- **Status and settlement**: Herdr distinguishes `idle` (seen) from `done` (unseen). Pi's OSC 7501 reports `idle` at startup and after abort, `working` during runs and compaction, `blocked` during dialogs, and `done` or `error` when a run finishes. Rex has no seen/unseen distinction and polls `program_status` against a nanosecond RFC 3339 baseline (`250 ms` backing off to `1 s`). `idle`, `done`, and `error` all count as settled; `error` flows into `collectAnswer`, which fails closed when `stopReason !== "stop"`.
- **Unverified identity**: Missing or malformed sidecars, PID mismatches, and live processes without Pi identity evidence return `identity_unverified`, not `not_found`. Council open, round attachment, and close refuse rather than replace or close an unverifiable seat. Inspect the recorded pane and restore its sidecar before retrying. Missing blocks and shell panes without a Pi status record remain eligible for stale-seat recovery.
- **Error mapping**: Rex exit codes are authoritative: `3` is `not_found`, `4` is `unavailable`, and `2` is `protocol_error`. Message text refines only exit `1`, and never yields `not_found`, because `not_found` authorizes stale-seat recovery. Name scans skip blocks that vanish mid-scan but fail on any other probe error.
- **Unknown states**: Unrecognized Rex status values remain `unknown`; they do not count as settled, even after the status timestamp advances.
- **Stall retry on Rex**: If no `working` transition or timestamp advance arrives within 5 seconds of a prompt, the adapter reports `prompt_stalled`. On retry, it checks `rex capture` first and sends only `enter` when the pointer text is already in Pi's editor (ignoring editor line wrapping), avoiding duplicate input.

Hosted Pi processes load `kstack.ts` explicitly, plus `backend.extraPiArgs()` (Herdr's `-e herdr-agent-state.ts`; none on Rex). Extension discovery defaults to off (`--no-extensions`). `inheritExtensions: true` enables normal Pi discovery; `tools` independently controls any tool allowlist. Discovery resolves user configuration and trusted project resources from the child's cwd; parent-only `-e` paths, process-only trust approval, runtime tool registrations, and active tool selections are not forwarded.

Read-only fanout tasks receive the shared read-only system prompt automatically; workspace tasks do not. This is an instruction, not a sandbox. Cancellation is forwarded into startup, and a cancelled startup closes its allocated pane even if readiness fails. Sessions persist in Pi's normal session directory and remain available through `/resume` and session-archive.

## Request and response contract

An agent owns at most one pending request. The request stores its UUID, files, options, delivery state, session identity, usage cursor, and cancellation listener. A blocked return retains that request; `resume()` accepts no replacement files.

A short pointer prompt tells Pi to read the instructions file, then return its complete answer in its final reply with a first-line `KSTACK_RESPONSE <request UUID>` marker. The host accepts the reply only after the backend settles and Pi's terminal persisted assistant message has `stopReason: "stop"` and the matching marker. Provider errors, interrupted turns, missing acknowledgements, and incomplete session entries fail closed. Screen text and nonempty answer files are not completion evidence.

The host saves the validated response at the caller's output path, creating missing parent directories. Read-only agents need no `write` or `bash` capability. If a prompt is rejected before delivery with `agent_blocked`, `resume()` waits for the dialog to resolve and sends the stored request once. If the prompt was already delivered, `resume()` only waits. A session switch or cwd change during a pending request fails closed.

## Cancellation and retention

Cancellation stays connected across blocked returns and takes precedence over completion. Cancellation and timeout for host-owned agents drain through Escape, then both Ctrl+C presses in one call (`herdr agent send-keys` or `rex send-key`), then pane close if the preceding steps do not settle. Attached agents receive Escape only. On Rex, `sendKeys` and `closePane` also refuse the caller's own block ID directly.

Disposal cancels pending work. Idle panes and tabs are retained unless `closePane` or `closeTab` is requested. An owned exchange directory is removed when no request is outstanding. The CLI handles SIGINT and SIGTERM, stops scheduling queued tasks, drains active requests, and writes ordered partial fanout outcomes.

## Bounds and security

- At most 8 agents per host; fanout concurrency 1–8, default 4.
- Pointer prompt at most 512 bytes; instruction text stays in a protected file.
- Output cap defaults to 256 KiB and may be set from 1 byte to 4 MiB. Truncation is marked.
- Response reads use at most the final 32 MiB of session appends.
- Ask and resume wait timeout: 1–60 minutes. Startup timeout: 3–300 seconds.
- Exchange directories and council seat directories use mode 0700; instruction, output, and sidecar files use 0600.

These controls are not a sandbox. Writable agents have the user's permissions. Fanout canonicalizes writable cwds and rejects overlapping directories and directories inside, equal to, or containing the repository root.

## CLI

```sh
node <kstack>/extensions/shared/hosted-agents/cli.mjs preflight
node <kstack>/extensions/shared/hosted-agents/cli.mjs fanout --spec spec.json --out result.json [--label TEXT] [--max-concurrency N]
node <kstack>/extensions/shared/hosted-agents/cli.mjs council open --dir DIR --slug SLUG --planner-model REF [--seats REF,REF]
node <kstack>/extensions/shared/hosted-agents/cli.mjs council round --dir DIR --plan FILE [--task FILE] [--response FILE] [--verify]
node <kstack>/extensions/shared/hosted-agents/cli.mjs council override --dir DIR --finding ID --reason TEXT [--plan FILE]
node <kstack>/extensions/shared/hosted-agents/cli.mjs council close --dir DIR
```

`council open` records `terminal` (`"herdr"` or `"rex"`), `tabId`, and per-seat `paneId` in `manifest.json` (legacy manifests without `terminal` read as `"herdr"`). Each seat's sidecar lives at `seats/<letter>.json` in the council directory. `open`, `round`, and `close` refuse if run under the other backend or from another tab. Seat checks are the same on both backends: a seat with a recorded pane is verified in that pane, and any other agent holding the seat name is refused as foreign.

## Verification

```sh
node --test "extensions/shared/hosted-agents/**/*.test.*"
```

Tests cover both gateways and adapters, the shared host-lifecycle contract suite run identically against scripted Herdr and Rex backends (Rex tests share the stateful fake in `rex/test-helpers.ts`), council cross-backend binding and reconciliation, real CLI signal handling, and read-only response collection. They make no provider calls.

The opt-in live smoke makes one billable provider request and closes its disposable tab/window in `finally`:

```sh
# Inside Rex (uses $REX_SESSION and $REX_BLOCK):
node extensions/shared/hosted-agents/scripts/agent-host-e2e.ts --backend rex <provider/model[:thinking]>

# Against the isolated kstack-e2e Herdr session:
KSTACK_E2E_WORKSPACE_ID=<isolated-workspace> \
KSTACK_E2E_PANE_ID=<isolated-pane> \
node extensions/shared/hosted-agents/scripts/agent-host-e2e.ts --backend herdr <provider/model[:thinking]>
```
