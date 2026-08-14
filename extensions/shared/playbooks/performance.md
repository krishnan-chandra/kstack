# Performance proof obligations

Performance claims require comparable measurements, not intuition.

- **Planner:** define the workload, environment, metric, acceptance threshold, and likely regression risks. Capture a baseline from the same artifact and plan a post-change measurement under matching conditions.
- **Implementer:** measure the baseline before changing code, then measure the changed artifact with the same harness and record variability or confounders. Do not substitute an unrelated microbenchmark for the affected path without saying so.
- **Final evidence:** report baseline and post-change values, workload/environment, method, variance or limitations, and correctness/regression checks.
