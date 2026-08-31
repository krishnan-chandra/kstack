/** Validated adapter for GitHub's public-preview native Stacks surface. */

import type { BoundaryValue, JsonObject } from "../shared/validation.ts";
import { isBoolean, isNumber, isObject, isString } from "../shared/validation.ts";
import type { ProcessRunner } from "./process.ts";
import type { GitHubRepository, StackMergeMethod } from "./types.ts";

const GH_STACK_MIN_VERSION = { major: 0, minor: 1, patch: 0 } as const;
const GH_TIMEOUT_MS = 30_000;
const GH_MERGE_TIMEOUT_MS = 30 * 60_000;
const MAX_NATIVE_STACK_PRS = 100;

interface NativeStackPullRequest {
	number: number;
	state: "open" | "closed";
	draft: boolean;
	mergedAt?: string;
	head: { ref: string; sha: string };
}

export interface NativeStack {
	stackNumber: number;
	baseRef: string;
	baseSha?: string;
	open: boolean;
	pullRequests: readonly NativeStackPullRequest[];
}

type NativeStackCapability = { status: "available"; version: string } | { status: "unavailable"; reason: string };

type NativeStackMergeResult =
	| { status: "merged"; stack: NativeStack }
	| { status: "enqueued"; stack: NativeStack }
	| { status: "failed"; error: string }
	| { status: "indeterminate"; error: string };

export interface NativeStackGateway {
	preflight(input: { cwd: string; repo: GitHubRepository; signal?: AbortSignal }): Promise<NativeStackCapability>;
	baseUsesMergeQueue(input: {
		cwd: string;
		repo: GitHubRepository;
		base: string;
		signal?: AbortSignal;
	}): Promise<boolean>;
	inspectForPullRequest(input: {
		cwd: string;
		repo: GitHubRepository;
		prNumber: number;
		signal?: AbortSignal;
	}): Promise<NativeStack | undefined>;
	link(input: {
		cwd: string;
		repo: GitHubRepository;
		base: string;
		prNumbers: readonly number[];
		signal?: AbortSignal;
	}): Promise<NativeStack>;
	mergeThrough(input: {
		cwd: string;
		repo: GitHubRepository;
		prNumber: number;
		method: StackMergeMethod;
		signal?: AbortSignal;
	}): Promise<NativeStackMergeResult>;
}

export class NativeStackError extends Error {
	readonly kind: "failed" | "indeterminate" | "unavailable";

	constructor(message: string, kind: "failed" | "indeterminate" | "unavailable" = "failed") {
		super(message);
		this.name = "NativeStackError";
		this.kind = kind;
	}
}

export function resolveNativeStackGateway(
	run: ProcessRunner,
	configured: NativeStackGateway | false | undefined,
): NativeStackGateway | undefined {
	if (configured === false) return undefined;
	return configured ?? createNativeStackGateway(run);
}

export function createNativeStackGateway(run: ProcessRunner): NativeStackGateway {
	async function inspect(input: {
		cwd: string;
		repo: GitHubRepository;
		prNumber: number;
		signal?: AbortSignal;
	}): Promise<NativeStack | undefined> {
		const path = `repos/${input.repo.owner}/${input.repo.repo}/stacks?pull_request=${input.prNumber}`;
		const result = await command(run, ["gh", "api", path], input.cwd, input.signal);
		let value: BoundaryValue;
		try {
			value = JSON.parse(result.stdout);
		} catch {
			throw new NativeStackError("GitHub returned malformed native stack JSON.");
		}
		if (!Array.isArray(value)) throw new NativeStackError("GitHub native stack response was not an array.");
		if (value.length === 0) return undefined;
		if (value.length !== 1) {
			throw new NativeStackError(`PR #${input.prNumber} belongs to multiple native stacks.`);
		}
		return parseNativeStack(value[0]);
	}

	return {
		async baseUsesMergeQueue(input) {
			const query =
				"query($owner:String!,$name:String!,$branch:String!,$qualified:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id} ref(qualifiedName:$qualified){rules(first:50){nodes{type}}}}}";
			const result = await command(
				run,
				[
					"gh",
					"api",
					"graphql",
					"-f",
					`query=${query}`,
					"-F",
					`owner=${input.repo.owner}`,
					"-F",
					`name=${input.repo.repo}`,
					"-F",
					`branch=${input.base}`,
					"-F",
					`qualified=refs/heads/${input.base}`,
				],
				input.cwd,
				input.signal,
			);
			let value: BoundaryValue;
			try {
				value = JSON.parse(result.stdout);
			} catch {
				throw new NativeStackError("GitHub returned malformed merge-queue JSON.");
			}
			const root = requireObject(value, "merge-queue response");
			const data = requireObject(root.data, "merge-queue response.data");
			const repository = requireObject(data.repository, "merge-queue response.data.repository");
			if (repository.mergeQueue !== null && repository.mergeQueue !== undefined) return true;
			if (repository.ref === null || repository.ref === undefined) return false;
			const ref = requireObject(repository.ref, "repository.ref");
			const rules = requireObject(ref.rules, "repository.ref.rules");
			if (!Array.isArray(rules.nodes)) throw new NativeStackError("repository.ref.rules.nodes must be an array.");
			return rules.nodes.some((node) => {
				const rule = requireObject(node, "repository rule");
				return rule.type === "MERGE_QUEUE";
			});
		},
		async preflight(input) {
			const versionResult = await run(["gh", "stack", "--version"], {
				cwd: input.cwd,
				timeoutMs: GH_TIMEOUT_MS,
				signal: input.signal,
			});
			if (versionResult.kind !== "ok") {
				return { status: "unavailable", reason: resultMessage(versionResult) };
			}
			const version = parseVersion(versionResult.stdout);
			if (!version || compareVersion(version, GH_STACK_MIN_VERSION) < 0) {
				return {
					status: "unavailable",
					reason: `gh-stack 0.1.0 or newer is required; received ${versionResult.stdout.trim() || "unknown version"}.`,
				};
			}
			const probe = await run(["gh", "api", `repos/${input.repo.owner}/${input.repo.repo}/stacks?per_page=1`], {
				cwd: input.cwd,
				timeoutMs: GH_TIMEOUT_MS,
				signal: input.signal,
			});
			if (probe.kind !== "ok") {
				return { status: "unavailable", reason: resultMessage(probe) };
			}
			return { status: "available", version: `${version.major}.${version.minor}.${version.patch}` };
		},
		inspectForPullRequest: inspect,
		async link(input) {
			validatePrNumbers(input.prNumbers, 2);
			const args = ["gh", "stack", "link", "--base", input.base, ...input.prNumbers.map(String)];
			let commandError: NativeStackError | undefined;
			try {
				await command(run, args, input.cwd, input.signal);
			} catch (error) {
				if (!(error instanceof NativeStackError) || error.kind !== "indeterminate") throw error;
				commandError = error;
			}
			const linked = await inspect({ ...input, prNumber: input.prNumbers[0] });
			if (!linked && commandError) throw commandError;
			if (!linked) throw new NativeStackError("gh stack link completed, but no native stack membership was found.");
			const actual = linked.pullRequests.map((pr) => pr.number);
			if (!samePrNumbers(actual, input.prNumbers) || linked.baseRef !== input.base) {
				throw new NativeStackError(
					`Native stack verification failed: expected ${input.prNumbers.join(", ")} on ${input.base}; received ${actual.join(", ")} on ${linked.baseRef}.`,
				);
			}
			return linked;
		},
		async mergeThrough(input) {
			const result = await run(["gh", "stack", "merge", String(input.prNumber), "--yes", `--${input.method}`], {
				cwd: input.cwd,
				timeoutMs: GH_MERGE_TIMEOUT_MS,
				signal: input.signal,
			});
			const existingRequest = result.kind === "nonzero" && /merge request already exists/i.test(resultMessage(result));
			if (result.kind !== "ok" && !isIndeterminateResult(result) && !existingRequest) {
				return { status: "failed", error: resultMessage(result) };
			}
			const after = await inspect(input);
			if (!after) {
				return {
					status: "indeterminate",
					error: "Stack merge completed, but native membership could not be verified.",
				};
			}
			const targetIndex = after.pullRequests.findIndex((pr) => pr.number === input.prNumber);
			if (targetIndex < 0)
				return { status: "indeterminate", error: "Merged target disappeared from its native stack." };
			const prefix = after.pullRequests.slice(0, targetIndex + 1);
			if (prefix.every((pr) => pr.mergedAt)) return { status: "merged", stack: after };
			if (result.kind === "ok" || existingRequest) return { status: "enqueued", stack: after };
			return { status: "indeterminate", error: resultMessage(result) };
		},
	};
}

function parseNativeStack(value: BoundaryValue): NativeStack {
	const object = requireObject(value, "stack");
	const stackNumber = requirePositiveInteger(object.number, "stack.number");
	const base = requireObject(object.base, "stack.base");
	const baseRef = requireString(base.ref, "stack.base.ref");
	const baseSha = base.sha === undefined ? undefined : requireString(base.sha, "stack.base.sha");
	if (!isBoolean(object.open)) throw new NativeStackError("stack.open must be a boolean.");
	if (!Array.isArray(object.pull_requests)) throw new NativeStackError("stack.pull_requests must be an array.");
	if (object.pull_requests.length === 0 || object.pull_requests.length > MAX_NATIVE_STACK_PRS) {
		throw new NativeStackError(`stack.pull_requests must contain 1..${MAX_NATIVE_STACK_PRS} entries.`);
	}
	const pullRequests = object.pull_requests.map((entry, index) => parseNativePr(entry, index));
	const unique = new Set(pullRequests.map((pr) => pr.number));
	if (unique.size !== pullRequests.length) throw new NativeStackError("stack.pull_requests contains duplicate PRs.");
	return {
		stackNumber,
		baseRef,
		...(baseSha === undefined ? undefined : { baseSha }),
		open: object.open,
		pullRequests,
	};
}

function parseNativePr(value: BoundaryValue, index: number): NativeStackPullRequest {
	const object = requireObject(value, `stack.pull_requests[${index}]`);
	const number = requirePositiveInteger(object.number, `stack.pull_requests[${index}].number`);
	if (object.state !== "open" && object.state !== "closed") {
		throw new NativeStackError(`stack.pull_requests[${index}].state is invalid.`);
	}
	if (!isBoolean(object.draft)) throw new NativeStackError(`stack.pull_requests[${index}].draft is invalid.`);
	const head = requireObject(object.head, `stack.pull_requests[${index}].head`);
	const mergedAt = object.merged_at === null ? undefined : requireString(object.merged_at, "merged_at");
	return {
		number,
		state: object.state,
		draft: object.draft,
		mergedAt,
		head: { ref: requireString(head.ref, "head.ref"), sha: requireString(head.sha, "head.sha") },
	};
}

async function command(
	run: ProcessRunner,
	argv: readonly string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<Extract<Awaited<ReturnType<ProcessRunner>>, { kind: "ok" }>> {
	const result = await run(argv, { cwd, timeoutMs: GH_TIMEOUT_MS, signal });
	if (result.kind === "ok") return result;
	throw new NativeStackError(resultMessage(result), isIndeterminateResult(result) ? "indeterminate" : "failed");
}

function requireObject(value: BoundaryValue, label: string): JsonObject {
	if (!isObject(value) || Array.isArray(value)) throw new NativeStackError(`${label} must be an object.`);
	/* SAFETY: Every property is read through validating boundary helpers. */
	return value as JsonObject;
}

function requireString(value: BoundaryValue | undefined, label: string): string {
	if (!isString(value) || value.length === 0) throw new NativeStackError(`${label} must be a non-empty string.`);
	return value;
}

function requirePositiveInteger(value: BoundaryValue | undefined, label: string): number {
	if (!isNumber(value) || !Number.isSafeInteger(value) || value < 1) {
		throw new NativeStackError(`${label} must be a positive integer.`);
	}
	return value;
}

function validatePrNumbers(numbers: readonly number[], minimum: number): void {
	if (numbers.length < minimum || numbers.length > MAX_NATIVE_STACK_PRS) {
		throw new NativeStackError(`Native stacks require ${minimum}..${MAX_NATIVE_STACK_PRS} PRs.`);
	}
	if (numbers.some((number) => !Number.isSafeInteger(number) || number < 1)) {
		throw new NativeStackError("Native stack PR numbers must be positive integers.");
	}
	if (new Set(numbers).size !== numbers.length) throw new NativeStackError("Native stack PR numbers must be unique.");
}

function parseVersion(text: string): { major: number; minor: number; patch: number } | undefined {
	const match = text.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersion(
	left: { major: number; minor: number; patch: number },
	right: { major: number; minor: number; patch: number },
): number {
	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	return left.patch - right.patch;
}

export function samePrNumbers(left: readonly number[], right: readonly number[]): boolean {
	return left.length === right.length && left.every((number, index) => number === right[index]);
}

function isIndeterminateResult(result: Awaited<ReturnType<ProcessRunner>>): boolean {
	return result.kind === "timeout" || result.kind === "cancelled" || result.kind === "uncertain";
}

type FailedCommandResult = Exclude<Awaited<ReturnType<ProcessRunner>>, { kind: "ok" }>;

function resultMessage(result: FailedCommandResult): string {
	return result.message;
}
