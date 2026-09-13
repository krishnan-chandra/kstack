# openrouter-floor

Sends every OpenRouter request as the model's [`:floor`
variant](https://openrouter.ai/docs/guides/routing/model-variants/floor) and
records bounded observations about the rewrite and the service tier that served
completed generations.

## What it does

`:floor` makes OpenRouter sort a model's endpoints by price and admits each
provider's discounted flex service tier into that sort. The cheapest endpoint
serves the request, and standard endpoints remain as fallback when flex
capacity is unavailable. The variant exists only as a model-ID suffix. A
request-body parameter cannot reproduce it (`provider.sort: "price"` sorts but
does not admit flex endpoints, and `service_tier: "flex"` removes the standard
fallback).

The extension listens to Pi's `before_provider_request` event. When the session
model belongs to the `openrouter` provider and the payload names exactly that
model, it returns a copy of the payload with `model` changed from
`openai/gpt-5.6-sol` to `openai/gpt-5.6-sol:floor`. Everything else in the
payload, and Pi's own model metadata, stays as is.

It leaves a request alone when:

- the payload's `model` differs from the session model, which means another
  model produced the request;
- the model already carries a variant such as `:free`, `:nitro`, `:exacto`, or
  a user-chosen `:floor`;
- the session model is not on OpenRouter, even if its ID looks similar.

## Where it runs

Pi loads it with the rest of Kstack. Kstack child agents (panel-review,
plan-implement, pr-autopilot, kstack-router) run with
`--no-extensions -e <kstack>/kstack.ts`, so they load Kstack alone and their
OpenRouter calls are floor-routed without booting the user's other extensions.

## View routing observations

Run the command inside Pi:

```text
/openrouter-floor-stats
/openrouter-floor-stats today
/openrouter-floor-stats 7d
/openrouter-floor-stats 30d
/openrouter-floor-stats process
```

The default range is `30d`. `process` limits the report to the current Pi
runtime; the other ranges include all retained shards under the current scope.
The command reads the local ledger and performs no network lookup. It reports
two separate populations:

- **Floor rewrites observed** counts payload replacements from
  `before_provider_request`.
- **Completed generations** counts finalized OpenRouter assistant messages.
  For messages with a `responseId`, the extension queries the authenticated
  OpenRouter `/api/v1/generation?id=...` endpoint and records `flex`,
  `default`, or `priority`. OpenRouter publishes generation metadata after the
  stream completes, so the lookup starts after a 15-second delay and retries a
  still-missing record. Missing IDs and failed or unavailable lookups stay in
  `unknown`. The report breaks unknown results down by reason.

The command does not claim that a particular rewrite produced a particular
generation. Pi does not expose a request identity shared by those two events.
Metadata coverage and flex usage among known tiers are shown separately.

## Storage and scope

Each process writes an append-only shard under:

```text
<agentDir>/openrouter-floor/ledger-v1/<scope-key>/<process-id>.<UTC-date>.jsonl
```

`<agentDir>` is Pi's agent directory (`PI_CODING_AGENT_DIR`, default
`~/.pi/agent`), so telemetry never lands in a project working tree and is never
snapshotted by Git or jj. `<scope-key>` is the repository identity derived
from the canonical Git common directory. The resolver understands jj
workspaces, and all worktrees and workspaces for one repository share a scope.
Outside a repository, or when identity resolution fails, the key falls back to
the canonical working directory. Reports state which scope is active.

Adopting the repository key leaves the previous working-directory-keyed scope
under `ledger-v1/` untouched and restarts reporting in the repository scope.
The ledger does not prune that orphaned directory.

Shards written by earlier versions under `<cwd>/.pi/openrouter-floor/` are
not read or migrated; delete them by hand if they were committed.

The ledger rotates each process into daily shards and keeps at most 30 days of
events, 10,000 lines per process-day shard, and 5 MiB across a scope. It accounts
for every retained shard when enforcing the scope limit. Malformed records and
over-budget shards are ignored and surfaced only through secret-free internal
diagnostics. A process shutdown flushes its pending append queue.

## Security and failure behavior

The ledger stores timestamps, process IDs, event IDs, scope hashes, generation-ID
hashes, normalized tiers, and lookup reasons. It does not store prompts,
responses, payloads, headers, API keys, raw generation IDs, or provider response
bodies.

The metadata lookup uses the provider auth resolved by
`ctx.modelRegistry.getProviderAuth("openrouter")`. It starts 15 seconds after a
completed message and allows three attempts, five seconds apart, within a
30-second deadline. HTTP 404 is retryable because OpenRouter returns it while a
new generation record is still propagating; a record typically becomes
queryable about eight seconds after the stream ends. The lookup does not follow
redirects. Failed lookups stay in `unknown`, and telemetry failures do not
change the `:floor` request or the provider response.

`message_end` waits only for the initial ledger append. The network lookup runs
in the background, so metadata propagation does not delay tools or the next
model turn. The lookup ignores the agent turn's abort signal: it is a single
bounded GET, and cancelling it when the user interrupts a turn would discard
exactly the coverage this extension measures. Session shutdown is the only
cancellation source. It aborts and drains pending lookups before flushing the
ledger, so a replacement session never uses a stale model registry. A tier that
arrives while shutdown is racing is still recorded; an unresolved lookup stays
`pending`. A short-lived process can exit before its final generations become
queryable, and a crash can lose records still queued for persistence.

### Pending records are terminal

A `pending` generation is never retried later, and that is a deliberate
consequence of redaction. The ledger keeps only `hashGenerationId(responseId)`,
so once the process that saw the raw generation ID is gone, nothing can query
`/api/v1/generation` for it again. Backfilling pending records at report time
would require storing raw generation IDs, which the threat model rejects.
Sessions shorter than the propagation delay therefore report `pending`
permanently, and that undercount is the intended trade for not persisting
provider-side identifiers.

Pi's catalog cost still uses the base model rate. The footer and session cost
can overstate spend when OpenRouter serves a flex endpoint.
## Tests

```bash
node --test extensions/openrouter-floor/
```

The tests cover the rewrite policy, response validation, authenticated metadata
lookup, propagation delay, eventual-consistency retries, background lifetime
and shutdown cancellation, redacted persistence, retention and size limits, aggregation, and
command formatting. They do not call OpenRouter.
