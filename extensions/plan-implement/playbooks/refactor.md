# Refactor proof obligations

A refactor changes structure while preserving intended observable behavior.

- **Planner:** name the behavior, public contracts, compatibility boundaries, and representative callers that must remain unchanged. Pin them with existing tests or focused characterization checks before structural work.
- **Implementer:** capture the pre-change behavior before editing, preserve public contracts unless the task explicitly authorizes a migration, and run the same checks afterward. Keep incidental cleanup separate from behavior changes; if behavior must change, surface it as a deliberate deviation.
- **Final evidence:** report the characterization/contract checks, their before-and-after results, compatibility risks, and any behavior intentionally changed.
