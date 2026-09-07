# Herdr-hosted agents

This directory hosts watchable, steerable Pi agents in Herdr panes. Plan-implement, Arena, Swarm, and Simplify share the host. The standalone adversarial-planning skill attaches to its named agent through the same request lifecycle. Short headless work still uses `../child-agent-runner.ts`.

The modules use Node APIs and injected effects, with no Pi SDK runtime imports. The skill CLI loads them through Node's TypeScript stripping.

## Modules

| Module | Purpose |
| --- | --- |
| `herdr-cli.ts` | Bounded, validated gateway over the Herdr CLI. |
| `agent-host.ts` | Pane allocation, startup, pending requests, resume, cancellation, and disposal. |
| `response.ts` | Validates a request-tagged terminal response from Pi's session JSONL. |
| `session-usage.ts` | Incremental usage accounting for one request. |
| `layout.ts` | Pane-placement decisions. |
| `fanout.ts` | Bounded start-and-ask lifecycles with ordered results. |
| `cli.mjs` | Skill-facing model resolution, fanout, and asks against existing agents. |

Model resolution lives in `../resolve-model.ts`; it is independent of Herdr.

## Host contract

Preflight requires `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, a reachable Herdr server, and `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`. Install the integration with `herdr integration install pi`.

`openAgentHost` creates one no-focus tab in the caller's workspace. Pane allocation is serialized, while startup and prompting may run concurrently. Each pane uses its assigned agent cwd. If the first agent's cwd differs from the tab cwd, the host allocates another pane rather than reusing the root shell. A new pane may not have reached its shell prompt when startup begins. The host retries Herdr's pre-launch `agent_pane_busy` rejection up to three times, one second apart. It does not retry blocked or ambiguous launches. Startup failures consume their reserved pane. The host validates Herdr's reported cwd at startup and before each new request, and refuses a new request while the agent is still working on a human turn. It never focuses, splits, or closes the caller's pane.

`attachHostedAgent` attaches the request lifecycle to an existing named agent without creating a tab. It refuses the caller's pane. The caller is responsible for selecting an agent with the intended model, tools, and cwd.

Hosted Pi processes load Kstack and the Herdr integration explicitly, not the user's other extensions. Tool allowlists remain the capability boundary. Sessions persist in Pi's normal session directory and remain available through `/resume` and session-archive.

## Request and response contract

An agent owns at most one pending request. The request stores its UUID, files, options, delivery state, session identity, usage cursor, and cancellation listener. A blocked return retains that request; `resume()` accepts no replacement files.

A short pointer prompt tells Pi to read the instructions file, then return its complete answer in its final reply with a first-line `KSTACK_RESPONSE <request UUID>` marker. The host accepts the reply only after Herdr settles and Pi's terminal persisted assistant message has `stopReason: "stop"` and the matching marker. Provider errors, interrupted turns, missing acknowledgements, and incomplete session entries fail closed. Screen text and nonempty answer files are not completion evidence.

The host saves the validated response at the caller's output path, creating missing parent directories. Read-only agents need no `write` or `bash` capability. The saved artifact is exactly the returned response, including any truncation marker. There is no alternate-path fallback that can disappear during disposal. Treat output files from failed tasks as untrusted partial artifacts.

If Herdr rejects a prompt before delivery with `agent_blocked`, resume waits for the dialog to resolve and sends the stored request once. If the prompt was already delivered, resume only waits. A session switch during a pending request fails; a new request snapshots the newly selected session. Human turns between automated requests are excluded from the next request's usage. Steering during a request is part of that request's usage.

## Cancellation and retention

Cancellation stays connected across blocked returns and takes precedence over completion. Cancellation and timeout drain through Escape, then Ctrl+C twice, then pane close if the preceding steps do not settle. A settled agent in the unseen host tab reports `done` rather than `idle`; both count as settled. Abort is idempotent within one request and resets for the next request. A pane closed during escalation cannot be reused.

Disposal cancels pending work. Idle panes and tabs are retained unless `closePane` or `closeTab` is requested. An owned exchange directory is removed when no request is outstanding; a concurrent outstanding request keeps its files available. Retained panes are not permission to leave cancelled tasks running.

The CLI handles SIGINT and SIGTERM, stops scheduling queued tasks, drains active requests, and writes ordered partial fanout outcomes. A blocked task is cancelled before the CLI returns; resolve its dialog and explicitly retry if needed. SIGKILL and machine failure cannot run cleanup. If Herdr itself is unreachable during escalation, inspect the panes before assuming work stopped.

## Bounds and security

- At most 8 agents per host; fanout concurrency 1–8, default 4.
- Pointer prompt at most 512 bytes; instruction text stays in a protected file.
- Output cap defaults to 256 KiB and may be set from 1 byte to 4 MiB. Truncation is marked.
- Response reads use at most the final 32 MiB of session appends; an oversized terminal record fails rather than being accepted partially.
- Ask and resume wait timeout: 1–60 minutes. Startup timeout: 3–300 seconds.
- Exchange directories use mode 0700; instruction and output files use 0600.

These controls are not a sandbox. Writable agents have the user's permissions. Fanout canonicalizes writable cwds and rejects overlapping directories and directories inside, equal to, or containing the repository root. Repository content and model output remain untrusted data.

## CLI

```sh
node <kstack>/extensions/shared/herdr/cli.mjs resolve-model --section NAME --key NAME [--model REF]
node <kstack>/extensions/shared/herdr/cli.mjs fanout --spec spec.json --out result.json [--label TEXT] [--max-concurrency N]
node <kstack>/extensions/shared/herdr/cli.mjs ask --agent NAME --prompt instructions.md --out response.md
```

Fanout spec cwd, prompt, and output fields and `ask` prompt and output paths must be absolute; the hosted agent resolves the pointer from its own cwd. `ask` uses a 15-minute timeout and the default response cap. Both return nonzero on failure, blocking, or cancellation.

## Verification

```sh
node --test extensions/shared/herdr/
```

Tests cover scripted Herdr boundaries, real CLI signal handling, and read-only response collection using Pi's actual read tool and native session persistence. They make no hosted-agent provider calls.

The opt-in smoke makes one billable provider request. First create or attach to the named Herdr session `kstack-e2e`, and obtain workspace and pane IDs from that session. Then run:

```sh
KSTACK_E2E_WORKSPACE_ID=<isolated-workspace> \
KSTACK_E2E_PANE_ID=<isolated-pane> \
node extensions/shared/herdr/scripts/agent-host-e2e.ts <provider/model:thinking>
```

Every smoke command explicitly selects `--session kstack-e2e`. The smoke uses a temporary cwd and read-only agent, requires the exact `ECHO OK` response, exits nonzero on failure, and closes its tab in `finally`. The Pi session is named `kstack-e2e-agent-host` and remains available for inspection. The smoke does not verify a complete debate, human-edit approval, or writable-agent cancellation; those still require bounded live acceptance checks.
