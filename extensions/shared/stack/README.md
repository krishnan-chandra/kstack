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

## Provider selection

The stack provider is a **separate axis** from the VCS backend: the VCS backend
answers "which VCS mutates the repository", whereas the stack provider answers
"which subsystem manages stacked PRs".

The stack provider is **derived** from the configured backend (`jj` → `"jj"`,
`graphite` → `"graphite"`, `git` → `undefined`). There is deliberately **no
`stackProvider` key in `kstack.json`**: one mapping per backend is a
hypothetical seam, and introducing a config key before a second Git mapping
exists would be speculative surface. A GitHub-native stacks provider is the
event that changes the Git mapping and earns the configuration key (touching
`shared/vcs/config.ts` validation and the `setup-kstack` skill).

`StackProviderId` is intentionally not `VcsBackendId`; do not merge them.

## Request channels

`channel.ts` defines the four request/claim channels connecting stack providers
with host workflows (`plan-implement` and `land`):

- `kstack:stack:capabilities` (`StackCapabilitiesPayload` → `StackProviderCapabilities`)
- `kstack:stack:preflight` (`StackPreflightPayload` → `VcsResult<StackPreflight>`)
- `kstack:stack:publish` (`StackPublicationPayload` → `StackPublishOutcome`)
- `kstack:stack:land-through-pr` (`StackLandingPayload` → `StackPrefixLandOutcome`)

All payloads identify the target `provider: StackProviderId`. Provider extensions
claim requests matching their provider ID and ignore other providers, preserving
claim-once mechanics. If a channel request is unclaimed (`handled: false`), the
provider extension is not loaded and callers refuse middle-of-stack mutations.
