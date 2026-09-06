/**
 * Decide whether an outgoing OpenRouter request should switch to the `:floor` model variant.
 *
 * `:floor` sorts OpenRouter's endpoints for a model by price and admits flex-tier
 * endpoints into that sort, so the cheapest capacity serves each request and
 * standard endpoints remain as fallback. It exists only as a model-ID suffix; no
 * request-body parameter reproduces it. See
 * https://openrouter.ai/docs/guides/routing/model-variants/floor
 */
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { BoundaryValue } from "../shared/validation.ts";

const OPENROUTER_PROVIDER = "openrouter";
const FLOOR_VARIANT = "floor";

/** The subset of the current session model the rewrite needs. */
interface CurrentModel {
	provider: string;
	id: string;
}

/** A serialized provider request body that names its model. Other fields pass through untouched. */
const modelPayloadSchema = Type.Object({ model: Type.String() }, { additionalProperties: true });
type ModelPayload = Static<typeof modelPayloadSchema>;

interface FloorDecision {
	/** The model ID to send, or undefined when the payload should go out unchanged. */
	model?: string;
	reason: "rewritten" | "no-model" | "not-openrouter" | "payload-model-mismatch" | "already-variant";
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
 * Choose the `:floor` model ID for a provider payload.
 *
 * The provider hook receives only the serialized payload, so the session model is
 * the evidence that the request targets OpenRouter. The payload model must match
 * that session model exactly; otherwise another model produced the request and it
 * is left alone.
 */
export function decideFloor(payload: BoundaryValue, current: CurrentModel | undefined): FloorDecision {
	if (!current) return { reason: "no-model" };
	if (current.provider !== OPENROUTER_PROVIDER) return { reason: "not-openrouter" };
	if (!isModelPayload(payload) || payload.model !== current.id) return { reason: "payload-model-mismatch" };
	if (hasVariant(payload.model)) return { reason: "already-variant" };
	return { model: `${payload.model}:${FLOOR_VARIANT}`, reason: "rewritten" };
}

/** Return the payload with the `:floor` model applied, or undefined to keep Pi's payload unchanged. */
export function applyFloor(payload: BoundaryValue, current: CurrentModel | undefined): ModelPayload | undefined {
	const decision = decideFloor(payload, current);
	if (decision.model === undefined || !isModelPayload(payload)) return undefined;
	return { ...payload, model: decision.model };
}
