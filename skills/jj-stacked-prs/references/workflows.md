# Workflows

Exact, current `jj 0.44` procedures for the workflows in [../SKILL.md](../SKILL.md). Every command here is the full canonical form — no personal aliases. Replace `<remote>` with the GitHub remote name (usually `origin`); `<top>` with the topmost bookmark in the stack; `<trunk>` with `trunk()` unless the repo needs otherwise.

Run the inspection helper before and after any history-changing step:

```bash
python3 <skill-dir>/scripts/inspect_stack.py --top <top>
```

Publishing uses the bundled two-phase publisher. `plan` is read-only; `apply` executes the confirmed plan:

```bash
# Read-only preview
python3 <skill-dir>/scripts/publish_stack.py plan --repo <path> --top <top> --remote <remote>

# Apply with the plan ID from the preview output
python3 <skill-dir>/scripts/publish_stack.py apply --repo <path> --top <top> --remote <remote> --plan-id <id>
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

Leave an empty working-copy change above the top bookmark when practical — it keeps the next slice ready without disturbing the stack:

```bash
jj new     # new empty change above the top bookmark
```

Validate: `inspect_stack.py --top profile-edit` shows a linear base → top with one bookmark per PR boundary and no blockers.

### Defer bookmark placement (split after the fact)

You don't have to decide PR boundaries up front. A common jj strategy is to do
the work as a chain of changes first — rewriting history as you go — and only
place bookmarks to define PR boundaries once you're near a stopping point and
can see the natural seams. This often produces better boundaries than deciding
before you understand the problem.

```bash
jj new trunk() -m "wip: explore auth"   # ... work, jj new, jj edit, jj edit ...
# later: carve PR boundaries out of the finished chain
jj bookmark create auth      --revision <change-at-the-auth-seam>
jj bookmark create profile   --revision <change-at-the-profile-seam>
jj bookmark create profile-edit --revision @
```

Use `jj split --interactive` to break a too-large change at a seam before
placing its bookmark. The inspection helper reports whichever bookmarks exist;
it does not care whether you placed them as you went or after the fact.

## 2. Reshape: split or reorder

Insert a new change **before** the current one (descendants auto-rebase):

```bash
jj new -B @ -m "prep: extract helper"      # --insert-before
```

Split the current change into two interactively:

```bash
jj split --interactive
```

Reorder or move a change and its descendants onto a different parent:

```bash
jj rebase -s <change-id> -o <dest-change-or-bookmark>
```

After reshaping, reinspect. If a bookmark ended up on the wrong change, move it:

```bash
jj bookmark move <name> --revision <change-or-bookmark> --allow-backwards
```

## 3. Edit a change in the middle

`jj edit` moves the working copy to that change; all descendants auto-rebase. Use the change ID (stable across rebases), not the commit ID:

```bash
jj edit <change-id>
# ... edit files ...
jj status
```

To return to the top afterward:

```bash
jj edit <top-bookmark>     # or: jj new to start a fresh empty change above
```

## 4. Absorb a cross-stack fix

When a reviewer's fix touches code owned by several earlier changes, make the edits in the working copy, then route each hunk to the commit that last touched those lines:

```bash
# edit files in the working copy ...
jj absorb
```

`jj absorb` only targets mutable ancestors of `@` by default. To restrict to the current stack, scope it:

```bash
jj absorb --into 'trunk()..<top>'
```

If `jj absorb` is ambiguous about a destination, the hunk stays in `@`; finish it manually with `jj split` or by editing the intended change.

## 5. Synchronize only the selected stack with trunk

Fetch, then rebase the **selected** stack (not every bookmark) onto the latest trunk. `-b` rebases the whole branch relative to destination's ancestors:

```bash
jj git fetch --remote <remote>
jj rebase -b <top> -o 'trunk()'
```

Conflicts are recorded inside commits and jj keeps going — do **not** assume a clean tree. Afterward:

```bash
inspect_stack.py --top <top>
```

Address any `(conflict)` entries (see [safety-and-recovery.md](safety-and-recovery.md)).

## 6. Publish or update the stack through the bundled publisher

The bundled `publish_stack.py` infers the bookmark stack from `<top>` down to trunk, pushes bookmarks, creates/updates PRs, sets each PR's base to the bookmark below it, and posts navigation comments. Always preview first:

```bash
python3 <skill-dir>/scripts/publish_stack.py plan --repo <path> --top <top> --remote <remote>
```

Show the user the plan and get explicit approval, then apply using the plan ID from the plan output:

```bash
python3 <skill-dir>/scripts/publish_stack.py apply --repo <path> --top <top> --remote <remote> --plan-id <plan_id>
```

The publisher uses each change's first description line as the provisional PR title. If a title is wrong, fix the description first:

```bash
jj describe -r <change-id> -m "feat: correct title"
```

then re-plan and re-apply. The publisher updates existing PRs (including their base) rather than recreating them and creates missing PRs as drafts.

## 7. Process review feedback on a middle PR

Jump to the change the reviewer commented on (by change ID), edit, and absorb if the fix spans multiple changes:

```bash
jj edit <change-id>
# ... address feedback ...
jj absorb
inspect_stack.py --top <top>
python3 <skill-dir>/scripts/publish_stack.py plan --repo <path> --top <top> --remote <remote>   # preview, then confirm and apply
```

## 8. Advance the stack after the bottom PR merges

Only after you have **verified** the bottom PR merged on GitHub. Do not abandon based on assumption.

While the bottom bookmark still exists locally (before `jj git fetch` deletes it), abandon the merged segment. The `-` suffix on the end of the revset excludes the next bookmark's commit — `x..y` is inclusive of `y`, so `trunk()..<next-bookmark>` would also abandon the unmerged next PR:

```bash
jj abandon 'trunk()..<next-bookmark>-'    # the segment that was the merged PR, excluding the next bookmark
```

Then fetch the updated trunk and rebase the remainder:

```bash
jj git fetch --remote <remote>
jj rebase -b <top> -o 'trunk()'
inspect_stack.py --top <top>
python3 <skill-dir>/scripts/publish_stack.py plan --repo <path> --top <top> --remote <remote>   # repairs PR bases; preview, then confirm and apply
```

If the remote branch was deleted on merge, the local bookmark is forgotten after fetch; that's expected.

## Choosing the remote

If there's exactly one GitHub remote, use it. If there are several, ask the user; don't guess. Confirm the remote is GitHub with:

```bash
git remote -v
```

The publisher will reject a non-GitHub remote itself, but surface the choice to the user first.