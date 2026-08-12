---
name: architect
description: Sketch caller usage, types, signatures, and module structure before implementation, compare structurally distinct designs, then implement against the selected contract. Use explicitly with /skill:architect for "architect this", "design this", public API changes, cross-module ownership changes, or non-trivial work where coding first could lock in the wrong shape.
license: MIT
compatibility: Pi CLI with the kstack how, why, and arena skills; a repository checkout for implementation work.
disable-model-invocation: true
---

# Architect

Design before implementing. Start from the caller's experience, sketch types and module boundaries with `not implemented` bodies or pseudocode, compare multiple whole-shape alternatives, and then fill in the selected design. If implementation repeatedly fights the sketch, discard it and redesign instead of accumulating workarounds.

This skill is explicit-only because it can turn one implementation task into several model runs. Invoke it with `/skill:architect`; do not silently add that cost to ordinary changes.

## Track the phases

Keep these five phases visible in working notes or status updates so autonomous work cannot silently skip one:

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap if needed

## Phase A: Ground the problem

Build a traced mental model of every existing subsystem the design touches. Use [`how`](../how/SKILL.md) to follow concrete entry points, state, decisions, and observable effects. Naming files or listing symbols is not grounding.

Use [`why`](../why/SKILL.md) as well when the proposal changes ownership, layering, a durable public contract, or an odd existing boundary. Historical rationale is a constraint only when evidence supports it; do not infer intent from code shape.

Capture the grounding artifacts that candidates need:

- current callers and their observable contract;
- state and data flow across the affected boundaries;
- invariants and compatibility constraints;
- ownership of the relevant decisions; and
- unresolved gaps, clearly labeled.

Skip grounding only for genuinely greenfield work with no surrounding system to integrate.

## Phase B: Sketch distinct designs

Run [`arena`](../arena/SKILL.md) on a design-sketch task. Arena candidates run from isolated directories, and this explicit-only skill is not present in their system prompts. Build a self-contained candidate prompt before fan-out:

1. Resolve this skill's directory from the absolute path used to load `SKILL.md`.
2. Read [`references/runner-prompt.md`](references/runner-prompt.md), [`references/rationale-template.md`](references/rationale-template.md), and [`references/design-red-flags.md`](references/design-red-flags.md) from that directory.
3. Inline the full contents of all three files into every candidate task, with clear labels.
4. Append the task, Phase A grounding artifacts, repository root, isolated working directory, and assigned output path.

Do not pass relative reference paths and expect a candidate to resolve them. Candidate work stays in its assigned Arena directory and must not edit production files.

Each candidate produces a design package shaped by the inlined rationale template:

1. README-style caller usage and two or three realistic call sites;
2. core data types and encoded invariants;
3. public function, method, or class signatures;
4. a module map with ownership and data flow;
5. `not implemented` bodies or pseudocode where behavior needs clarification; and
6. a concise rationale and concrete alternatives considered.

Require at least two **structurally distinct** viable candidates before synthesis. Variations in naming, options, or method placement do not count. If candidates converge because the prompt overconstrained them, loosen the accidental constraints and rerun. If they diverge because the problem is underspecified, improve the grounding and rerun.

Screen each candidate against [`references/design-red-flags.md`](references/design-red-flags.md). Reject or revise shallow modules, leaked implementation details, modules split only by execution order, and pass-through layers.

Compare viable candidates on interface depth: prefer the design that hides more policy and complexity behind a smaller caller-facing surface. Arena returns one synthesized design package and records the base, grafts, rejections, and judge disagreement in the rationale's **Synthesis decision** section.

## Phase C: Agree only when requested

By default, continue directly to implementation after synthesis. Pause before implementation only when the invoker requests a checkpoint, for example:

- `/skill:architect with checkpoint: ...`
- `architect this, but show me the design before coding`
- `stop after the sketch`

At a checkpoint, present the caller usage, public shape, module map, tradeoffs, and open questions, then wait for approval. If feedback changes the shape, treat it as new grounding evidence and rerun Phase B rather than patching the rejected sketch.

The synthesized sketch and rationale may be committed separately when the user asks for scaffold-first history. Do not commit merely because this skill ran.

## Phase D: Implement against the sketch

Move the synthesized package into the intended repository location, following local conventions. For a small change, one sketch or implementation file plus its rationale may be enough. For a larger change, retain the module map and type definitions in the design artifact the repository normally uses.

Replace `not implemented` bodies with code and pseudocode with tested logic. Treat the sketch as a contract, but not as unquestionable authority.

Record every material deviation:

- what the sketch expected;
- what implementation evidence contradicted it;
- whether the requirement was missing, the sketch was wrong, or the implementation was overreaching; and
- how the selected design changes.

Resolve a local one-off deviation when it preserves the public shape and invariants. Stop at a requested checkpoint, or re-enter design, when a deviation materially changes caller usage, ownership, or the public contract. Do not quietly add parameters, optional escape hatches, shared state, or caller obligations just to make the implementation fit.

Run the repository's focused tests and relevant regression checks. When the change has a real user or API surface, exercise that surface as well as unit-level behavior.

## Phase E: Scrap a wrong architecture

A hard edge case does not invalidate a design. Scrap the sketch when implementation shows a **repeated pattern** of the same architectural friction, such as:

- the same workaround appearing in unrelated code;
- several edge cases requiring the same special branch;
- types needing `any`, casts, or nominally optional fields that are always required;
- shared-state coordination appearing where the sketch assumed actor-local state;
- callers needing internal rules to use the abstraction safely; or
- two or more independent deviations that point to the same missing concept or wrong boundary.

When that happens:

1. Stop adding fixes to the current shape.
2. Run `how` over what was built and capture the implementation evidence.
3. Redesign with those constraints treated as day-one inputs.
4. Remove unnecessary surface or layers before adding new ones.
5. Return to Phase B and rerun Arena.

Preserve useful tests and observations, not the failed architecture.

## Deliverables

Return or retain, according to repository conventions:

- the synthesized caller-first design package;
- a one-page rationale using [`references/rationale-template.md`](references/rationale-template.md), including the Arena synthesis decision;
- the implementation and tests, unless the user requested sketch-only work or a checkpoint has not been approved;
- material deviations and whether they triggered redesign; and
- verification commands and results.

The caller's usage comes first. Types and modules exist to make that usage safe and simple, not to justify an implementation shape chosen in advance.
