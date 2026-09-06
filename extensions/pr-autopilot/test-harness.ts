import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundaryValue } from "../shared/validation.ts";
import type { DriverOps, runAutopilot } from "./driver.ts";
import type { GHPrJson } from "./github-parse.ts";
import type {
	AutopilotPersistedState,
	ExecFn,
	ExecFnResult,
	LoadedAutopilotState,
	ResolvedAutopilotConfig,
} from "./types.ts";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const MERGED_SHA = "89abcdef0123456789abcdef0123456789abcdef";
export const BRANCH = "kstack/fix-thing";
export const config: ResolvedAutopilotConfig = {
	models: [
		{ label: "model-1", model: "test/model-1", thinking: "low" },
		{ label: "model-2", model: "test/model-2", thinking: "low" },
	],
	maxConcurrency: 1,
	timeoutMinutes: 1,
	maxRuntimeMinutes: 2,
	source: "config",
	warnings: [],
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

type ReadinessObservation = Partial<Pick<GHPrJson, "state" | "isDraft" | "mergeStateStatus" | "mergeable" | "headSha">>;

interface Scenario {
	state?: GHPrJson["state"];
	mergeStateStatus?: GHPrJson["mergeStateStatus"];
	mergeable?: GHPrJson["mergeable"];
	prObservations?: ReadinessObservation[];
	failPrReadAt?: number;
	branch?: string;
	dirty?: boolean;
	checks?: Array<{ name: string; state: string; bucket: string; link?: string }>;
	thread?: { id: string; body: string };
	issueComment?: { id: number; body: string };
	triage?: string;
	fixer?: string;
	confirm?: boolean;
	fixerChanges?: boolean;
	persisted?: AutopilotPersistedState;
	loaded?: LoadedAutopilotState;
}

export interface Harness {
	cwd: string;
	calls: string[];
	roles: string[];
	models: string[];
	waits: number[];
	unexpected: string[];
	savedStates: AutopilotPersistedState[];
	exec: ExecFn;
	ops: DriverOps;
	handlers: Parameters<typeof runAutopilot>[2];
	cleanup(): Promise<void>;
}

export async function createHarness(scenario: Scenario = {}): Promise<Harness> {
	const cwd = await mkdtemp(join(tmpdir(), "kstack-driver-test-"));
	const calls: string[] = [];
	const roles: string[] = [];
	const models: string[] = [];
	const waits: number[] = [];
	const unexpected: string[] = [];
	const savedStates: AutopilotPersistedState[] = [];
	let prReads = 0;
	let statusReads = 0;
	let mergedBase = false;
	const ok = (stdout = ""): ExecFnResult => ({ code: 0, stdout, stderr: "" });
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (command === "gh" && args[0] === "pr" && args[1] === "view") {
			prReads++;
			if (scenario.failPrReadAt === prReads) {
				return { code: 1, stdout: "", stderr: "mergeability read failed" };
			}
			const observations = scenario.prObservations;
			const observation =
				observations && observations.length > 0
					? observations[Math.min(prReads - 1, observations.length - 1)]
					: undefined;
			const headSha = observation?.headSha ?? SHA;
			return ok(
				JSON.stringify({
					number: 42,
					title: "Fix the thing",
					state: observation?.state ?? scenario.state ?? "OPEN",
					isDraft: observation?.isDraft ?? false,
					mergeable: observation?.mergeable ?? scenario.mergeable ?? "true",
					mergeStateStatus: observation?.mergeStateStatus ?? scenario.mergeStateStatus ?? "CLEAN",
					headRefName: BRANCH,
					baseRefName: "main",
					headRefOid: headSha,
					commits: [{ oid: headSha }],
				}),
			);
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "ready") return ok();
		if (command === "gh" && args[0] === "repo" && args[1] === "view") return ok("owner/repo\n");
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			if (args.some((arg) => arg.includes("resolveReviewThread"))) return ok("{}");
			const comment = scenario.thread
				? {
						id: "PRRC_7",
						databaseId: 7,
						body: scenario.thread.body,
						updatedAt: "2026-09-06T00:00:00Z",
						path: "src/a.ts",
						line: 1,
						author: { login: "reviewer" },
					}
				: undefined;
			if (args.some((arg) => arg.includes("node(id: $id)"))) {
				return ok(
					JSON.stringify({
						data: {
							node:
								scenario.thread && comment
									? {
											id: scenario.thread.id,
											isResolved: false,
											comments: {
												pageInfo: { hasNextPage: false, endCursor: null },
												nodes: [comment],
											},
										}
									: null,
						},
					}),
				);
			}
			const nodes =
				scenario.thread && comment
					? [
							{
								id: scenario.thread.id,
								isResolved: false,
								comments: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [comment],
								},
							},
						]
					: [];
			return ok(
				JSON.stringify({
					data: {
						repository: {
							pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
						},
					},
				}),
			);
		}
		if (command === "gh" && args[0] === "api" && args[1]?.includes("/issues/42/comments")) {
			return ok(
				scenario.issueComment
					? JSON.stringify([
							{
								id: scenario.issueComment.id,
								user: { login: "reviewer" },
								body: scenario.issueComment.body,
								updated_at: "2026-09-06T00:00:00Z",
							},
						])
					: "[]",
			);
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "checks" && args.includes("--watch")) return ok();
		if (command === "gh" && args[0] === "pr" && args[1] === "checks") {
			return ok(JSON.stringify(scenario.checks ?? [{ name: "test", state: "SUCCESS", bucket: "pass" }]));
		}
		if (command === "gh" && args[0] === "run" && args[1] === "view") return ok("test failed\n");
		if (command === "gh" && args[0] === "run" && args[1] === "rerun") return ok();
		if (command === "git" && args[0] === "branch") return ok(`${scenario.branch ?? BRANCH}\n`);
		if (command === "git" && args[0] === "rev-parse") return ok(`${mergedBase ? MERGED_SHA : SHA}\n`);
		if (command === "git" && args[0] === "status") {
			statusReads++;
			if (scenario.dirty) return ok(" M user-work.ts\n");
			if (scenario.fixerChanges && statusReads % 2 === 0) return ok(" M src/a.ts\n");
			return ok();
		}
		if (command === "git" && args[0] === "merge") {
			mergedBase = true;
			return ok();
		}
		if (command === "git" && ["fetch", "push", "add", "commit"].includes(args[0] ?? "")) return ok();
		unexpected.push(key);
		return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
	};
	let persisted = scenario.persisted ? structuredClone(scenario.persisted) : undefined;
	let loaded = scenario.loaded ? structuredClone(scenario.loaded) : undefined;
	const ops: DriverOps = {
		loadPersistedState: async (repoKey, prNumber) =>
			loaded ?? {
				kind: "ready",
				state: persisted ?? {
					schemaVersion: 3,
					repoKey,
					prNumber,
					headSha: "",
					handled: [],
					pendingReviewReplies: [],
					legacyPendingReplyIds: [],
					flakeRetried: [],
					flakeRunRetries: [],
				},
			},
		savePersistedState: async (state) => {
			persisted = structuredClone(state);
			loaded = undefined;
			savedStates.push(structuredClone(state));
		},
		runChildRole: async (role, opts) => {
			roles.push(role);
			models.push(opts.model);
			return {
				ok: true,
				output: role === "triager" ? (scenario.triage ?? triage()) : (scenario.fixer ?? "fixed\nVERIFY_OK"),
				usage,
			};
		},
		sleep: async (delayMs, signal) => {
			waits.push(delayMs);
			signal.throwIfAborted();
		},
	};
	return {
		cwd,
		calls,
		roles,
		models,
		waits,
		unexpected,
		savedStates,
		exec,
		ops,
		handlers: {
			setPhase: () => {},
			notify: () => {},
			confirm: async () => scenario.confirm ?? true,
		},
		cleanup: () => rm(cwd, { recursive: true, force: true }),
	};
}

export function triage(options: { checks?: BoundaryValue[]; threads?: BoundaryValue[] } = {}): string {
	return JSON.stringify({
		checks: options.checks ?? [],
		threads: options.threads ?? [],
		conflicts: false,
		draft: false,
		summary: "scripted triage",
	});
}
