# openrouter-floor

Sends every OpenRouter request as the model's [`:floor`
variant](https://openrouter.ai/docs/guides/routing/model-variants/floor) without
anyone typing `:floor`.

## What it does

`:floor` makes OpenRouter sort a model's endpoints by price and admits each
provider's discounted flex service tier into that sort. The cheapest endpoint
serves the request, and standard endpoints remain as fallback when flex capacity
is unavailable. The variant exists only as a model-ID suffix; no request-body
parameter reproduces it (`provider.sort: "price"` sorts but does not admit flex
endpoints, and `service_tier: "flex"` removes the standard fallback).

The extension listens to Pi's `before_provider_request` event. When the session
model belongs to the `openrouter` provider and the payload names exactly that
model, it returns a copy of the payload with `model` changed from
`openai/gpt-5.6-sol` to `openai/gpt-5.6-sol:floor`. Everything else in the
payload, and Pi's own model metadata (name, cost, thinking levels), stays as is.

It deliberately leaves a request alone when:

- the payload's `model` differs from the session model, which means another
  model produced the request;
- the model already carries a variant such as `:free`, `:nitro`, `:exacto`, or
  a user-chosen `:floor`;
- the session model is not on OpenRouter, even if its ID looks similar.

## Where it runs

Pi loads it with the rest of Kstack. Kstack child agents (panel-review,
plan-implement, pr-autopilot, parallel-agents, kstack-router) run with
`--no-extensions -e <kstack>/kstack.ts`, so they load Kstack alone and their
OpenRouter calls are floor-routed without booting the user's other extensions.

## Limits and caveats

- Pi prices requests with the base model's catalog rates, so the footer and
  session cost slightly overstate spend when a flex endpoint serves the request.
- OpenRouter's response reports the endpoint that actually served the request;
  the extension does not read it.
- No configuration. Choose a model with an explicit variant to opt a session
  out of floor routing.

## Tests

```bash
node --test extensions/openrouter-floor/
```

`floor-rewrite.test.ts` covers the rewrite decision without loading Pi.
