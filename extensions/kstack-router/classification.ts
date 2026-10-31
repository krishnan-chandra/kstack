import { type BoundaryValue, isObject, isString, type JsonObject } from "../shared/validation.ts";
/** Route classification logic: recommendation, validation, and manual fallback. */

import { getAllRoutes, getRouteDescription, getRouteLabel } from "./catalog.ts";
import {
	CLASSIFIER_SENTINEL_END,
	CLASSIFIER_SENTINEL_START,
	type ClassifierEnvelope,
	DEFAULTS,
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

	// Reject unknown keys. Legacy `delivery`/`changeKind` fields from older
	// classifier prompts are accepted and ignored.
	const allowedKeys = new Set(["schemaVersion", "route", "confidence", "rationale", "delivery", "changeKind"]);
	for (const key of Object.keys(envelope)) {
		if (!allowedKeys.has(key)) {
			return { ok: false, error: `Unknown key in classifier envelope: "${key}".` };
		}
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
		},
	};
}

interface RouteRecommendation {
	route: RouteId;
	confidence: ClassifierEnvelope["confidence"];
	rationale: string;
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

	return (
		`Recommended route: ${routeLabel}\n` +
		`${confidenceMap[recommendation.confidence] ?? recommendation.confidence}\n` +
		`Model: ${modelSource}\n` +
		`${routeDesc}\n\n` +
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
