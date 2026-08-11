# Code Quality Review Lens

Apply this lens after correctness. Code quality findings are only worth
reporting when they hide or invite defects.

## Worth reporting

- **Duplicated logic with divergent drift risk** — the same decision made in two
  places that must agree, where the change edits only one.
- **Leaky boundaries** — a module that now reaches into another's internals,
  making both harder to change safely.
- **Resource lifecycle gaps** — handles, temp files, listeners, timers, or child
  processes acquired without a guaranteed release path (missing `finally`,
  unremoved listeners, abandoned processes).
- **Unbounded growth** — buffers, queues, caches, or outputs that grow with
  external input and have no cap.
- **Silent failure modes** — swallowed errors, empty catch blocks, or fallback
  paths that turn a real failure into confusing downstream behavior.

## Not worth reporting

- Formatting, import order, comment density, or personal idioms.
- "Could be more abstract/general/configurable" without a concrete current cost.
- Missing documentation for self-evident code.

Keep code-quality findings few and load-bearing. If a finding would not change
what a careful maintainer does next, drop it.
