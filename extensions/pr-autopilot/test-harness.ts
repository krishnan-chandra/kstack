import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundaryValue } from "../shared/validation.ts";
import type { DriverOps, runAutopilot } from "./driver.ts";
import type { AutopilotPersistedState, ExecFn, ExecFnResult, ResolvedAutopilotConfig } from "./types.ts";

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

interface Scenario {
	mergeStateStatus?: "CLEAN" | "BEHIND";
	mergeable?: "true" | "false";
	branch?: string;
	dirty?: boolean;
	checks?: Array<{ name: string; state: string; bucket: string; link?: string }>;
	thread?: { id: string; body: string };
	issueComment?: { id: number; body: string };
	triage?: string;
	fixer?: string;
	confirm?: boolean;
	fixerChanges?: boolean;
}

export interface Harness {
	cwd: string;
	calls: string[];
	roles: string[];
	models: string[];
	unexpected: string[];
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
	const unexpected: string[] = [];
	let statusReads = 0;
	let mergedBase = false;
	const ok = (stdout = ""): ExecFnResult => ({ code: 0, stdout, stderr: "" });
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (command === "gh" && args[0] === "pr" && args[1] === "view") {
			return ok(
				JSON.stringify({
					number: 42,
					title: "Fix the thing",
					state: "OPEN",
					isDraft: false,
					mergeable: scenario.mergeable ?? "true",
					mergeStateStatus: scenario.mergeStateStatus ?? "CLEAN",
					headRefName: BRANCH,
					baseRefName: "main",
					headRefOid: SHA,
					commits: [{ oid: SHA }],
				}),
			);
		}
		if (command === "gh" && args[0] === "repo" && args[1] === "view") return ok("owner/repo\n");
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			const nodes = scenario.thread
				? [
						{
							id: scenario.thread.id,
							isResolved: false,
							comments: {
								nodes: [
									{
										databaseId: 7,
										body: scenario.thread.body,
										path: "src/a.ts",
										line: 1,
										author: { login: "reviewer" },
									},
								],
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
							{ id: scenario.issueComment.id, user: { login: "reviewer" }, body: scenario.issueComment.body },
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
	let persisted: AutopilotPersistedState | undefined;
	const ops: DriverOps = {
		loadPersistedState: async (repoKey, prNumber) =>
			persisted ?? {
				repoKey,
				prNumber,
				headSha: "",
				handledThreadIds: [],
				repliedThreadIds: [],
				flakeRetried: [],
			},
		savePersistedState: async (state) => {
			persisted = structuredClone(state);
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
	};
	return {
		cwd,
		calls,
		roles,
		models,
		unexpected,
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
