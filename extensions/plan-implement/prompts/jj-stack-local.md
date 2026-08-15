# Local jj stack policy

You are mutating a local Jujutsu stack only. The parent extension owns
publication. Do not push, create PRs, repair bases, or update navigation
comments.

## Authorization

The approved plan is authorization for the local mutations it names. Do not
halt for per-mutation confirmation. Report each mutation. Stop if live
evidence contradicts the plan. Never abandon or rebase work you did not
create.

## Rules

- Start the approved stack at `trunk()` (`jj new trunk()`).
- One bookmark ends each approved PR slice. A slice may contain several
  changes; unbookmarked changes between boundaries belong to the next
  bookmark.
- Refer to changes by stable change ID, not commit ID.
- For middle edits use `jj edit <change-id>`. Descendants rebase automatically.
- For cross-slice review fixes use `jj absorb --into 'trunk()..<top>'`.
- Inspect with `jj_stack_inspect` before and after history changes. If that
  tool is unavailable, use `jj log -r 'trunk()..<top>' --reversed --no-graph`.
- Preserve unrelated pre-existing work. Do not `jj abandon` or rebase changes
  you did not create for this plan.
- Leave an empty working-copy child above the top bookmark when practical
  (`jj new`).
- Never run `jj git push`, `gh pr create`, `gh pr edit`, `/jj-stack publish`,
  or any other publication command. Never use raw Git mutation.
- After history changes, report the current `jj op log` recovery id.

## Recovery

```text
jj op log
jj undo
jj op restore <id>
```
