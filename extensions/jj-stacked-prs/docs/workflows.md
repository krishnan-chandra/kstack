# Workflows

Exact `jj 0.44` procedures. Every command is the full canonical form — no
personal aliases. Replace `<remote>` with the GitHub remote (usually
`origin`); `<top>` with the topmost bookmark; `<trunk>` with `trunk()` unless
the repo needs otherwise.

Inspect before and after any history-changing step:

```text
/jj-stack inspect --top <top>
```

Or, from a model: `jj_stack_inspect({ top })`.

The command path asks for confirmation. The model tool treats an explicit user
request to publish as authorization and does not ask again. Both paths recompute
the plan and refuse a stale identity before mutation:

```text
/jj-stack plan --top <top> --remote <remote>
/jj-stack publish --top <top> --remote <remote>
/jj-stack publish --top <top> --remote <remote> --ready
jj_stack_publish({ top: "<top>", remote: "<remote>" })
jj_stack_publish({ top: "<top>", remote: "<remote>", ready: true })
```

## 1. Start a stack

From a clean working copy on top of trunk:

```bash
jj new trunk() -m "feat: add auth"
jj bookmark create auth --revision @
# ... work ...
jj new -m "feat: add profile page"
jj bookmark create profile --revision @
# ... work ...
jj new -m "feat: add profile editing"
jj bookmark create profile-edit --revision @
```

Leave an empty working-copy change above the top bookmark when practical:

```bash
jj new
```

Validate: `/jj-stack inspect --top profile-edit` shows a linear base → top
with one bookmark per PR boundary and no blockers.

### Defer bookmark placement

You don't have to decide PR boundaries up front. Do the work as a chain of
changes first, then place bookmarks at the natural seams:

```bash
jj new trunk() -m "wip: explore auth"
# later:
jj bookmark create auth --revision <change-at-the-auth-seam>
jj bookmark create profile --revision <change-at-the-profile-seam>
jj bookmark create profile-edit --revision @
```

Use `jj split --interactive` to break a too-large change before placing its
bookmark.

## 2. Reshape: split or reorder

```bash
jj new -B @ -m "prep: extract helper"
jj split --interactive
jj rebase -s <change-id> -o <dest-change-or-bookmark>
jj bookmark move <name> --revision <change-or-bookmark> --allow-backwards
```

## 3. Edit a change in the middle

Use the change ID (stable across rebases), not the commit ID:

```bash
jj edit <change-id>
jj status
jj edit <top-bookmark>
```

## 4. Absorb a cross-stack fix

```bash
jj absorb --into 'trunk()..<top>'
```

If `jj absorb` is ambiguous, the hunk stays in `@`; finish it with `jj split`
or by editing the intended change.

## 5. Synchronize only the selected stack

```text
/jj-stack sync --top <top> --remote <remote>
```

That fetches the selected remote and rebases only `-b <top>` onto refreshed
`trunk()`. Conflicts are recorded inside commits — do not assume a clean tree.
Reinspect afterward.

## 6. Publish or update the stack

```text
/jj-stack publish --top <top> --remote <remote>
```

The command shows the exact plan, confirms it, recomputes state, and mutates
only when the full plan ID still matches. Missing PRs are created as drafts.
Existing title, body, and draft state are preserved. Navigation comments carry
verified merged, closed, open, and draft ancestors.

After structural publication, author titles and bodies with `write-pr` from
each slice's exact diff (`trunk()` below the bottom slice, the preceding
bookmark below later slices), then:

```bash
gh pr edit <pr-number> --title '<title>' --body-file <body-file>
```

If a metadata update fails, report a partial publication. Do not claim every
PR has a completed description.

## 7. Process review feedback on a middle PR

```bash
jj edit <change-id>
jj absorb --into 'trunk()..<top>'
```

Then `/jj-stack inspect --top <top>` and `/jj-stack publish --top <top> --remote <remote>`.

## 8. Advance after the bottom PR merges

Only after GitHub reports the PR as merged:

```text
/jj-stack advance --merged <merged-bookmark> --top <top> --remote <remote>
```

This requires a blocker-free inspection and verifies three facts: `--merged`
is the bottom slice, its local commit matches the PR head commit, and GitHub
reports that PR as `MERGED`. The command abandons `<trunk>..<merged>` **before**
fetch because fetch may forget a deleted remote bookmark. A custom `--trunk`
is used for both the abandon range and the later rebase. The command then
fetches and rebases only the remaining selected stack. It does not republish.
Inspect and run `/jj-stack publish` separately to repair remaining PR bases and
comments.

Never advance a middle bookmark while an earlier slice is still in the local
stack. Never derive the abandon boundary from the next bookmark's parent. One
PR slice may contain several unbookmarked changes.

## 9. Land a stack prefix

After the stack is published, choose the top PR or bookmark that you want to
merge through:

```text
/land --pr <top-pr-number>
/jj-stack land --top <top> --remote <remote>
jj_stack_land({ top: "<top>", remote: "<remote>" })
```

In jj mode, `/land` maps the selected PR head to the local stack and lands every
slice from trunk through that PR. Use `/jj-stack land` or `jj_stack_land` when
you need to set the remote, trunk revset, or maximum stack size explicitly.

The command confirms the ordered plan once. The model tool treats an explicit
land request as authorization. Both paths preflight the base chain and head
SHAs, then for each frontier: mark the PR ready if it is still a draft, land it
through `/land` with a minted confirmation, advance locally, verify the merge
commit is an ancestor of the refreshed trunk, republish the remainder, and
delete the merged remote branch when it still points at the landed head.
`--readiness` defaults to `watch` because each restack restarts CI. Re-run the
command after a partial stop; an already-merged bottom PR is advanced and the
loop continues.

Do not land a child PR before its base. Do not call `gh pr merge` directly.

## Choosing the remote

If there is exactly one GitHub remote, use it. If there are several, ask;
don't guess. Confirm with `git remote -v`. The extension rejects a
non-GitHub remote.
