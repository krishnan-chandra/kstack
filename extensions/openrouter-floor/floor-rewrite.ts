/**
 * Apply OpenRouter's floor (price/flex) or nitro (throughput/priority) variant.
 * Only a model-ID suffix both sorts endpoints and admits the extra tier without
 * preferring it. Body parameters do not reproduce this behavior. See:
 * https://openrouter.ai/docs/guides/routing/model-variants/floor
 * https://openrouter.ai/docs/guides/routing/model-variants/nitro
 */
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { BoundaryValue } from "../shared/validation.ts";
import type { RoutingVariant } from "./routing-policy.ts";

const OPENROUTER_PROVIDER = "openrouter";

/** The subset of the current session model the rewrite needs. */
export interface CurrentModel {
	provider: string;
	id: string;
}

/** A serialized provider request body that names its model. Other fields pass through untouched. */
const modelPayloadSchema = Type.Object({ model: Type.String() }, { additionalProperties: true });
type ModelPayload = Static<typeof modelPayloadSchema>;

interface FloorDecision {
	/** The model ID to send, or undefined when the payload should go out unchanged. */
	model?: string;
	reason: "rewritten" | "no-model" | "not-openrouter" | "payload-model-mismatch" | "already-variant" | "policy-none";
}

/** True when an OpenRouter model ID already carries a `:variant` suffix such as `:floor`, `:free`, or `:nitro`. */
export function hasVariant(modelId: string): boolean {
	const slash = modelId.indexOf("/");
	return modelId.indexOf(":", slash + 1) !== -1;
}

function isModelPayload(payload: BoundaryValue): payload is ModelPayload {
	return Check(modelPayloadSchema, payload);
}

/**
 * Choose the policy's variant model ID for a provider payload.
 *
 * The provider hook receives only the serialized payload, so the session model is
 * the evidence that the request targets OpenRouter. The payload model must match
 * that session model exactly; otherwise another model produced the request and it
 * is left alone.
 */
export function decideRewrite(
	payload: BoundaryValue,
	current: CurrentModel | undefined,
	variant: RoutingVariant,
): FloorDecision {
	if (!current) return { reason: "no-model" };
	if (current.provider !== OPENROUTER_PROVIDER) return { reason: "not-openrouter" };
	if (!isModelPayload(payload) || payload.model !== current.id) return { reason: "payload-model-mismatch" };
	if (hasVariant(payload.model)) return { reason: "already-variant" };
	if (variant === "none") return { reason: "policy-none" };
	return { model: `${payload.model}:${variant}`, reason: "rewritten" };
}

/** Return a rewritten payload, or undefined to keep Pi's payload unchanged. */
export function applyRewrite(
	payload: BoundaryValue,
	current: CurrentModel | undefined,
	variant: RoutingVariant,
): ModelPayload | undefined {
	const decision = decideRewrite(payload, current, variant);
	if (decision.model === undefined || !isModelPayload(payload)) return undefined;
	return { ...payload, model: decision.model };
}
