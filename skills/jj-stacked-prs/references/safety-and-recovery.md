# Safety and recovery

## Operation log and undo

jj records every mutating operation. Use these before and after history rewrites:

```bash
jj op log            # inspect recent operations
jj op show <op-id>   # see what an operation changed (use -p for a diff)
jj undo              # undo the last history-rewriting operation
jj op restore <op-id>  # jump to any earlier repo state
```

If a rebase, absorb, or abandon goes wrong, `jj undo` is almost always the first recovery step. Capture the operation id from `jj op log` for a targeted `jj op restore`.

## Conflicts

jj records conflicts **inside** commits and continues; a conflicted change shows `(conflict)`. You are not forced to resolve immediately.

To resolve in the current change:

```bash
jj resolve            # opens the configured merge editor for conflicted files
```

To resolve a specific change:

```bash
jj resolve -r <change-id>
```

Do **not** abandon a conflicted change merely because it looks like generated/CI text. Inspect the diff and ancestry first:

```bash
jj diff -r <change-id>
jj log -r 'parents(<change-id>)' --no-graph
```

Only after confirming the conflict is generated text (e.g. a changelog or lockfile snippet) and not real code should you consider `jj abandon <change-id>`, and even then state why explicitly.

### Fix a conflict once; it propagates to every PR

When a conflict lives in a lower change that several PRs sit on top of, fix it
**in that lowest conflicted change** (`jj edit <change-id>`), not in each
affected PR. jj auto-rebases every descendant, so the resolution flows
upstack to all of them — you resolve once, not once per PR. This is the
strongest practical argument for stacked PRs in jj.

## Divergent changes

Divergent changes share a change ID across multiple commits, usually from mixing `git` and `jj` in a colocated repo. The inspection helper flags them as a blocker. Resolve by inspecting and keeping the canonical copy:

```bash
jj log -r 'divergent()' --no-graph
```

Usually the fix is to re-describe or abandon the stale copy and let jj reconcile, then reinspect. Avoid rapidly alternating `git commit` and `jj` commands; when it happens, clean up promptly.

## Colocated Git caveats

In a colocated repo jj and git share `.git`. To stay safe:

- Do all history mutation through `jj` (`jj new`, `jj edit`, `jj describe`, `jj rebase`, `jj squash`, `jj split`, `jj abandon`, `jj absorb`).
- Avoid `git commit`, `git rebase`, `git reset --hard`, and force-push. They can create divergent change IDs and confuse jj's view.
- Read-only `git`/`gh` is fine: `git remote -v`, `git log`, `gh pr view`, `gh auth status`.
- `.gitignore` is respected by jj.

## Git hooks

`jj` operations do **not** run Git hooks (pre-commit, commit-msg, etc.). Hooks only fire on direct `git` commands. If the repo relies on pre-commit for linting, run the linters manually on the changed files after editing:

```bash
jj diff -r 'trunk()..<top>' --name-only | xargs <lint-command>
```

or use the repo's pre-commit harness directly on those files. Don't assume checks ran.

## Immutable commits and `--ignore-immutable`

Once a commit is pushed, jj may mark it immutable; editing requires `--ignore-immutable`. This skill does **not** add `--ignore-immutable` by default. Use it only on a specific, inspected revision after telling the user exactly which revision will be rewritten and getting explicit approval:

```bash
jj edit --ignore-immutable <change-id>
jj describe --ignore-immutable -r <change-id> -m "..."
```

After rewriting a pushed change you must force-push the corresponding branch; the bundled publisher handles that for bookmarked changes. State this to the user.

## Partial `publish_stack.py` failures

`publish_stack.py apply` pushes bookmarks and creates/updates PRs in stack order. If it fails partway:

- Some bookmarks may be pushed and some PRs created while others are not.
- Re-run `publish_stack.py plan` to see the residual plan; the publisher updates existing PRs rather than recreating them, so re-running is idempotent.
- Do not manually force-push to "finish" it; let the publisher reconcile. If a bookmark's remote ref is missing, the publisher will push it on the next run.
- The apply output includes a `plan_id` and either `"status": "completed"` or `"status": "partial"` with a `failed_action` describing what failed. Rerun `plan` to get a fresh plan ID, then `apply` with that ID.

## Deleted remote bookmarks

After a PR merges and the remote branch is deleted, `jj git fetch` forgets the corresponding local bookmark. Abandon the merged segment **before** fetching while you still have the local bookmark (see workflow 8 in [workflows.md](workflows.md)). If you already fetched and lost the bookmark, you can still rebase the remainder by change ID or by the next surviving bookmark.

## Missing `gh` or auth

Before publishing:

```bash
gh auth status
```

If `gh` is unauthenticated and no `GITHUB_TOKEN`/`GH_TOKEN` is set, stop and tell the user to run `gh auth login` or export a token. Local stack work does not require either.

## What never happens automatically

- No `--ignore-immutable` without explicit, scoped approval.
- No `publish_stack.py apply` without a `plan` preview and confirmation.
- No `jj abandon` of a conflict without diff/ancestry inspection.
- No direct `git rebase`/`git reset`/force-push in colocated repos.
- No installing of `gh`, and no GitHub authentication on the user's behalf.