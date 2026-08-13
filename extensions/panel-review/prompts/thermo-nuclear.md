# Thermo-Nuclear Code Quality Lens

Apply this lens **in addition to** the Reviewer Contract and Rubric. The panel is already covering correctness; this layer adds an unusually strict maintainability bar. Push the reviewer to be **ambitious** about structure — look for "code judo" moves that delete whole categories of complexity while preserving behavior.

## Core intent

> Perform a deep code quality audit of the current branch's changes.
> Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce spaghetti code, improve succinctness and legibility.
> Be ambitious — if there is a clear path involving restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

## Non-negotiable standards

0. **Be ambitious about structural simplification.** Do not stop at "a bit cleaner." Look for reframing that makes branches, helpers, modes, conditionals, or layers disappear. Prefer the solution that feels inevitable in hindsight. If complexity can be deleted rather than rearranged, push for deletion.

1. **Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.** Treat it as a code-quality smell. Prefer extracting helpers, subcomponents, modules, or local abstractions. Ask explicitly whether the code should be decomposed first. Waive only with a compelling structural reason.

2. **Do not allow random spaghetti growth.** Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches in unrelated flows. Push logic into a dedicated abstraction, helper, state machine, policy object, or separate module. Call out changes that make surrounding code harder to reason about, even if they technically work.

3. **Bias toward cleaning the design, not just accepting working code.** If behavior can stay the same while structure becomes meaningfully cleaner, push for the cleaner version. Prefer simplifications that remove moving pieces over refactors that merely spread complexity.

4. **Prefer direct, boring, maintainable code over hacky or magical code.** Treat brittle or "magic" behavior as a defect. Be skeptical of generic mechanisms that hide simple data-shape assumptions. Flag thin wrappers or identity pass-throughs that add indirection without clarity.

5. **Push on type and boundary cleanliness when it affects maintainability.** Question unnecessary optionality, `unknown`, `any`, or cast-heavy code when a clearer typed boundary could exist. Prefer explicit typed models or shared contracts over loosely-shaped ad-hoc objects. If a branch relies on silent fallback to paper over an unclear invariant, ask for an explicit boundary instead.

6. **Keep logic in the canonical layer and reuse existing helpers.** Call out feature logic leaking into shared paths or implementation details leaking through APIs. Prefer existing canonical utilities over bespoke one-offs. Push code toward the right package/service/module.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.** If independent work is serialized for no good reason, ask whether it should run in parallel. If related updates can leave state half-applied, push for a more atomic structure. Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation brittle.

## Review questions

For every meaningful change ask:

- Is there a "code judo" move that would make this dramatically simpler?
- Can this be reframed so fewer concepts, branches, or helper layers are needed?
- Does this improve or worsen the local architecture?
- Did the diff add branching complexity where a better abstraction should exist?
- Did a cohesive module become more coupled, more stateful, or harder to scan?
- Is this logic in the right file and layer?
- Did a file or component cross a healthy size boundary?
- Are there repeated conditionals signaling a missing model or helper?
- Is the implementation direct and legible or does it rely on special cases?
- Is this abstraction earning its keep or is it just a wrapper?
- Did the diff introduce casts/optionality/ad-hoc shapes obscuring the real invariant?
- Is this orchestration more sequential or less atomic than it needs to be?

## Flag aggressively

- Complicated implementation where a reframing could delete whole categories of complexity.
- Refactors that move complexity around without reducing the concepts a reader must hold.
- A file crossing 1k lines, especially if splittable.
- Conditionals bolted onto unrelated paths; one-off booleans/nullable modes complicating control flow.
- Feature-specific logic leaking into general-purpose modules; generic "magic" hiding simple structure.
- Thin wrappers, unnecessary casts/`any`/`unknown`/optionality, copy-pasted logic, narrow edge-case handling in the middle of a busy function, "temporary" branching that will become permanent debt, bespoke helpers duplicating canonical utilities, logic in the wrong layer, sequential async where parallel would be simpler/clearer, partial updates leaving state half-applied.

## Preferred remedies

Delete a layer of indirection rather than polishing it. Reframe the state model so conditionals disappear. Change the ownership boundary so the feature becomes a natural extension. Turn special cases into the default flow. Extract a pure helper. Split a large file. Move feature logic behind its own abstraction. Replace condition chains with a typed model or dispatcher. Separate orchestration from business logic. Collapse duplicate branches. Reuse the canonical helper. Make type boundaries explicit. Move logic to the owning layer. Parallelize independent work. Make related updates atomic where partial state is harder to reason about. Never settle for "maybe rename this" when the issue is structural.

## Output priority

Prioritize findings:

1. Structural code-quality regressions
2. Missed code-judo / dramatic simplification opportunities
3. Spaghetti / branching complexity increases
4. Boundary / abstraction / type-contract problems
5. File-size and decomposition concerns
6. Modularity and abstraction issues
7. Legibility concerns

Do not flood with low-value nits when larger structural issues exist. Prefer a small number of high-conviction comments over cosmetic notes.

## Approval bar (thermo)

Do not approve merely because behavior seems correct. The bar is:

- no clear structural regression
- no obvious missed opportunity to make the implementation dramatically simpler when such a path is visible
- no unjustified file-size explosion (below-1k → above-1k is a presumptive blocker)
- no obvious spaghetti-growth from special-case branching
- no hacky/magical abstraction making the code harder to reason about
- no unnecessary wrapper/cast/optionality churn obscuring the real design
- no architecture-boundary leak or avoidable canonical-helper duplication
- no missed obvious decomposition that would materially improve maintainability

Treat as presumptive blockers unless the author can clearly justify them: incidental complexity preserved when a code-judo move would delete it; file crossing 1k lines; ad-hoc branching tangling an existing flow; scattering feature checks across shared code; unnecessary abstraction/wrapper/cast-heavy contract; duplicating an existing helper or putting logic in the wrong layer when a canonical home exists.
