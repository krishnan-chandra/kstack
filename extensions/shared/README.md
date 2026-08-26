# Shared extension modules

`extensions/shared/` contains contracts used by more than one Kstack extension. Keep extension-specific policy in the owning extension; move code here only after multiple callers share the same invariant.

| Module | Purpose |
| --- | --- |
| `change-kind.ts` | Defines the change-kind taxonomy, labels, and proof-obligation playbook names. |
| `child-agent-runner.ts` | Runs bounded Pi child processes, builds the shared isolation-arg prefix, persists native sessions, and parses their JSONL event streams. |
| `subagent-sessions.ts` | Owns native child-session identity, active leases, file resolution, and retention. |
| `concurrency.ts` | Maps an item list with a bounded worker pool and preserves input order. |
| `config-validate.ts` | Checks finite numbers against shared inclusive bounds. |
| `git-exec.ts` | Defines the injected command-runner contract and adapts `pi.exec` for VCS modules. |
| `github.ts` | Provides the single bounded, validated `gh` gateway for repository and PR reads, publication, merges, and merge verification. |
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

Every child launched through `runChildAgent` writes a native Pi session to the flat Kstack-managed directory `~/.pi/kstack/subagents/`. Active leases prevent pruning while children are running. Completed sessions are pruned oldest-first to a global cap of 500 files.

The normal `/resume` list does not search this custom directory. Open a retained session directly with `pi --session <absolute-jsonl-path>`. The session-archive extension does not currently index this directory. References can therefore outlive their files after retention pruning.

## Environment variables

Set `KSTACK_CHILD_DEBUG_CAP_BYTES` to a positive integer to raise child process output and stderr buffer limits during debugging.
