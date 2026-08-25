import { type BoundaryValue, isObject, isString, type JsonObject } from "../shared/validation.ts";
/** Route classification logic: recommendation, validation, and manual fallback. */

import { getAllRoutes, getRouteDescription, getRouteLabel } from "./catalog.ts";
import {
	type ChangeKind,
	CLASSIFIER_SENTINEL_END,
	CLASSIFIER_SENTINEL_START,
	type ClassifierEnvelope,
	DEFAULTS,
	type DeliveryRecommendation,
	isChangeKind,
	isRouteId,
	type RouteId,
} from "./types.ts";

/**
 * Validate and parse a classifier envelope from raw classifier output.
 *
 * The classifier child must wrap its JSON output between sentinel lines:
 *   ---KSTACK-ROUTE-START---
 *   {"schemaVersion":1,"route":"investigate","confidence":"high","rationale":"..."}
 *   ---KSTACK-ROUTE-END---
 *
 * Returns the parsed envelope on success or a description of the failure.
 */
export function parseClassifierOutput(
	output: string,
): { ok: true; envelope: ClassifierEnvelope } | { ok: false; error: string } {
	const trimmed = output.trim();

	// Find sentinel boundaries.
	const startIdx = trimmed.indexOf(CLASSIFIER_SENTINEL_START);
	const endIdx = trimmed.indexOf(CLASSIFIER_SENTINEL_END);
	if (startIdx === -1 || endIdx === -1) {
		return { ok: false, error: "Classifier output missing sentinel boundaries." };
	}

	const jsonPart = trimmed.slice(startIdx + CLASSIFIER_SENTINEL_START.length, endIdx).trim();
	if (!jsonPart) {
		return { ok: false, error: "Empty envelope between sentinel markers." };
	}

	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(jsonPart);
	} catch {
		return { ok: false, error: "Classifier envelope is not valid JSON." };
	}

	if (!isObject(parsed) || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "Classifier envelope must be a JSON object." };
	}

	const envelope =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ parsed as JsonObject;

	// Validate schema version.
	if (envelope.schemaVersion !== 1) {
		return { ok: false, error: `Unsupported schemaVersion: ${envelope.schemaVersion}.` };
	}

	// Validate route.
	if (!isString(envelope.route) || !isRouteId(envelope.route)) {
		return { ok: false, error: `Invalid or unknown route: ${JSON.stringify(envelope.route)}.` };
	}

	// Validate confidence.
	if (
		!["high", "medium", "low"].includes(
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ envelope.confidence as string,
		)
	) {
		return { ok: false, error: `Invalid confidence: ${envelope.confidence}. Must be high, medium, or low.` };
	}

	// Validate rationale.
	if (!isString(envelope.rationale) || envelope.rationale.trim().length === 0) {
		return { ok: false, error: "Classifier envelope missing or empty rationale." };
	}
	if (envelope.rationale.length > DEFAULTS.maxRationaleChars) {
		return { ok: false, error: `Rationale exceeds ${DEFAULTS.maxRationaleChars} characters.` };
	}

	// Validate optional change kind.
	let changeKind: ChangeKind | undefined;
	if (envelope.changeKind !== undefined) {
		if (!isString(envelope.changeKind) || !isChangeKind(envelope.changeKind)) {
			return { ok: false, error: `Invalid changeKind: ${JSON.stringify(envelope.changeKind)}.` };
		}
		// Fast classifiers sometimes fill every field shown in the output
		// template. A valid non-change route should not be discarded because
		// its inapplicable, otherwise-valid changeKind was echoed.
		if (envelope.route === "change" || envelope.route === "fast-change") changeKind = envelope.changeKind;
	}

	// Reject unknown keys.
	const allowedKeys = new Set(["schemaVersion", "route", "confidence", "rationale", "delivery", "changeKind"]);
	for (const key of Object.keys(envelope)) {
		if (!allowedKeys.has(key)) {
			return { ok: false, error: `Unknown key in classifier envelope: "${key}".` };
		}
	}

	// Validate optional delivery.
	let delivery: DeliveryRecommendation;
	if (envelope.delivery !== undefined) {
		if (envelope.delivery !== "single" && envelope.delivery !== "stack") {
			return {
				ok: false,
				error: `Invalid delivery: ${JSON.stringify(envelope.delivery)}. Must be "single" or "stack".`,
			};
		}
		// Delivery only applies to the full change route. fast-change is always
		// single-PR, and fast classifiers sometimes echo every template field, so
		// an inapplicable delivery is dropped rather than rejected.
		if (envelope.route === "change") delivery = envelope.delivery;
	}

	// Reject model-supplied commands or parameters.
	if (envelope.route === "unsupported" && envelope.confidence !== "low") {
		// Unsupported should always be low confidence; clamp it.
		envelope.confidence = "low";
	}

	return {
		ok: true,
		envelope: {
			schemaVersion:
				/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ envelope.schemaVersion as number,
			route:
				/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ envelope.route as RouteId,
			confidence:
				/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ envelope.confidence as ClassifierEnvelope["confidence"],
			rationale:
				/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ envelope.rationale as string,
			delivery,
			changeKind,
		},
	};
}

interface RouteRecommendation {
	route: RouteId;
	confidence: ClassifierEnvelope["confidence"];
	rationale: string;
	delivery?: DeliveryRecommendation;
	changeKind?: ChangeKind;
}

/**
 * Build a human-readable route recommendation display.
 */
export function formatRecommendation(recommendation: RouteRecommendation, modelSource: string): string {
	const confidenceMap = {
		high: "✓ High confidence",
		medium: "~ Medium confidence",
		low: "? Low confidence",
	};

	const routeLabel = getRouteLabel(recommendation.route);
	const routeDesc = getRouteDescription(recommendation.route);
	const deliveryLine = recommendation.delivery
		? `\nDelivery: ${recommendation.delivery === "stack" ? "stacked PRs" : "single PR"}`
		: "";
	const kindLine = recommendation.changeKind ? `\nChange kind: ${recommendation.changeKind}` : "";

	return (
		`Recommended route: ${routeLabel}\n` +
		`${confidenceMap[recommendation.confidence] ?? recommendation.confidence}\n` +
		`Model: ${modelSource}\n` +
		`${routeDesc}${deliveryLine}${kindLine}\n\n` +
		`Rationale: ${recommendation.rationale}`
	);
}

/**
 * Build the list of valid alternatives for the user selection prompt.
 */
export function buildRouteAlternatives(currentRoute?: RouteId): { id: RouteId; label: string; description: string }[] {
	return getAllRoutes()
		.filter((r) => r.id !== currentRoute && r.id !== "unsupported")
		.map((r) => ({ id: r.id, label: r.label, description: r.description }));
}
