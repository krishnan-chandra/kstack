/** Canonical route catalog IDs and shared types for the kstack-router. */

export type RouteId =
	| "investigate"
	| "change"
	| "arena"
	| "swarm"
	| "skill-authoring"
	| "session-pickup"
	| "review"
	| "unsupported";

export const ALL_ROUTES: readonly RouteId[] = [
	"investigate",
	"change",
	"arena",
	"swarm",
	"skill-authoring",
	"session-pickup",
	"review",
	"unsupported",
] as const;

export const ROUTE_SET: ReadonlySet<string> = new Set<string>(ALL_ROUTES);

export function isRouteId(value: string): value is RouteId {
	return ROUTE_SET.has(value);
}

export type DeliveryRecommendation = "single" | "stack" | undefined;

export interface ClassifierEnvelope {
	schemaVersion: number;
	route: RouteId;
	confidence: "high" | "medium" | "low";
	rationale: string;
	/** Optional delivery mode recommendation (only meaningful for "change"). */
	delivery?: DeliveryRecommendation;
}

/** Sentinel that must wrap classifier JSON output. */
export const CLASSIFIER_SENTINEL_START = "---KSTACK-ROUTE-START---";
export const CLASSIFIER_SENTINEL_END = "---KSTACK-ROUTE-END---";

export interface RouterConfig {
	/** Classifier model configuration. */
	classifier?: {
		model: string;
		thinking?: string;
	};
	/** Classifier wall-clock timeout in seconds. */
	timeoutSeconds?: number;
}

export const DEFAULTS = {
	classifierModel: "openrouter/google/gemini-3.5-flash-lite",
	timeoutSeconds: 90,
	maxTaskBytes: 32 * 1024,
	maxRationaleChars: 500,
} as const;

export interface RouteMetadata {
	id: RouteId;
	label: string;
	description: string;
	/** Extension command or skill name required for dispatch. */
	requires?: readonly string[];
	playbookFile?: string;
}

export interface RouterArgs {
	route?: RouteId;
	delivery?: DeliveryRecommendation;
	task: string;
}

export const ALLOWED_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);