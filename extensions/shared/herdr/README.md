# Herdr-hosted agents

`extensions/shared/herdr/` hosts long-lived, watchable, steerable Pi agents in
Herdr panes. Kstack always runs inside Herdr (`HERDR_ENV=1`); anything a human
would watch or steer — planners, adversaries, implementers, arena candidates,
swarm workers — runs as a named Pi agent in a pane. Short headless work
(classifiers, panel reviewers, investigation models) keeps using
`../child-agent-runner.ts`.

Nothing under this directory imports `@earendil-works/*`; it depends only on
`node:*`, other shared modules, and injected effects, so `cli.mjs` can import
the TypeScript modules under Node's type stripping.

## Modules

| Module | Purpose |
| --- | --- |
| `herdr-cli.ts` | Bounded, validated JSON gateway over the `herdr` binary (injected exec). The single place to update if Herdr's CLI changes. |
| `agent-host.ts` | Deep module: preflight, one-tab layout, agent start, file-based ask protocol, wait, abort, dispose. |
| `session-usage.ts` | Turns/cost from the hosted agent's Pi session JSONL (append-only tail). |
| `layout.ts` | Pure pane-placement decisions for N agents in one tab. |
| `fanout.ts` | `runFanout(spec, deps)`: N hosted agents in one tab, ordered results. |
| `cli.mjs` | Skill-facing CLI: `resolve-model`, `fanout`. |

## Contract

- **Preflight** (`preflightHerdr`): `HERDR_ENV === "1"`, `herdr status server`
  succeeds, `HERDR_WORKSPACE_ID`/`HERDR_PANE_ID` present, and
  `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts` exists (else: run
  `herdr integration install pi`). Callers run this before any model spend.
- **Layout**: `openAgentHost` creates exactly one `--no-focus` tab in the
  caller's workspace. `layout.ts` splits columns first (up to
  `ceil(sqrt(maxAgents))`, fewer in narrow tabs so panes stay ≥ 60 columns),
  then fills rows down. The caller's own pane (`HERDR_PANE_ID`) is never
  split, focused, or closed.
- **Start**: `hostedAgentArgs(spec, integrationPath)` builds
  `--no-extensions -e <kstack.ts> -e <herdr-agent-state.ts>
  --no-prompt-templates …`. No `--mode json`, no `-p`, no `--session-dir`:
  sessions land in Pi's normal directory and stay visible to `/resume` and
  session-archive. `agent_not_ready` fails with the pane id in the message
  (typically a project-trust prompt the user answers in the pane).
- **Ask protocol**: a fixed ≤ 512-byte pointer prompt crosses the terminal;
  instructions and answers cross as 0600 files in a 0700 exchange directory
  (`host.exchangeDir`), which is removed on `host.dispose()` unless an ask is
  outstanding. Error codes map to typed results: `agent_blocked` → `blocked`,
  `agent_prompt_stalled` → one retry after 2 s, timeout → `abort()` then
  `failed`. A missing output file falls back to a `DONE <path>` pointer read
  from the agent's recent terminal output, accepted only for paths under the
  exchange directory.
- **Usage**: each ask is charged the assistant messages appended to the
  agent's session JSONL during that ask (offset-tracked, malformed lines
  skipped, unreadable file → zero usage).
- **Abort**: esc → ctrl+c twice → pane close, escalating only when the
  previous step does not settle the agent. Idempotent.
- **Retention**: panes are retained by default (`dispose({closePane})` /
  `dispose({closeTab})` opt in) so the user can keep talking to the agents;
  callers print the tab id in their final notice.
- **Limits**: prompt ≤ 512 B, output cap 256 KiB default, ask timeout 1–60
  min, start timeout 3–300 s, agents per host ≤ 8.

## Ratio semantics

`pane split --ratio F` gives the source (left/top) pane the fraction F of its
current extent; verified against herdr 0.8.2. Column splits keep
`1/(columns - index + 1)`; down splits keep `1/rowsRemainingInColumn`, which
yields equal panes once the grid is full.

## CLI

```sh
node <kstack>/extensions/shared/herdr/cli.mjs resolve-model --section plan-adversary --key adversary [--model <ref>]
node <kstack>/extensions/shared/herdr/cli.mjs fanout --spec spec.json --out result.json [--label TEXT] [--max-concurrency N]
```

## E2E check

`scripts/agent-host-e2e.ts` starts one real hosted agent (`--no-tools`) in the
current Herdr session and asks it to echo a file:

```sh
node --experimental-strip-types extensions/shared/herdr/scripts/agent-host-e2e.ts
```

It uses the named Herdr session `kstack-e2e` and the Pi session name
`kstack-e2e-agent-host`. Clean up with:

```sh
herdr tab close <tab id printed by the script>
pi --session-name kstack-e2e-agent-host   # inspect, or archive via /session-archive
```
