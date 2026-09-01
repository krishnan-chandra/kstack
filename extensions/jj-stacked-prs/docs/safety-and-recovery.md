# Safety and recovery

## Operation log and undo

```bash
jj op log
jj op show <op-id>
jj undo
jj op restore <op-id>
```

If a rebase, absorb, or abandon goes wrong, `jj undo` is almost always the
first recovery step. Capture the operation id from `jj op log` for a targeted
`jj op restore`. Sync and advance report that id.

## Conflicts

jj records conflicts inside commits and continues. Resolve with
`jj resolve` or `jj resolve -r <change-id>`. Do not abandon a conflicted
change merely because it looks like generated or CI text. Inspect the diff
and ancestry first.

When a conflict lives in a lower change that several PRs sit on, fix it in
that lowest change. jj auto-rebases every descendant.

## Divergent changes

Divergent changes share a change ID across multiple commits, usually from
mixing `git` and `jj`. Inspection flags them as a blocker. Avoid `git commit`
and `git rebase` in colocated repos.

## Colocated Git caveats

Do all history mutation through `jj`. Avoid `git commit`, `git rebase`,
`git reset --hard`, and force-push. Read-only `git`/`gh` is fine.

## Session working state must live in ignored paths

jj snapshots every non-ignored file into the working-copy commit. Put scratch
files in an ignored location (`local/` in this repository).

## Git hooks

`jj` operations do not run Git hooks. Run linters manually on changed files
when the repo relies on pre-commit.

## Immutable commits

Do not add `--ignore-immutable` by default. Use it only on a specific
inspected revision after explicit approval.

## PR metadata generation

Before any remote mutation, publication collects each new PR's exact slice diff
and generates deterministic metadata from the slice subject, commit
descriptions, and changed paths. Repositories with one default pull-request
template keep that template's headings, comments, and checklist items.
Repositories without a template receive a `## Summary` and `## Review guide`.
Metadata generation does not call a model, so model authentication and provider
failures cannot block publication.

After publication creates a draft, the outcome instructs the calling agent to
rewrite the new title and body with `write-pr` and the user's `my-voice` profile.
This follow-up produces human-readable, thematic prose without putting a model
call inside the structural publication transaction. Existing PR metadata is not
regenerated or replaced during structural publication.

## Partial `/jj-stack publish` failures

After metadata is ready, publication pushes bookmarks and creates or updates PRs
in stack order. If it fails partway:

- Some bookmarks may be pushed and some PRs created while others are not.
- Re-run `/jj-stack plan` to see the residual plan. The publisher updates
  existing PRs rather than recreating them.
- Do not manually force-push to finish it.
- `partial` means an earlier mutation completed before a later step failed.
  Publication lists completed actions and the failed action. Sync and advance
  include the recovery operation ID.
- `completed` can still include `commentErrors`. Core publication succeeded;
  navigation comments did not. Re-run `/jj-stack publish` after fixing `gh`.
- `indeterminate` means a mutator started and remote acceptance cannot be
  disproved. Inspect GitHub and local bookmarks before retrying. A created PR
  whose number cannot be re-read is indeterminate, not a clean failure. The
  same rule applies when a newly created comment's ID cannot be read.

## Deleted remote bookmarks

After a PR merges and the remote branch is deleted, `jj git fetch` forgets
the corresponding local bookmark. Advance abandons the merged segment
**before** fetching. If you already fetched and lost the bookmark, rebase the
remainder by change ID or by the next surviving bookmark.

## Missing `gh` or auth

`/jj-stack plan` and `/jj-stack publish` require an authenticated `gh`. Local
inspect, sync, and stack editing do not. The extension never installs `gh` or
performs GitHub authentication.

## What never happens automatically

- No `--ignore-immutable` without explicit, scoped approval.
- No publication without either command confirmation or an explicit user request
  that authorizes `jj_stack_publish`. Both paths require a fresh plan-ID match.
- No stack landing without either command confirmation or an explicit user
  request that authorizes `jj_stack_land`. Land still revalidates each PR and
  pins `--match-head-commit`.
- No `jj abandon` while stack inspection reports a blocker.
- No advance past a `partially-landed` frontier.
- No direct `git rebase` / `git reset` / force-push in colocated repos.
- No installing of `gh`, and no GitHub authentication on the user's behalf.
- No `--admin`, `--auto`, or merge commits.
- No cross-process lock. Two Pi processes can still publish or land the same stack.
