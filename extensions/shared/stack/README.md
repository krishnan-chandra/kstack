# Shared stack contract

This module owns the cross-provider stacked-PR contract. It is a separate axis
from [`../vcs/`](../vcs/README.md), which mutates the local repository.

`outcome.ts` is the vocabulary every stack publisher and lander emits.
`manifest.ts` owns the bounded provider-neutral manifest and shared immutable
Git-fact checks used by Graphite and GitHub. `plan-implement` and `land` consume
these contracts directly.

## Stack topology

`topology.ts` owns the remote stack-membership record. Callers reconcile or
query ordered PR entries through `StackTopologyStore`; they do not read or
write GitHub comments directly. The navigation-comment store is the only
adapter today. The GitHub stack provider uses that adapter because GitHub has
no native stacks API.

The navigation-comment wire format is a compatibility contract with comments
already live on GitHub. It uses the `<!-- kstack-stack-nav -->` marker, schema
version 1, at most 100 entries, and at most 60,000 UTF-8 bytes. Changes must
remain backward-compatible with both the encoded payload and legacy Markdown
table fallback.

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

The stack provider is derived from the configured backend. jj maps to `"jj"`,
and Graphite maps to `"graphite"`. Git reads `vcs.stackProvider`: `"github"`
is the default, and `"none"` disables stacked-PR routing. The key is ignored
with a warning for jj and Graphite because those mappings are fixed.

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
claim-once mechanics. `StackLandingCapabilities` contains only the optional
`runAutopilot` callback used by Graphite's native landing flow. jj and GitHub
delegate each frontier through Land's separate `kstack:land:request` interface.

If a channel request is unclaimed (`handled: false`), the provider extension is
not loaded and callers refuse middle-of-stack mutations.
