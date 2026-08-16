/** Canonical route catalog IDs and shared types for the kstack-router. */

import type { ChangeKind } from "../shared/change-kind.ts";
import type { ModelThinkingLevel } from "../shared/kstack-config.ts";

export { type ChangeKind, isChangeKind } from "../shared/change-kind.ts";

export type RouteId =
	| "investigate"
	| "change"
	| "fast-change"
	| "arena"
	| "swarm"
	| "skill-authoring"
	| "session-pickup"
	| "review"
	| "pr-autopilot"
	| "land"
	| "unsupported";

export const ALL_ROUTES: readonly RouteId[] = [
	"investigate",
	"change",
	"fast-change",
	"arena",
	"swarm",
	"skill-authoring",
	"session-pickup",
	"review",
	"pr-autopilot",
	"land",
	"unsupported",
] as const;

const ROUTE_SET: ReadonlySet<string> = new Set<string>(ALL_ROUTES);

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
	/** Optional proof-obligation category (only meaningful for "change"). */
	changeKind?: ChangeKind;
}

/** Sentinel that must wrap classifier JSON output. */
export const CLASSIFIER_SENTINEL_START = "---KSTACK-ROUTE-START---";
export const CLASSIFIER_SENTINEL_END = "---KSTACK-ROUTE-END---";

export interface RouterConfig {
	/** Classifier model configuration. */
	classifier?: {
		model: string;
		thinking?: ModelThinkingLevel;
	};
	/** Classifier wall-clock timeout in seconds. */
	timeoutSeconds?: number;
}

export const DEFAULTS = {
	classifierModel: "google-vertex/gemini-3.7-flash",
	classifierThinking: "low",
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

export type AutopilotModeFlag = "check" | "threads" | "drive" | "watch" | "cleanup";
export type LandReadinessFlag = "check" | "watch";
export type LandMethodFlag = "squash" | "rebase";

export interface RouterArgs {
	route?: RouteId;
	delivery?: DeliveryRecommendation;
	worktree?: boolean;
	changeKind?: ChangeKind;
	autopilotMode?: AutopilotModeFlag;
	prNumber?: number;
	landMethod?: LandMethodFlag;
	readiness?: LandReadinessFlag;
	task: string;
}

const ALLOWED_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Read-only handoff/archive tools (already active in the session) that the
 * session-pickup route may use in addition to ALLOWED_READ_TOOLS. The
 * intersection logic in dispatch.ts means these are never enabled when the
 * owning extension is not loaded.
 */
const SESSION_PICKUP_EXTRA_READ_TOOLS = new Set([
	"read_handoff_history",
	"search_handoff_history",
	"read_session_archive",
	"search_session_archive",
]);

/** Routes dispatched in the active session behind a read-only tool gate. */
const ACTIVE_SESSION_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
	"investigate",
	"arena",
	"swarm",
	"skill-authoring",
	"session-pickup",
]);

export function isActiveSessionRoute(route: RouteId): boolean {
	return ACTIVE_SESSION_ROUTES.has(route);
}

/** Read-only tool allowlist for a route. */
export function allowedReadToolsForRoute(route: RouteId): ReadonlySet<string> {
	return route === "session-pickup" ? SESSION_PICKUP_READ_TOOLS : ALLOWED_READ_TOOLS;
}

const SESSION_PICKUP_READ_TOOLS: ReadonlySet<string> = new Set([
	...ALLOWED_READ_TOOLS,
	...SESSION_PICKUP_EXTRA_READ_TOOLS,
]);
