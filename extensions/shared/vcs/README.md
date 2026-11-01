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

Every parent-side repository write must use the configured backend. Callers
outside `shared/vcs/` use three parts of the `VcsBackend` contract: `preflight`
and `currentRef` (land and PR Autopilot), managed-worktree removal (PR
Autopilot cleanup; Git and Graphite only), and `prMutation()`, the PR mutation workflow in
`mutation.ts`. The remaining primitives exist for that workflow. PR Autopilot's
fixer child receives an inspection-only backend policy from `policy.ts`; the
parent records and publishes its edits. Do not mix mutations from different
backends in the same workspace.

`preflightVcs` enforces the selected backend before a workflow mutates the
repository. Git mode refuses a workspace whose root contains `.jj`. The jj
implementation requires jj 0.44 or newer, a configured `user.name` and
`user.email`, and a Git-backed repository verified by `jj workspace root` and
`jj git root`. Colocated, non-colocated, and secondary jj workspaces are
accepted. The workspace root does not have to contain `.git` or match the
backing Git directory.

## Workstream semantics

`worktree-plan.ts` owns read-only managed-worktree allocation for the
`git-worktrees` skill: base-ref resolution and collision-safe
`kstack/<task-slug>` paths. `worktree-inventory.ts` owns decoding Git's
porcelain worktree listing. Cleanup, rebase scope, and the skill inspector
consume that inventory and keep their own safety decisions. `git-status.ts`
owns decoding Git's porcelain status records. Git and Graphite path lists,
backend context checks, and the skill inspector consume those records.

Managed-worktree removal refuses a path outside the managed root, an
unregistered, locked, or dirty worktree, and a worktree whose branch moved.
Git then deletes the branch with `git branch -d`; Graphite uses `gt delete`.
jj has no managed worktrees.

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
Callers reach it through `backend.prMutation()`; the primitives it sequences
are typed as `WorkstreamPrimitives` and are not part of `VcsBackend`.

A jj fix is recorded by squashing the fixer's working-copy paths into the
bookmarked parent, then pushing that bookmark. A conflicted jj base merge
returns a structured human-required result and abandons the temporary merge
change. K-Stack does not auto-resolve competing intent.
