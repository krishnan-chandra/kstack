# Engineering principles for changes

Use these as decision lenses, not as permission to expand scope. The user task,
repository contracts, and approved plan remain authoritative. Apply only the
principles relevant to the change.

- **Start from the observable outcome.** Preserve or improve the user and caller
  contract; do not optimize for implementation convenience.
- **Subtract and flatten first.** Remove obsolete paths, duplicated decisions,
  pass-through layers, and unnecessary mutable state before adding machinery.
- **Model the domain explicitly.** Choose data shapes, ownership, and invariants
  before writing conditionals. Prefer structures that make invalid states hard
  or impossible to represent.
- **Keep boundaries honest.** Validate untrusted input once at system
  boundaries, expose domain concepts internally, and do not bypass the type
  system.
- **Fix causes, not symptoms.** Reproduce failures, trace the causal mechanism,
  and repair the layer that owns it. Avoid guards that merely hide the defect.
- **Finish internal migrations cleanly.** Inventory callers, migrate them, and
  remove obsolete internal APIs when compatibility requirements permit.
- **Design for retries and concurrency.** Eliminate shared mutable state before
  adding coordination. Make lifecycle operations converge after partial runs.
- **Build a rerunnable lever when it earns its keep.** For repetitive, broad, or
  hard-to-audit work, prefer the smallest useful script, codemod, or generator
  over hand edits.
- **Sequence and prove real behavior.** End each increment with a focused check,
  then exercise the relevant user or API path before declaring success.

In the plan and final report, mention only principles that materially changed a
design or implementation choice, and name that choice.
