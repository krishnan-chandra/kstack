# Shared extension modules

`extensions/shared/` contains contracts used by more than one Kstack extension. Keep extension-specific policy in the owning extension; move code here only after multiple callers share the same invariant.

| Module | Purpose |
| --- | --- |
| `change-kind.ts` | Defines the change-kind taxonomy, labels, and proof-obligation playbook names. |
| `child-agent-runner.ts` | Runs bounded Pi child processes, builds the shared isolation-arg prefix, persists native sessions, and parses their JSONL event streams. |
| `child-process-stop.ts` | Coordinates bounded process-group termination, SIGTERM/SIGKILL escalation, and absence observation for cancelled child processes. |
| `subagent-sessions.ts` | Owns native child-session identity, active leases, file resolution, and retention. |
| `concurrency.ts` | Maps an item list with a bounded worker pool and preserves input order. |
| `config-validate.ts` | Checks finite numbers against shared inclusive bounds. |
| `git-exec.ts` | Defines the injected command-runner contract, normalizes bounded command failures and diagnostics, and adapts `pi.exec` for VCS modules. |
| `github.ts` | Provides the single bounded, validated `gh` gateway for repository and PR reads, publication, merges, and merge verification. |
| `herdr/` | Hosts long-lived Pi agents in Herdr panes: the herdr CLI gateway, the one-tab agent host with a file-based ask protocol, session-JSONL usage, pure pane layout, fan-out, and the skill-facing `cli.mjs`. See [`herdr/README.md`](herdr/README.md). |
| `subagent-console.ts` | Renders the full-screen read-only subagent console (sidebar + transcript) used by live dashboards. |
| `live-dashboard.ts` | Stores and renders shared live-dashboard state with extension-specific copy and display policy. |
| `terminal-text.ts` | Sanitizes and width-bounds untrusted terminal text, with fallbacks for tests outside the Pi host. |
| `kstack-config.ts` | Locates `kstack.json`, loads and validates sections, and defines common model and thinking predicates. |
| `model-availability.ts` | Checks whether a child process can reproduce an authenticated model. |
| `model-spec.ts` | Validates, splits, and formats configured model references. |
| `narrow.ts` | Narrows untrusted JSON and event payloads to records. |
| `pi-json-lines.ts` | Parses and bounds Pi JSONL output. |
| `prompt-assets.ts` | Reads bundled prompt and playbook Markdown assets. |
| `publication-lock.ts` | Serializes stack publication and landing mutations per repository across VCS backends. |
| `repository-identity.ts` | Resolves a worktree-independent Git common-directory identity for publication locks, floor telemetry, and PR Autopilot state. |
| `request-channel.ts` | Implements synchronous claim-once invocation between loaded extensions. |
| `session-lifecycle.ts` | Provides generation-counted session and abortable-run lifecycle guards. |
| `session-name.ts` | Derives and assigns workflow session names. |
| `slug.ts` | Extracts the short keyword slug used for session names, branches, and worktree paths. |
| `transcript-store.ts` | Stores bounded ephemeral child transcripts for live dashboards and inspectors. |
| `vcs/` | Owns the Git and jj mutation contract. See [`vcs/README.md`](vcs/README.md) for backend contracts, config/factory, Git and jj implementations, the shared worktree planner, preflight, and child guidance. |
| `stack/` | Owns the cross-provider stacked-PR contract, provider channels, and stack-topology store. See [`stack/README.md`](stack/README.md) for outcomes, provider mapping, topology, blocker codes, and the `ref` noun. |
| `playbooks/` | Stores shared engineering principles and change-kind proof obligations. |

## Cross-extension imports

Extension code may import a sibling extension only through its `api.ts` or
`types.ts`. Request-channel APIs remain optional when a peer extension is not
loaded; deep implementation imports create an unconditional module dependency.
`scripts/check-imports/index.mjs` enforces this rule. Shared modules may not import extension
modules.

The gate has one narrow exception: `handoff` imports the `session-archive`
files, operations, store, JSONL parser, and output bounds needed to archive a
source session and read its history.

Treat this exception as dependency debt. Add a public `api.ts` or `types.ts`
contract instead of extending the exception list.

## Subagent sessions

Every child launched through `runChildAgent` writes a native Pi session to the flat Kstack-managed directory `~/.pi/kstack/subagents/`. `getSubagentSessionsRoot()` is the shared path contract for writers and readers. Active leases prevent pruning while children run. Inactive sessions, including failed and aborted runs, are pruned oldest-first to a global cap of 500 files.

The normal `/resume` list does not search this directory. The session-archive extension provides `search_subagent_history` and `read_subagent_history` for retained inactive sessions. Its reader uses the shared non-mutating lease classifier, so discovery never deletes stale leases or changes retention. Tool results validate source identity and can expire when retention removes the JSONL file.

## Child process lifecycle and termination

`runChildAgent` manages isolated child processes with bounded lifecycle guards:

- **POSIX process groups**: On POSIX (`process.platform !== "win32"`), children spawn detached to lead their own process group. Stopping or cancellation signals the negative process group ID (`-groupId`), ensuring direct children and descendants sharing the group receive `SIGTERM` and `SIGKILL`.
- **Bounded escalation**: Stopping sends `SIGTERM`, polls for group absence up to `killGraceMs`, and escalates to `SIGKILL` if processes survive. A bounded post-escalation observation window verifies absence (`ESRCH`) before concluding. If the group remains active after post-escalation observation or encounters signaling errors (such as `EPERM`), the runner returns an actionable failed result preserving the original stop reason rather than hanging or claiming successful cancellation.
- **Direct-child vs. group settlement**: Direct-child close selects the process result (aborted, timed out, protocol error, or exit status), but final session finalization and promise resolution wait for process-group stop completion. A prompt exit by the direct child cannot cancel required escalation for surviving descendants.
- **Absence observation**: Group absence is detected via injected process signaling (`kill(0)`). Once absence is observed, cleanup finishes immediately, pending timers are cancelled, and the group ID is never signaled again. Normal successful runs and non-stop errors settle immediately without grace-period delays.
- **Windows fallback**: On Windows (`win32`) or for processes without a group PID, termination falls back to signaling the direct child process directly (`child.kill()`). This does not guarantee recursive process-tree termination on Windows without external job objects.
- **Process group boundary limits**: Cleanup targets the owned process group. Descendants that deliberately detach or create their own new process group (e.g. via `setsid` or `setpgid`) escape the runner's owned process group boundary and cannot be tracked.

## Environment variables

Set `KSTACK_CHILD_DEBUG_CAP_BYTES` to a positive integer to raise child process output and stderr buffer limits during debugging.
