# Shared stack contract

This module owns the cross-provider stacked-PR contract. It is a separate axis
from [`../vcs/`](../vcs/README.md), which mutates the local repository.

`outcome.ts` is the vocabulary every stack publisher and lander emits.
`plan-implement` and `land` consume those types directly. There is no
translation layer between producers.

## Status alphabet

Every stack mutation reports one of nine statuses:

`completed`, `declined`, `busy`, `blocked`, `stale`, `partial`, `cancelled`,
`indeterminate`, `failed`.

Publish (`StackPublishOutcome`) and land (`StackLandOutcome`) share that
alphabet. They are separate types because the payloads differ. Publish carries
`completedActions`, `failedAction`, and `inFlight`. Land carries `frontiers`,
`completedMutations`, and `recoveryOperationIds`. A producer may emit a subset
of the nine statuses; each outcome type still includes every status so callers
can switch exhaustively.

`LandResult` and `AutopilotResult` are other modules' interfaces. They keep
their own vocabularies. The one remaining conversion is `mapStackOutcome` at
land's command edge, where a stack land outcome becomes the user-facing
`LandResult`.

## Open blocker codes

A shared `StackBlocker` is `{ code, message, ref? }`. `code` is a
provider-defined string. Cross-seam consumers render `message`; they do not
switch on `code`.

A closed union of codes would force this module to grow every time a provider
adds a reason, and no consumer across the seam matches codes exhaustively.
Each provider may keep a closed internal union that is structurally assignable
to `StackBlocker`, and documents its own codes.

## `ref`, not bookmark or branch

Shared fields say `ref`, `topRef`, `baseRef`, and `remainingRefs`. A bookmark
is a jj noun; a branch is a Git or Graphite noun. The seam names the published
pointer without pretending every provider uses the same VCS object.

jj-internal types (`StackSlice`, publication actions, revsets) still say
bookmark. The rename applies where a value crosses this module.

`LandResult.remainingRefs` follows the same noun even though `LandResult` is
not a stack outcome. Land summaries are backend-neutral, and
`remainingBookmarks` was already wrong for Git and Graphite.
