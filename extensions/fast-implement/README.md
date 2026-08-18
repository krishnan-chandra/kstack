# fast-implement

`/fast-implement [--worktree] [--change-kind <kind>] [--] <task>` runs one
confirmed implementation session for a small, explicit repository change. Fast
mode skips independent planning and panel review. It still requires repository
inspection, focused verification, and a coherent local commit.

The command supports one local workstream and never pushes, publishes, opens a
pull request, lands changes, retries automatically, or falls back to
`plan-implement`.

## Current-checkout mode

Without `--worktree`, the command:

1. validates the configured model and VCS backend;
2. asks for confirmation;
3. creates a local Git/Graphite branch or jj change and bookmark;
4. starts the configured implementer in the current session, preserving its plan and discussion in context; and
5. verifies the committed workstream after the implementation agent settles.

Current-checkout mode works in the active TUI or RPC session, including
`--no-session`. The extension temporarily selects the configured implementer
model and thinking level, then restores the previous selection after verified
completion when the user has not changed models during the run.

Current-checkout mode has no hard timeout or output cap. Interrupt or steer the
agent with Pi's normal controls. After each settle, the extension checks for a
new local commit. A clarifying question, interruption, or other
settle without a commit leaves the run pending; verification retries after the
next turn. The extension records completion only after verification succeeds.

## Worktree mode

With `--worktree`, the command keeps the existing isolated child-process flow.
It creates a managed Git worktree, starts an ephemeral child session there, and
reports the result in the parent session. The configured timeout and output
caps apply only to this mode.

Press `Ctrl+Shift+A` to abort the worktree child. Abort, timeout, startup,
commit, and verification failures retain the branch and worktree for manual
inspection.

Child processes disable extensions, prompt templates, and session persistence.
Skills and context files remain enabled. This is process isolation, not a
sandbox. The child keeps the user's OS permissions.

## VCS backends

The shared `vcs.backend` setting in `$PI_CODING_AGENT_DIR/kstack.json` selects
the mutation model:

- `"git"` creates a clean local branch. `--worktree` creates a managed linked
  worktree.
- `"jj"` creates a `trunk()`-based change and task bookmark in the current
  colocated jj and Git workspace. `--worktree` is not supported.
- `"graphite"` requires gt 1.8.5+, Git 2.38+, and an initialized Graphite
  repository. It creates and records branches with native `gt`; `--worktree`
  allocates Git storage and tracks the isolated branch with Graphite.

The selected backend runs its preflight before it creates a workstream. Git
and Graphite modes refuse jj-managed workspaces. jj mode requires jj 0.44 or newer, a
configured identity, and a colocated workspace.

## Model configuration

An optional `$PI_CODING_AGENT_DIR/kstack.json` section selects one authenticated
implementer:

```json
{"fast-implement":{"implementer":{"model":"openai/gpt-5.6-sol","thinking":"low"},"timeoutMinutes":30}}
```

The implementer must match one of these model and thinking-level pairs:

- `openai/gpt-5.6-sol:low`
- `openrouter/deepseek/deepseek-v4-flash:high`
- `openrouter/moonshotai/kimi-k3:medium`

You can omit `thinking`. If you set it, the value must match the pinned level
for that model. Missing configuration selects the first authenticated model in
the list. `timeoutMinutes` accepts 1 through 60 and applies only to worktree
mode.

## Argument autocomplete

Typing `/fast-implement ` in an interactive session offers completions for the
finite flags `--worktree` and `--change-kind <kind>` (one of `bug-fix`,
`feature`, `refactor`, `performance`, `prototype`, `generic`). Completion
stops once free-form task text begins; the task itself is never guessed at.

## Development

Run the focused tests and typecheck from the repository root:

```bash
node --test extensions/fast-implement/
npm run typecheck
```
