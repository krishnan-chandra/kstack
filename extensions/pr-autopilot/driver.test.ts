import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VcsBackend } from "../shared/vcs/backend.ts";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import { applyThreadReplies, parseTriage } from "./autopilot-operations.ts";
import { type DriverOps, runAutopilot } from "./driver.ts";
import type {
	AutopilotPersistedState,
	ExecFn,
	ExecFnResult,
	PRState,
	ResolvedAutopilotConfig,
	ReviewThread,
} from "./types.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGED_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const BRANCH = "kstack/fix-thing";
const config: ResolvedAutopilotConfig = {
	models: [
		{ label: "tiny-1", model: "test/tiny-1", thinking: "low" },
		{ label: "tiny-2", model: "test/tiny-2", thinking: "low" },
	],
	maxConcurrency: 1,
	timeoutMinutes: 1,
	maxRuntimeMinutes: 2,
	source: "config",
	warnings: [],
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

interface Scenario {
	mergeStateStatus?: "CLEAN" | "BEHIND";
	mergeable?: "true" | "false";
	branch?: string;
	dirty?: boolean;
	checks?: Array<{ name: string; state: string; bucket: string }>;
	thread?: { id: string; body: string };
	triage?: string;
	fixer?: string;
	confirm?: boolean;
	fixerChanges?: boolean;
}

interface Harness {
	cwd: string;
	calls: string[];
	roles: string[];
	models: string[];
	unexpected: string[];
	exec: ExecFn;
	ops: DriverOps;
	handlers: {
		setPhase: () => void;
		notify: () => void;
		confirm: () => Promise<boolean>;
	};
	cleanup(): Promise<void>;
}

async function createHarness(scenario: Scenario = {}): Promise<Harness> {
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
		if (command === "gh" && args[0] === "api" && args[1]?.includes("/issues/42/comments")) return ok("[]");
		if (command === "gh" && args[0] === "pr" && args[1] === "checks" && args.includes("--watch")) return ok();
		if (command === "gh" && args[0] === "pr" && args[1] === "checks") {
			return ok(JSON.stringify(scenario.checks ?? [{ name: "test", state: "SUCCESS", bucket: "pass" }]));
		}
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

function triage(options: { checks?: unknown[]; threads?: unknown[] } = {}): string {
	return JSON.stringify({
		checks: options.checks ?? [],
		threads: options.threads ?? [],
		conflicts: false,
		draft: false,
		summary: "scripted triage",
	});
}

async function run(mode: "check" | "drive", scenario: Scenario = {}) {
	const harness = await createHarness(scenario);
	const result = await runAutopilot(
		mode,
		{
			config,
			exec: harness.exec,
			backend: new GitBackend(harness.exec),
			cwd: harness.cwd,
			explicitPR: 42,
			promptDir: harness.cwd,
			triagerPromptFile: join(harness.cwd, "triager.md"),
			fixerPromptFile: join(harness.cwd, "fixer.md"),
		},
		harness.handlers,
		new AbortController().signal,
		harness.ops,
	);
	assert.deepEqual(harness.unexpected, []);
	return { harness, result };
}

function mutatingCalls(calls: string[]): string[] {
	return calls.filter(
		(call) =>
			/^(git (add|commit|push))/.test(call) ||
			(call.startsWith("gh api ") && (call.includes("--method POST") || call.includes("resolveReviewThread"))),
	);
}

test("check mode performs two fresh reads and never mutates", async (t) => {
	const { harness, result } = await run("check");
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 2);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("dirty worktree blocks the fixer before any mutation", async (t) => {
	const { harness, result } = await run("drive", {
		dirty: true,
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ name: "test", cls: "code", action: "fix test" }] }),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.match(result.blockedReasons[0] ?? "", /clean/);
	assert.deepEqual(harness.roles, ["triager"], "the fixer must never run against an unvalidated workspace");
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("branch mismatch identifies the expected and actual branches", async (t) => {
	const { harness, result } = await run("drive", {
		branch: "kstack/other",
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ name: "test", cls: "code", action: "fix test" }] }),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.match(result.blockedReasons[0] ?? "", /kstack\/fix-thing/);
	assert.match(result.blockedReasons[0] ?? "", /kstack\/other/);
	assert.deepEqual(harness.roles, ["triager"]);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("a merge-ready readiness pass never validates the PR workspace", async (t) => {
	const { harness, result } = await run("drive", { branch: "kstack/other" });
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("watching pending checks does not require the PR workspace", async (t) => {
	const { harness, result } = await run("drive", {
		branch: "kstack/other",
		checks: [{ name: "test", state: "PENDING", bucket: "pending" }],
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.ok(result.blockedReasons.includes("CI still pending after watch"));
	assert.ok(result.blockedCodes?.includes("ci-pending-after-watch"));
	assert.equal(
		result.blockedReasons.some((reason) => reason.includes("kstack/other")),
		false,
		"a readiness-only pass must not fail on workstream selection",
	);
	assert.deepEqual(harness.roles, []);
});

test("a behind PR merges its base and pushes", async (t) => {
	const { harness, result } = await run("drive", { mergeStateStatus: "BEHIND" });
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.ok(harness.calls.some((call) => call === "git fetch origin main"));
	assert.ok(harness.calls.some((call) => call === "git merge --no-edit origin/main"));
	assert.ok(harness.calls.some((call) => call === `git push origin HEAD:${BRANCH}`));
});

test("ask threads block without invoking a fixer", async (t) => {
	const { harness, result } = await run("drive", {
		thread: { id: "thread-1", body: "Please explain this design" },
		triage: triage({ threads: [{ id: "thread-1", decision: "ask", cls: "code", action: "Need a product decision" }] }),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.ok(result.blockedReasons.includes("ask threads: thread-1"));
	assert.deepEqual(harness.roles, ["triager"]);
});

test("VERIFY_FAIL from a fixer is never pushed", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ name: "test", cls: "code", action: "fix test" }] }),
		fixer: "changed code\nVERIFY_FAIL",
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.equal(result.mergeReady, false);
	assert.ok(result.blockedReasons.some((reason) => reason.includes("VERIFY_FAIL")));
	assert.equal(
		harness.calls.some((call) => call.startsWith("git push")),
		false,
	);
});

test("declining a fix push returns incomplete", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ name: "test", cls: "code", action: "fix test" }] }),
		confirm: false,
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.deepEqual(result.blockedReasons, ["push not confirmed"]);
	assert.equal(
		harness.calls.some((call) => call.startsWith("git push")),
		false,
	);
});

test("triager and fixer use the same randomly chosen model", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ name: "test", cls: "code", action: "fix test" }] }),
		confirm: false,
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.deepEqual(harness.roles, ["triager", "fixer"]);
	assert.equal(harness.models.length, 2);
	assert.equal(harness.models[0], harness.models[1]);
	assert.ok(config.models.some((model) => model.model === harness.models[0]));
});

test("drive mode stops at its configured cycle bound", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ name: "test", cls: "code", action: "fix test" }] }),
		fixerChanges: true,
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.equal(result.cyclesCompleted, 3);
	assert.ok(result.blockedReasons.some((reason) => reason.includes("max cycles reached")));
	assert.equal(harness.roles.filter((role) => role === "fixer").length, 3);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh repo view")).length, 1);
});

test("pending checks use the watch path without triage", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [{ name: "test", state: "PENDING", bucket: "pending" }],
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.ok(result.blockedReasons.includes("CI still pending after watch"));
	assert.ok(result.blockedCodes?.includes("ci-pending-after-watch"));
	assert.ok(harness.calls.some((call) => call.includes("gh pr checks 42 --watch")));
	assert.deepEqual(harness.roles, []);
});

test("cleanup mode never resolves the repository", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "kstack-driver-cleanup-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const calls: string[] = [];
	const exec: ExecFn = async (command, args) => {
		calls.push(`${command} ${args.join(" ")}`);
		return { code: 0, stdout: "", stderr: "" };
	};
	const backend = {
		id: "jj",
		preflight: async () => ({ ok: true, workspaceRoot: cwd }),
	} as unknown as VcsBackend;
	const result = await runAutopilot(
		"cleanup",
		{
			config,
			exec,
			backend,
			cwd,
			explicitPR: 42,
			promptDir: cwd,
			triagerPromptFile: join(cwd, "triager.md"),
			fixerPromptFile: join(cwd, "fixer.md"),
		},
		{ setPhase: () => {}, notify: () => {}, confirm: async () => true },
		new AbortController().signal,
	);
	assert.equal(result.status, "cleaned");
	assert.deepEqual(calls, []);
});

function makeThreadState(threads: ReviewThread[]): PRState {
	return {
		number: 42,
		title: "Fix the thing",
		state: "open",
		isDraft: false,
		headSha: SHA,
		verifiedHeadSha: null,
		baseRef: "main",
		headRef: BRANCH,
		mergeable: "mergeable",
		mergeStateStatus: "CLEAN",
		checks: [],
		threads,
		hasUnresolvedThreads: threads.length > 0,
	};
}

function makeReplyExec(overrides: { replyCode?: number; resolveCode?: number; issueReplyCode?: number } = {}): {
	exec: ExecFn;
	calls: string[];
} {
	const calls: string[] = [];
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((a) => a.startsWith("id="))) {
			const code = overrides.resolveCode ?? 0;
			return { code, stdout: "", stderr: code === 0 ? "" : "resolve failed" };
		}
		if (command === "gh" && args[0] === "api" && args[1]?.includes("/pulls/42/comments")) {
			const code = overrides.replyCode ?? 0;
			return { code, stdout: "", stderr: code === 0 ? "" : "reply failed" };
		}
		if (command === "gh" && args[0] === "pr" && args[1] === "comment") {
			const code = overrides.issueReplyCode ?? 0;
			return { code, stdout: "", stderr: code === 0 ? "" : "comment failed" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
	};
	return { exec, calls };
}

function parseThreads(json: string) {
	const parsed = parseTriage(json);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

test("fix decision replies and resolves a review thread", async () => {
	const state = makeThreadState([
		{
			id: "thread-1",
			commenter: "reviewer",
			body: "rename this",
			path: "src/a.ts",
			line: 1,
			replyToId: 7,
			source: "review-thread",
		},
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [{ id: "thread-1", decision: "fix", cls: "code", action: "rename", reply: "Renamed." }],
			conflicts: false,
			draft: false,
			summary: "",
		}),
	);
	const { exec, calls } = makeReplyExec();
	const repliedThreadIds: string[] = [];
	const handled = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		{ resolveFix: true, repliedThreadIds },
		() => {},
	);
	assert.deepEqual(handled, ["thread-1"]);
	assert.deepEqual(repliedThreadIds, ["thread-1"]);
	assert.ok(calls.some((call) => call.startsWith("gh api repos/{owner}/{repo}/pulls/42/comments")));
	assert.ok(calls.some((call) => call.startsWith("gh api graphql") && call.includes("id=thread-1")));
});

test("dismiss decision replies to an issue comment without resolving", async () => {
	const state = makeThreadState([
		{ id: "issue-comment-1", commenter: "reviewer", body: "remove this", source: "issue-comment", replyToId: 1 },
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [{ id: "issue-comment-1", decision: "dismiss", action: "out of scope", reply: "" }],
			conflicts: false,
			draft: false,
			summary: "",
		}),
	);
	const { exec, calls } = makeReplyExec();
	const handled = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		{ resolveFix: false, repliedThreadIds: [] },
		() => {},
	);
	assert.deepEqual(handled, ["issue-comment-1"]);
	assert.ok(calls.some((call) => call.startsWith("gh pr comment 42") && call.includes("Dismissing: out of scope")));
	assert.equal(
		calls.some((call) => call.startsWith("gh api graphql") && call.includes("id=")),
		false,
	);
});

test("failed review-thread reply does not resolve and warns", async () => {
	const state = makeThreadState([
		{
			id: "thread-1",
			commenter: "reviewer",
			body: "rename this",
			path: "src/a.ts",
			line: 1,
			replyToId: 7,
			source: "review-thread",
		},
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [{ id: "thread-1", decision: "fix", cls: "code", action: "rename", reply: "Renamed." }],
			conflicts: false,
			draft: false,
			summary: "",
		}),
	);
	const { exec } = makeReplyExec({ replyCode: 1 });
	const warnings: string[] = [];
	const repliedThreadIds: string[] = [];
	const handled = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		{ resolveFix: true, repliedThreadIds },
		(message) => warnings.push(message),
	);
	assert.deepEqual(handled, []);
	assert.deepEqual(repliedThreadIds, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /Could not reply to thread thread-1/);
});

test("failed resolve keeps the reply id but not the handled id", async () => {
	const state = makeThreadState([
		{
			id: "thread-1",
			commenter: "reviewer",
			body: "rename this",
			path: "src/a.ts",
			line: 1,
			replyToId: 7,
			source: "review-thread",
		},
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [{ id: "thread-1", decision: "fix", cls: "code", action: "rename", reply: "Renamed." }],
			conflicts: false,
			draft: false,
			summary: "",
		}),
	);
	const { exec } = makeReplyExec({ resolveCode: 1 });
	const repliedThreadIds: string[] = [];
	const handled = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		{ resolveFix: true, repliedThreadIds },
		() => {},
	);
	assert.deepEqual(handled, []);
	assert.deepEqual(repliedThreadIds, ["thread-1"]);
});
