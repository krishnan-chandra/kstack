# Architecture rationale template

Ship this one-page rationale beside the type sketch when repository conventions support design artifacts. Replace the italic guidance with concrete content and remove unused guidance.

## Problem

*One paragraph: what the change must accomplish and why the shape is non-obvious. Include the existing callers, invariants, ownership, compatibility requirements, and unresolved evidence from grounding that materially constrain the design.*

## Usage (caller's view)

*Write this before the type sketch. Show README-style usage and two or three realistic call sites: imports, calls, returned values, and important failures. The shape below is derived from this usage. When they diverge, reconcile the shape to the caller's experience rather than changing the usage to excuse the types.*

## Shape

*Describe the recommended architecture. Put core data structures first, then show how data moves through public signatures and module boundaries. Name which invariants are encoded in types, where external input is validated, which module owns each decision, and what the system deliberately does not do. Judge interface depth explicitly: what complexity does the public surface hide, what remains exposed, and why is the interface no larger than needed?*

## Synthesis decision

*Record the Arena decision: which candidate became the base and why, what was grafted from each other candidate, what was rejected and why, the cross-judge's verdict, and any disagreement. Identify candidates by path or neutral label, not model prestige.*

## Tradeoffs accepted

*One bullet per tradeoff. Use the form “We accept X in exchange for Y.” Include choices a future reader might otherwise mistake for an oversight.*

## Alternatives considered

*Required. Name at least one structurally different alternative and why it lost. Compare interface depth, caller obligations, hidden complexity, ownership, and failure behavior—not implementation effort alone. Do not list mere naming or option variations. When constraints force one viable shape, state exactly which constraints eliminated the alternatives.*

## Open questions and risks

*List unresolved questions or implementation risks that need evidence or a human decision. Phrase decision requests as questions so an answer can close them.*

## Next implementation step

*One sentence naming the first concrete implementation step after synthesis or checkpoint approval.*
