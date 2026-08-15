# fast-implement

`/fast-implement [--worktree] [--change-kind <kind>] [--] <task>` runs one
confirmed implementation child for a small, explicit repository change. It
names unnamed sessions, creates a local `kstack/<task-slug>` workstream, passes
discovered skills and context plus shared proof obligations to the child, and
reports retained partial state on failure.

Fast mode trades independent planning and panel review for latency. It still
requires repository inspection, focused verification, and coherent local
changes. It supports only single-PR workstreams. It never pushes, publishes,
creates PRs, lands changes, retries automatically, or falls back to
`plan-implement`.

## VCS backends

The shared `vcs.backend` setting in `$PI_CODING_AGENT_DIR/kstack.json` selects
the mutation model:

- `"git"` creates a clean local branch. `--worktree` creates and retains a
  managed linked worktree.
- `"jj"` creates a `trunk()`-based change and task bookmark in the current
  colocated jj/Git workspace. The child records verified changes with jj and
  leaves an empty working-copy change. `--worktree` is rejected before the
  confirmation.

The extension runs the selected backend's preflight before confirmation and
injects matching VCS guidance into the child. Git mode refuses jj-managed
workspaces; jj mode requires jj 0.44 or newer, a configured identity, and a
colocated workspace.

## Model configuration

An optional `$PI_CODING_AGENT_DIR/kstack.json` section selects one
authenticated child-compatible model:

```json
{"fast-implement":{"implementer":{"model":"openai/gpt-5.6-sol","thinking":"low"},"timeoutMinutes":30}}
```

Because fast mode has no independent planner or reviewer, the implementer is
validated against a bounded allowlist of model/thinking pairs:
`openai/gpt-5.6-sol:low`, `openrouter/x-ai/grok-4.6:high`, and
`anthropic/claude-opus-5:medium`. `thinking` may be omitted; when present it
must match the pinned level for that model. The timeout is 1–60 minutes.
Missing configuration falls back to the first authenticated model from the
same allowlist, in order.

Children run with extensions, prompt templates, and session persistence
disabled; skills and context files remain enabled. This is process isolation,
not a sandbox: child agents retain the user's OS permissions.

Press `Ctrl+Shift+A` to abort the child. Abort, timeout, model/config failures,
workstream races, failed commits or jj changes, and failed verification preserve
the branch, bookmark, or worktree for manual inspection.

Development checks:

```bash
node --test extensions/fast-implement/*.test.ts
npm run typecheck
```
