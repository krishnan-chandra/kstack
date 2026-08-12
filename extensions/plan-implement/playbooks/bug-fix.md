# Bug-fix proof obligations

Treat the reported defect as a claim to test, not a label.

- **Planner:** identify a concrete pre-change reproduction or a focused regression test that fails for the right reason. Trace the causal mechanism in the current code, not just the symptom. Make the same repro/test the completion check.
- **Implementer:** reproduce the defect before changing code when the repository can do so safely and cheaply. Add or strengthen the regression check, make the smallest causal fix, then rerun the same reproduction plus relevant regressions. If pre-change reproduction is impossible, state why and use the strongest available evidence; do not imply it was reproduced.
- **Final evidence:** report the mechanism, pre-change observation (or its limitation), post-change result from the same check, and remaining coverage gaps.
