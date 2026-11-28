# graphite-stacked-prs

Provider extension for Graphite stack prefix landing through `/land`.

In Graphite mode (`vcs.backend = "graphite"`), this extension claims the shared stack landing channel defined in [`extensions/shared/stack/`](../shared/stack/README.md):

- `kstack:stack:land-through-pr` (`provider: "graphite"`)

Graphite users drive stacked workflows through `/land` and native `gt`. This extension provides no standalone commands or tools.

## What it does

- Validates local Graphite stack topology against immutable Git commits, Graphite trunk, and `gt merge --dry-run` scope.
- Lands complete Graphite stack prefixes through `/land --pr <number>`. Validates all predecessor PRs, runs PR autopilot readiness on every PR in the prefix before the shared [stack transaction](../shared/stack/README.md#stack-transaction) starts (an Autopilot fix publishes through Graphite, which takes the same lock), then dry-runs the native merge, confirms the landing plan with the user, acquires the publication lock, repeats the inspection and dry run, invokes native `gt merge` only if the plan ID still matches, verifies remote merge completion on GitHub for each PR, and synchronizes the local stack with `gt sync`.

## What it refuses

- Non-linear branches or topologies outside the confirmed prefix.
- Explicit `--method` for Graphite landing; Graphite repository settings own the merge method.
- Landing when any prefix PR is in draft state or unverified by PR autopilot.
- Concurrent publication or landing mutations in the same repository (serialized via `shared/publication-lock.ts`).

## Limits

| Item | Limit |
| --- | --- |
| Max stack slices | 50 |
| Branch name length | 240 chars |
| Command timeouts | 8s trunk/children, 15s Git/gh inspect, 60s gt submit/merge/sync |
| Concurrency | 1 active mutation per session |

## Development

```bash
node --test extensions/graphite-stacked-prs/
npm run typecheck
npm run check:exports
```
