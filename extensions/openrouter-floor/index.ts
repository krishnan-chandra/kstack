/**
 * openrouter-floor: send every OpenRouter request as the `:floor` model variant.
 *
 * Users keep selecting plain model IDs such as `openrouter/openai/gpt-5.6-sol`.
 * Right before Pi sends the provider request, this extension rewrites the payload's
 * `model` to `openai/gpt-5.6-sol:floor`, so OpenRouter sorts endpoints by price and
 * may serve the request from a provider's flex tier. Payloads that already name a
 * variant, or that target another provider, pass through untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyFloor } from "./floor-rewrite.ts";

export default function openrouterFloor(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => applyFloor(event.payload, ctx.model));
}
