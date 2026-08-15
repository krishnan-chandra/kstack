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
implementation requires a colocated Git and jj workspace so that GitHub and
read-only Git inspection continue to address the same repository.
