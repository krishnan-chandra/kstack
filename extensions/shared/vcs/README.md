# Shared VCS backends

This module owns K-Stack's repository mutation boundary. Extension adapters
select one configured backend and inject it into workflow code. Domain modules
do not read `kstack.json` themselves.

## Command boundary

Read-only Git plumbing remains valid for both backends in a colocated jj
workspace. Callers may use commands such as `git diff`, `git log`, and
`git rev-parse` when those commands do not change the working copy, index, or
refs.

Every repository write must use `VcsBackend`. This includes creating a branch or
bookmark, committing, restoring paths, merging, pushing, and creating or
removing isolation. Do not mix raw Git mutations with jj mutations in the same
workspace.

`preflightVcs` enforces the selected backend before a workflow mutates the
repository. Git mode refuses a workspace whose root contains `.jj`. The jj
implementation requires jj 0.44 or newer, a configured `user.name` and
`user.email`, and a colocated Git and jj workspace so that GitHub and read-only
Git inspection continue to address the same repository.

## Workstream semantics

The Git backend creates a clean `kstack/<task-slug>` branch and can create a
managed linked worktree. The jj backend creates a `trunk()`-based change with a
collision-safe `kstack/<task-slug>` bookmark. A completed jj workstream keeps
the bookmark on an ancestor of the current change, contains at least one
non-empty change above its checkpoint, and leaves an empty working-copy change.
Git worktree isolation is unavailable in jj mode.

Path-scoped commit and restore operations, fetch, push, remote-head integration,
and base merges have backend-native implementations. A conflicted jj merge is
reported as a structured human-required result and the temporary merge change
is abandoned; K-Stack does not auto-resolve competing intent.
