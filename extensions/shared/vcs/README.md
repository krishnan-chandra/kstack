# Shared VCS backends

This module owns K-Stack's repository mutation boundary. Extension adapters
select one configured backend and inject it into workflow code. Domain modules
do not read `kstack.json` themselves.

## Command boundary

Read-only Git plumbing remains valid for all three backends. In jj mode this
requires a colocated workspace. Callers may use commands such as `git diff`,
`git log`, and `git rev-parse` when those commands do not change the working
copy, index, or refs.

Every parent-side repository write must use the configured backend. The shared
`VcsBackend` contract covers branches and bookmarks, commits, path restoration,
merges, and pushes. Git and Graphite expose managed-worktree isolation; jj does
not. Delegated implementation children receive an explicit backend policy and
may invoke only that backend's CLI. Do not mix mutations from different
backends in the same workspace.

`preflightVcs` enforces the selected backend before a workflow mutates the
repository. Git mode refuses a workspace whose root contains `.jj`. The jj
implementation requires jj 0.44 or newer, a configured `user.name` and
`user.email`, and a colocated Git and jj workspace so that GitHub and read-only
Git inspection continue to address the same repository.

## Workstream semantics

`worktree-plan.ts` owns read-only managed-worktree allocation: base-ref
resolution and collision-safe `kstack/<task-slug>` paths. Git and Graphite
delegate planning to it and still return only the `IsolationPlan`.

The Git backend creates a clean `kstack/<task-slug>` branch and can create a
managed linked worktree. Graphite uses that Git isolation seam, then tracks and
mutates the branch through native `gt` commands. The jj backend creates a
`trunk()`-based change with a collision-safe `kstack/<task-slug>` bookmark. A
completed jj workstream keeps the bookmark on an ancestor of the current
change, contains at least one non-empty change above its checkpoint, and leaves
an empty working-copy change. Git worktree isolation is unavailable in jj mode.

Graphite publication and landing resolve `git rev-parse --git-common-dir` and
lock its canonical path. All linked worktrees for one repository therefore
share a single mutation lock.

Path-scoped commit and restore operations, fetch, push, and base merges have
backend-native implementations. PR Autopilot fetches the remote PR head without
merging it before a fixer runs. It stops if GitHub's head changed. After the
fixer returns, Git mode requires the same branch and commit. jj mode requires
the same bookmark, stable change ID, and parent commits, which permits normal
snapshot changes but rejects a moved or replaced workstream.

Before a jj push, the backend describes an otherwise-undescribed empty `@` as
an automation checkpoint and moves the task bookmark to it. Implementation and
fix commits remain in ancestors while later automation gets a clean change to
edit. A conflicted jj base merge returns a structured human-required result and
abandons the temporary merge change. K-Stack does not auto-resolve competing
intent.
