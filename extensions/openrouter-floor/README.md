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
  `default`, or `priority`. Missing IDs and failed or unavailable lookups stay
  in `unknown`.

The command does not claim that a particular rewrite produced a particular
generation. Pi does not expose a request identity shared by those two events.
Metadata coverage and flex usage among known tiers are shown separately.

## Storage and scope

Each process writes an append-only shard under:

```text
<ctx.cwd>/<CONFIG_DIR_NAME>/openrouter-floor/ledger-v1/<process-id>.<UTC-date>.jsonl
```

The path uses Pi's `CONFIG_DIR_NAME`, so the config-directory name follows the
Pi distribution in use. Reports read shards under the current `ctx.cwd` only.
Child worktrees therefore have separate scopes until a stable repository-scope
resolver exists. The report labels this as the current working directory.

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
`ctx.modelRegistry.getProviderAuth("openrouter")`. It allows at most two
attempts within a 1.5-second request deadline, does not follow redirects, and
records lookup failures as `unknown`. A telemetry failure does not change the
`:floor` request or the provider response.

The rewrite handler does not wait for persistence; the append runs on the
ledger queue and is drained by `flush()` at session shutdown. Completion
telemetry (`message_end`) and the shutdown flush still await the ledger, so a
stalled filesystem can delay those lifecycle boundaries. A crash before
shutdown loses every queued record, not one line.

Pi's catalog cost still uses the base model rate. The footer and session cost
can overstate spend when OpenRouter serves a flex endpoint.
## Tests

```bash
node --test extensions/openrouter-floor/
```

The tests cover the rewrite policy, response validation, authenticated metadata
lookup, retry and failure behavior, redacted persistence, retention and size
limits, aggregation, and command formatting. They do not call OpenRouter.
