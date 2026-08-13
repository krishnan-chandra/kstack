# Bug-fix proof obligations

Treat the reported defect as a claim to test, not a label. This is the same
failing-before / passing-after contract as the [`tdd`](../../../skills/tdd/SKILL.md)
skill. Use that skill's workflow when the bug has a cheap local test path;
keep this playbook and that skill aligned if either changes.

- **Planner:** identify a concrete pre-change reproduction or a focused
  regression test that fails for the right reason. Trace the causal mechanism
  in the current code, not just the symptom. Make the same repro/test the
  completion check. If a new automated test would be expensive, integration-
  heavy, mock-brittle, or otherwise a weak signal, plan the closest useful
  executable check instead and say why.
- **Implementer:** reproduce the defect before changing production code when
  the repository can do so safely and cheaply. Prefer the existing test path
  for that code. Add or strengthen the smallest focused regression check,
  confirm it fails for the intended reason, make the smallest causal fix, then
  rerun the same reproduction plus relevant nearby tests. Do not change tests
  merely to match a wrong implementation, and do not weaken assertions unless
  the expected behavior has genuinely changed. If pre-change reproduction is
  impossible or a new test is not worth the cost, state why and use the
  strongest available evidence; do not imply it was reproduced. Prefer no new
  test over a bad one.
- **Final evidence:** report the mechanism, the failing-before check and the
  failure it produced (or why that evidence could not be shown), the
  passing-after result from the same check, nearby validation, and remaining
  coverage gaps.
