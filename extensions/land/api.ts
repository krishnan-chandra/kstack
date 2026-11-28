import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMergeMethod, type MergeMethod } from "../shared/github.ts";
import { isRepositoryName } from "../shared/github-repository.ts";
import { createRequestChannel } from "../shared/request-channel.ts";
import { type BoundaryValue, isNumber, isObject, isString } from "../shared/validation.ts";
import type { DelegatedFrontierResponse } from "./frontier-settlement.ts";
import type { LandOptions, LandResult } from "./types.ts";

// Public in-process access to Land's per-repository merge policy.
export { getRepoMethod, loadLandConfig } from "./config.ts";
export { applyDelegatedFrontierSettlement, type DelegatedFrontierResponse } from "./frontier-settlement.ts";

export const LAND_REQUEST_EVENT = "kstack:land:request";
const READINESS_MODES = new Set<unknown>(["check", "watch"]);
const HEAD_SHA = /^[0-9a-f]{40}$/;

export interface StackFrontierLandRequest {
	kind: "stack-frontier";
	options: LandOptions & { method: MergeMethod };
	expectedHeadSha: string;
	expectedBaseRef: string;
	repository?: string;
	signal?: AbortSignal;
	ctx: ExtensionContext;
}

function isOptions(value: BoundaryValue): value is LandOptions & { method: MergeMethod } {
	if (
		!isObject(value) ||
		value === null ||
		Object.keys(value).some((key) => key !== "target" && key !== "readiness" && key !== "method" && key !== "cwd")
	) {
		return false;
	}
	if ("cwd" in value && value.cwd !== undefined && (!isString(value.cwd) || value.cwd.length === 0)) return false;
	if (!("readiness" in value) || !READINESS_MODES.has(value.readiness)) return false;
	if (!("method" in value) || !isMergeMethod(value.method)) return false;
	if (!("target" in value) || !isObject(value.target) || value.target === null) return false;
	const target = value.target;
	return (
		Object.keys(target).every((key) => key === "kind" || key === "prNumber") &&
		"kind" in target &&
		target.kind === "single" &&
		"prNumber" in target &&
		isNumber(target.prNumber) &&
		Number.isSafeInteger(target.prNumber) &&
		target.prNumber > 0
	);
}

function isValidBaseRef(value: BoundaryValue): value is string {
	if (!isString(value) || value.length === 0 || value.length > 256) return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 32 || code === 127) return false;
	}
	return true;
}

const channel = createRequestChannel<StackFrontierLandRequest, LandResult, 2>({
	event: LAND_REQUEST_EVENT,
	schemaVersion: 2,
	isPayload: (value): value is StackFrontierLandRequest => {
		if (!isObject(value) || value === null || !("kind" in value) || !("options" in value) || !("ctx" in value)) {
			return false;
		}
		if (!isObject(value.ctx) || value.ctx === null || value.kind !== "stack-frontier") return false;
		return (
			Object.keys(value).every(
				(key) =>
					key === "kind" ||
					key === "options" ||
					key === "expectedHeadSha" ||
					key === "expectedBaseRef" ||
					key === "repository" ||
					key === "signal" ||
					key === "ctx",
			) &&
			isOptions(value.options) &&
			"expectedHeadSha" in value &&
			isString(value.expectedHeadSha) &&
			HEAD_SHA.test(value.expectedHeadSha) &&
			"expectedBaseRef" in value &&
			isValidBaseRef(value.expectedBaseRef) &&
			(!("repository" in value) || value.repository === undefined || isRepositoryName(value.repository)) &&
			(!("signal" in value) || value.signal === undefined || value.signal instanceof AbortSignal)
		);
	},
});

export function claimLandRequest(
	value: BoundaryValue,
	run: (request: StackFrontierLandRequest) => Promise<LandResult>,
): boolean {
	return channel.claim(value, run);
}

export function requestStackFrontierLand(
	pi: ExtensionAPI,
	request: Omit<StackFrontierLandRequest, "kind">,
): Promise<DelegatedFrontierResponse> {
	return channel.request(pi, { kind: "stack-frontier", ...request });
}
