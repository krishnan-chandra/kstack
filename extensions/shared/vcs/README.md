# Shared VCS backends

This module owns K-Stack's repository mutation boundary. Extension adapters
select one configured backend and inject it into workflow code. Domain modules
do not read `kstack.json` themselves.

## Command boundary

Read-only Git plumbing is permitted, but jj workspaces need not be Git CLI
worktrees. Prefer jj commands for workspace state and remote discovery. When
Git object access is needed, resolve `jj git root` and pass its result with
`git --git-dir=<path>`. Git's index and working tree are not the secondary
jj workspace. Before a standalone GitHub workflow starts, the shared repository
resolver selects explicit `owner/name` coordinates. Git and Graphite use GitHub
CLI discovery from their Git worktree. jj reads the GitHub `origin` with
`jj git remote list`. A missing, duplicate, malformed, or non-GitHub `origin`
blocks the workflow. GitHub callers scope PR and run commands with those
coordinates rather than assume that `gh` can discover the repository from cwd.

Every parent-side repository write must use the configured backend. The shared
`VcsBackend` contract covers branches and bookmarks, commits, path restoration,
merges, and pushes. Git and Graphite expose managed-worktree isolation; jj does
not. Delegated implementation children receive an explicit backend policy and
may invoke only that backend's CLI. Do not mix mutations from different
backends in the same workspace.

`preflightVcs` enforces the selected backend before a workflow mutates the
repository. Git mode refuses a workspace whose root contains `.jj`. The jj
implementation requires jj 0.44 or newer, a configured `user.name` and
`user.email`, and a Git-backed repository verified by `jj workspace root` and
`jj git root`. Colocated, non-colocated, and secondary jj workspaces are
accepted. The workspace root does not have to contain `.git` or match the
backing Git directory.

## Workstream semantics

`worktree-plan.ts` owns read-only managed-worktree allocation: base-ref
resolution and collision-safe `kstack/<task-slug>` paths. Git and Graphite
delegate planning to it and still return only the `IsolationPlan`.
`worktree-inventory.ts` owns decoding Git's porcelain worktree listing.
Cleanup, rebase scope, and the skill inspector consume that inventory and
keep their own safety decisions. `git-status.ts` owns decoding Git's
porcelain status records. Git and Graphite path lists, panel-review context
checks, and the skill inspector consume those records.

The Git backend creates a clean `kstack/<task-slug>` branch and can create a
managed linked worktree. Graphite uses that Git isolation seam, then tracks and
mutates the branch through native `gt` commands. The jj backend creates a
`trunk()`-based change with a collision-safe `kstack/<task-slug>` bookmark. A
completed jj workstream keeps the bookmark on an ancestor of the current
change, contains at least one non-empty change above its checkpoint, and leaves
an empty working-copy change. Git worktree isolation is unavailable in jj mode.

Graphite publication and landing resolve `git rev-parse --git-common-dir` and
lock its canonical path. All linked worktrees for one repository therefore
share a single mutation lock. jj stack publication and native landing first
resolve `jj git root`, then query the common Git directory with an explicit
`--git-dir`. Primary and secondary jj workspaces therefore share that lock too.

Path-scoped commit and restore operations, fetch, push, and base merges have
backend-native implementations. PR Autopilot fetches the remote PR head without
merging it before a fixer runs. It stops if GitHub's head changed. After the
fixer returns, Git mode requires the same branch and commit. jj mode requires
the same bookmark, stable change ID, and parent commits, which permits normal
snapshot changes but rejects a moved or replaced workstream.

## PR mutation workflow

`mutation.ts` validates that a checkout matches a PR head, proves the backend's
rewrite scope, and owns fix and base-update publication. It checks rewrite scope
again after any operation that can rewrite refs and before publication.
PR Autopilot uses this workflow instead of sequencing mutation primitives.
Callers outside `shared/vcs/` must not call `rewriteScope` directly.

Before a jj push, the backend describes an otherwise-undescribed empty `@` as
an automation checkpoint and moves the task bookmark to it. Implementation and
fix commits remain in ancestors while later automation gets a clean change to
edit. A conflicted jj base merge returns a structured human-required result and
abandons the temporary merge change. K-Stack does not auto-resolve competing
intent.
