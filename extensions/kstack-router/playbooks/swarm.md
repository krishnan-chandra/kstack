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

## Done predicate

Done when the consolidated report is delivered. No worker changes are merged
into the working tree. The report contains findings from each slice, and
partial failures are noted.