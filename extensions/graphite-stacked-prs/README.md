# graphite-stacked-prs

Consolidated provider extension for Graphite stack validation, publication, and prefix landing.

In Graphite mode (`vcs.backend = "graphite"`), this extension claims the shared stack channels defined in [`extensions/shared/stack/`](../shared/stack/README.md):

- `kstack:stack:capabilities` (`provider: "graphite"`)
- `kstack:stack:preflight` (`provider: "graphite"`)
- `kstack:stack:publish` (`provider: "graphite"`)
- `kstack:stack:land-through-pr` (`provider: "graphite"`)

Graphite users drive stacked workflows through `/land`, `plan-implement --stack`, and native `gt`. This extension provides no standalone commands or tools.

## What it does

- Validates local Graphite stack topology against immutable Git commits, Graphite trunk, and `gt submit --stack --dry-run` / `gt merge --dry-run` scope.
- Enforces parent-owned publication for `plan-implement --stack` by inspecting the provider-neutral private JSON stack manifest from [`shared/stack/manifest.ts`](../shared/stack/manifest.ts), revalidating every branch/headSha/diff against Git, and submitting through `gt submit --stack --draft --no-edit` under a publication lock.
- Lands complete Graphite stack prefixes through `/land --pr <number>`. Validates all predecessor PRs, runs PR autopilot readiness on every PR in the prefix, dry-runs the native merge, confirms the landing plan with the user, acquires the publication lock, invokes native `gt merge`, verifies remote merge completion on GitHub for each PR, and synchronizes the local stack with `gt sync`.

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
