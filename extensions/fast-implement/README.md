# fast-implement

`/fast-implement [--worktree] [--change-kind <kind>] [--] <task>` runs one confirmed implementation child for a small, explicit repository change. It names unnamed sessions, creates a local `kstack/<task-slug>` workstream (or a retained managed worktree), passes discovered skills/context plus shared proof obligations to the child, requires a new commit and a clean tree, and reports retained partial state on failure.

Fast mode trades independent planning and panel review for latency. It still requires repository inspection, focused verification, and coherent local commits. It supports only single-PR local workstreams: it never pushes, publishes, creates PRs, lands changes, retries automatically, or falls back to `plan-implement`.

## Configuration

An optional `$PI_CODING_AGENT_DIR/kstack.json` section selects one authenticated child-compatible model:

```json
{"fast-implement":{"implementer":{"model":"openai/gpt-5.6-sol","thinking":"low"},"timeoutMinutes":30}}
```

Because fast mode has no independent planner or reviewer, the implementer is validated against a bounded allowlist of model/thinking pairs: `openai/gpt-5.6-sol:low`, `openrouter/x-ai/grok-4.6:high`, and `anthropic/claude-opus-5:medium`. `thinking` may be omitted; when present it must match the pinned level for that model. The timeout is 1–60 minutes. Missing configuration falls back to the first authenticated model from the same allowlist, in order. Children run with extensions, prompt templates, and session persistence disabled; skills and context files remain enabled. This is process isolation, not a sandbox: child agents retain the user's OS permissions.

Press `Ctrl+Shift+A` to abort the child. Abort, timeout, model/config failures, worktree races, failed commits, and failed verification preserve the branch/worktree for manual inspection rather than deleting partial work. Development checks: `node --test extensions/fast-implement/*.test.ts` and `npm run typecheck`.
