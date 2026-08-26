# Kstack

Pi extensions that plan, implement, publish, and land code changes as GitHub
pull requests, including stacked PRs, across multiple version-control backends.

## Language

### Version control

**VCS backend**:
The implementation that mutates a repository's local state: git, jj, or
Graphite. Selected once per repository in configuration.
_Avoid_: VCS mode, SCM

**Workstream**:
One unit of isolated local work a backend prepares for a task: a branch,
bookmark, or Graphite branch plus its checkpoint.
_Avoid_: feature branch, checkout (for the concept)

**Trunk**:
The integration target a stack is measured against and lands into.
_Avoid_: main, master, default branch (as the concept)

**Ref**:
The backend-neutral name for a published pointer to a slice's head. jj calls
it a bookmark, Git and Graphite call it a branch; cross-provider contracts say
ref.
_Avoid_: bookmark, branch (in shared contracts)

### Stacked pull requests

**Stack**:
An ordered chain of slices from trunk to a top ref, published as a chain of
pull requests where each PR's base is its predecessor.

**Slice**:
One PR boundary within a stack: the changes between a ref and its predecessor.

**Stack provider**:
The subsystem that manages stacked PRs for a repository: jj, Graphite, or the
GitHub-native Git provider. Distinct from the VCS backend; a provider is derived
from the backend and the Git stack-provider choice, but is its own axis.
_Avoid_: stack backend

**Publication**:
Pushing a stack's refs and creating, repairing, or readying its draft PRs so
the remote chain matches local topology.

**Publication plan**:
The computed set of publication actions for a stack, identified by a plan ID
that proves freshness, never authorization.

**Stack topology**:
The remote record of which PRs form a stack and in what order.

**Navigation comment**:
Today's stack-topology record: a kstack-owned comment maintained on every PR
in the stack.

**Frontier**:
The bottom-most unmerged slice of a stack; the only slice eligible to land
next.

**Landing**:
Merging a stack bottom-up: ready, merge, and verify each frontier, then
advance and republish the remainder.

**Advance**:
Removing a merged frontier from local history and rebasing the remaining
stack onto refreshed trunk.

### Outcomes

**Blocker**:
A structured reason (code plus message) a stack mutation refuses to proceed
without remote changes having been made.

**Indeterminate**:
An outcome where a mutation was sent but remote acceptance cannot be
disproved; retrying requires fresh inspection, not repetition.
_Avoid_: unknown, error (for this state)
