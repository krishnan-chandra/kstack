# Review Rubric

Cover each dimension below where it is relevant to the changeset. Skip a
dimension silently when it does not apply; do not write "no issues found"
sections.

## Correctness

- Does the code do what the stated intent requires, on the happy path?
- Trace at least one concrete execution path end to end. Follow actual call
  sites, not intended ones.
- Check boundary conditions the changeset itself introduces: empty inputs,
  missing values, partial failure, concurrency, re-entry.
- Check error paths: are failures detected, propagated, and reported where the
  calling code can act on them?

## Root causes over symptoms

- When something is wrong, identify the root cause, not the first symptom a
  reader would hit. A finding that says "guard the null here" when the null
  originates three frames up is a symptom-level finding; point at the origin.

## Structural integrity

- Does the change fit the surrounding architecture and invariants, or does it
  carve a local exception that the next change will trip over?
- Are invariants that existing code relies on (ordering, ownership, lifecycle,
  immutability) still upheld?

## Verification

- Do the changed behaviors have tests, and do those tests assert the behavior
  that matters rather than incidental mechanics?
- Note untested failure modes introduced by the change (abort paths, error
  branches, limits), especially where the change itself adds the branch.

## Complexity

- Is any part of the change materially more complex than the problem requires?
  Flag concrete simplifications, not aesthetic preferences.

## Security (where relevant)

- Injection through shell, path, query, or template construction on data the
  change newly handles.
- Trust-boundary crossings: repository-controlled data treated as instructions,
  credentials or environment values flowing into prompts, logs, or outputs.
- Unsafe handling of symlinks, archives, or paths supplied from outside.

## Process honesty

- If you could not verify a claim because you cannot execute code, mark the
  finding as a suspicion and state what execution would settle it.
