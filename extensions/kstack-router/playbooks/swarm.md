# Swarm playbook

Goal: Fan out N parallel workers across different slices of a task, drain them,
and return one consolidated report.

## First turn (read-only framing)

Stop after:
1. Defining the slices (partitions of the work).
2. Defining concurrency and models.
3. Estimating cost.
4. Defining the aggregation format.
5. Describing what each worker will do.

Present this frame to the user for approval before proceeding.

## Subsequent turns

Follow the swarm skill workflow:
- Fan out workers across slices.
- Drain all workers (failures don't cancel siblings).
- Aggregate results into one consolidated report.
- When a routed swarm is explicitly producing repository changes, create a
  dedicated task branch (or reuse a parent-created managed-worktree branch)
  before writing those changes and commit coherent, verified increments. Keep
  worker isolation: no worker writes into the shared tree.

## Done predicate

Done when the consolidated report is delivered. Report-only swarms do not
create a branch. When the swarm is explicitly writing repository files, those
changes land on the task branch as committed increments. No worker changes are
merged into the working tree. The report contains findings from each slice,
and partial failures are noted. Do not push or publish.