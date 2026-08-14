# Shared extension modules

`extensions/shared/` contains contracts used by more than one Kstack extension. Keep extension-specific policy in the owning extension; move code here only after multiple callers share the same invariant.

| Module | Purpose |
| --- | --- |
| `change-kind.ts` | Defines the change-kind taxonomy, labels, and proof-obligation playbook names. |
| `child-agent-runner.ts` | Runs bounded Pi child processes, builds the shared isolation-arg prefix, and parses their JSONL event streams. |
| `concurrency.ts` | Maps an item list with a bounded worker pool and preserves input order. |
| `config-validate.ts` | Checks finite numbers against shared inclusive bounds. |
| `git-exec.ts` | Defines the injected command-runner contract and adapts `pi.exec`. |
| `git-policy.ts` | Enforces current-workstream branch and committed-worktree postconditions. |
| `kstack-config.ts` | Locates `kstack.json`, loads sections, and defines common model and thinking predicates. |
| `model-availability.ts` | Checks whether a child process can reproduce an authenticated model. |
| `model-spec.ts` | Validates, splits, and formats configured model references. |
| `pi-json-lines.ts` | Parses and bounds Pi JSONL output. |
| `prompt-assets.ts` | Reads bundled prompt and playbook Markdown assets. |
| `request-channel.ts` | Implements synchronous claim-once invocation between loaded extensions. |
| `session-lifecycle.ts` | Provides generation-counted session and abortable-run lifecycle guards. |
| `session-name.ts` | Derives and assigns workflow session names. |
| `worktree.ts` | Plans and creates managed Git worktrees. |
| `playbooks/` | Stores shared engineering principles and change-kind proof obligations. |

`handoff` deliberately imports `session-archive` reader modules (`archive-files`, `session-jsonl`, `tool-output`, and `archive-store`). Handoff is a reader of the archive by design. This one-directional dependency is accepted; do not move the archive engine here.
