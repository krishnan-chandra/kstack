import assert from "node:assert/strict";
import test from "node:test";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import { issueLandConfirmation } from "./confirmation.ts";
import { runLand } from "./orchestrator.ts";
import type { ExecFn, ExecResult, MergeMethod } from "./types.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const repo = JSON.stringify({
	nameWithOwner: "o/r",
	defaultBranchRef: { name: "main" },
	squashMergeAllowed: true,
	rebaseMergeAllowed: false,
});
function pr(sha: string, state = "OPEN", isDraft = false, headRefName = "feature"): string {
	return JSON.stringify({
		number: 7,
		url: "https://github.com/o/r/pull/7",
		title: "x",
		state,
		isDraft,
		headRefName,
		baseRefName: "main",
		headRefOid: sha,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		mergedAt: state === "MERGED" ? "2026-01-01" : null,
		mergeCommit: state === "MERGED" ? { oid: "c".repeat(40) } : null,
	});
}
function ready(sha: string): AutopilotResult {
	return {
		status: "merge-ready",
		mergeReady: true,
		cyclesCompleted: 1,
		blockedReasons: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		prState: {
			number: 7,
			title: "x",
			state: "open",
			isDraft: false,
			headSha: sha,
			verifiedHeadSha: sha,
			baseRef: "main",
			headRef: "feature",
			mergeable: "mergeable",
			mergeStateStatus: "CLEAN",
			checks: [],
			threads: [],
			hasUnresolvedThreads: false,
		},
	};
}
function deps(exec: ExecFn, outcome = ready(NEW)) {
	const controller = new AbortController();
	return {
		exec,
		cwd: "/repo",
		signal: controller.signal,
		runAutopilot: async () => ({ handled: true as const, outcome }),
		selectMethod: async () => "squash" as const,
		confirmMerge: async () => true,
		now: () => 0,
		sleep: async () => {},
	};
}

test("pending CI after watch gives an actionable retry path", async () => {
	const pending: AutopilotResult = {
		status: "blocked",
		mergeReady: false,
		cyclesCompleted: 1,
		blockedReasons: ["Checks remain pending after the bounded watch"],
		blockedCodes: ["ci-pending-after-watch"],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
	const result = await runLand(
		{ target: { kind: "single", prNumber: 7 }, readiness: "watch", method: "squash" },
		deps(
			async (_command, args) =>
				args[0] === "repo" ? { code: 0, stdout: repo, stderr: "" } : { code: 0, stdout: pr(OLD), stderr: "" },
			pending,
		),
	);
	assert.equal(result.status, "blocked");
	assert.match(result.blockers.join("\n"), /Watch is bounded.*inspect PR #7.*retry \/land after CI settles/i);
});

test("lets autopilot transition an initially draft PR to ready", async () => {
	let views = 0;
	let autopilotRan = false;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			return {
				code: 0,
				stdout: current === 0 ? pr(OLD, "OPEN", true) : current < 3 ? pr(NEW) : pr(NEW, "MERGED"),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runDeps = {
		...deps(exec),
		runAutopilot: async () => {
			autopilotRan = true;
			return { handled: true as const, outcome: ready(NEW) };
		},
	};
	const result = await runLand(
		{ target: { kind: "single", prNumber: 7 }, readiness: "watch", method: "squash" },
		runDeps,
	);
	assert.equal(autopilotRan, true);
	assert.equal(result.status, "landed");
});

test("watch mode adopts the freshly verified autopilot head", async () => {
	const calls: string[][] = [];
	let views = 0;
	const exec: ExecFn = async (_command, args): Promise<ExecResult> => {
		calls.push(args);
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			return { code: 0, stdout: current === 0 ? pr(OLD) : current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const result = await runLand(
		{ target: { kind: "single", prNumber: 7 }, readiness: "watch", method: "squash" },
		deps(exec),
	);
	assert.equal(result.status, "landed");
	assert.ok(calls.some((args) => args.includes(NEW) && args.includes("--match-head-commit")));
});

test("preserves accepted mutation when verification throws", async () => {
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (views++ < 3) return { code: 0, stdout: pr(NEW), stderr: "" };
		throw new Error("network down");
	};
	const result = await runLand(
		{ target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash" },
		deps(exec),
	);
	assert.equal(result.status, "partially-landed");
	assert.equal(result.frontiers[0]?.state, "queued");
	assert.match(result.completedMutations.join("\n"), /accepted merge\/queue/);
	assert.match(result.blockers.join("\n"), /network down/);
});

test("reports partial landing when polling is aborted after acceptance", async () => {
	const controller = new AbortController();
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") {
			controller.abort();
			return { code: 0, stdout: "", stderr: "" };
		}
		if (views++ < 3) return { code: 0, stdout: pr(NEW), stderr: "" };
		throw new Error("aborted");
	};
	const runDeps = { ...deps(exec), signal: controller.signal };
	const result = await runLand(
		{ target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash" },
		runDeps,
	);
	assert.equal(result.status, "partially-landed");
	assert.match(result.completedMutations.join("\n"), /accepted merge\/queue/);
	assert.match(result.blockers.join("\n"), /aborted after GitHub accepted/);
});

test("configured method skips selectMethod and confirmMerge when no CLI --method", async () => {
	let selectMethodCalled = false;
	let confirmMergeCalled = false;
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			// views: 0=initial, 1=ready, 2=revalidate (skip confirm), 3=waitForMerge
			return { code: 0, stdout: current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runDeps = {
		...deps(exec),
		configuredMethodFor: () => "squash" as const,
		selectMethod: async (): Promise<MergeMethod | undefined> => {
			selectMethodCalled = true;
			return "squash";
		},
		confirmMerge: async (): Promise<boolean> => {
			confirmMergeCalled = true;
			return true;
		},
	};
	const result = await runLand({ target: { kind: "single", prNumber: 7 }, readiness: "check" }, runDeps);
	assert.equal(result.status, "landed");
	assert.equal(selectMethodCalled, false, "selectMethod should not be called with configured method");
	assert.equal(confirmMergeCalled, false, "confirmMerge should not be called with configured method");
});

test("CLI --method takes priority over configured method and still confirms", async () => {
	let selectMethodCalled = false;
	let confirmMergeCalled = false;
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			// views: 0=initial, 1=ready, 2=revalidate (confirm shown), 3=waitForMerge
			return { code: 0, stdout: current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runDeps = {
		...deps(exec),
		configuredMethodFor: () => "squash" as const,
		selectMethod: async (): Promise<MergeMethod | undefined> => {
			selectMethodCalled = true;
			return "squash";
		},
		confirmMerge: async (): Promise<boolean> => {
			confirmMergeCalled = true;
			return true;
		},
	};
	const result = await runLand(
		{ target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash" },
		runDeps,
	);
	assert.equal(result.status, "landed");
	assert.equal(selectMethodCalled, false, "selectMethod should not be called when CLI --method is set");
	assert.equal(confirmMergeCalled, true, "confirmMerge should be called when CLI --method is set");
});

test("minted confirmation skips confirmMerge and still revalidates", async () => {
	let confirmMergeCalled = false;
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			return { code: 0, stdout: current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runDeps = {
		...deps(exec),
		confirmMerge: async (): Promise<boolean> => {
			confirmMergeCalled = true;
			return true;
		},
	};
	const result = await runLand(
		{
			target: { kind: "single", prNumber: 7 },
			readiness: "check",
			method: "squash",
			confirmation: issueLandConfirmation(),
		},
		runDeps,
	);
	assert.equal(result.status, "landed");
	assert.equal(confirmMergeCalled, false, "confirmMerge should not be called when a minted confirmation is set");
});

test("a reconstructed confirmation object does not skip confirmMerge", async () => {
	let confirmMergeCalled = false;
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			return { code: 0, stdout: current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runDeps = {
		...deps(exec),
		confirmMerge: async (): Promise<boolean> => {
			confirmMergeCalled = true;
			return true;
		},
	};
	const result = await runLand(
		{
			target: { kind: "single", prNumber: 7 },
			readiness: "check",
			method: "squash",
			confirmation: {} as never,
		},
		runDeps,
	);
	assert.equal(result.status, "landed");
	assert.equal(confirmMergeCalled, true, "a reconstructed object must not skip confirmation");
});

test("minted confirmation still blocks when the PR head changes before merge", async () => {
	const CHANGED = "c".repeat(40);
	const calls: string[][] = [];
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		calls.push(args);
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			return { code: 0, stdout: current < 2 ? pr(NEW) : pr(CHANGED), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const result = await runLand(
		{
			target: { kind: "single", prNumber: 7 },
			readiness: "check",
			method: "squash",
			confirmation: issueLandConfirmation(),
		},
		deps(exec),
	);
	assert.equal(result.status, "blocked");
	assert.deepEqual(result.blockers, ["PR changed after confirmation; merge was not attempted."]);
	assert.equal(
		calls.some((args) => args[0] === "pr" && args[1] === "merge"),
		false,
	);
});

test("unconfigured repo falls through to selectMethod prompt", async () => {
	let selectMethodCalled = false;
	let confirmMergeCalled = false;
	let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			// views: 0=initial, 1=ready, 2=revalidate (confirm shown), 3=waitForMerge
			return { code: 0, stdout: current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runDeps = {
		...deps(exec),
		configuredMethodFor: () => undefined,
		selectMethod: async (): Promise<MergeMethod | undefined> => {
			selectMethodCalled = true;
			return "squash";
		},
		confirmMerge: async (): Promise<boolean> => {
			confirmMergeCalled = true;
			return true;
		},
	};
	const result = await runLand({ target: { kind: "single", prNumber: 7 }, readiness: "check" }, runDeps);
	assert.equal(result.status, "landed");
	assert.equal(selectMethodCalled, true, "selectMethod should be called without configured method");
	assert.equal(confirmMergeCalled, true, "confirmMerge should be called without configured method");
});

const PR_CHANGE_CASES = [
	{ name: "head SHA", view: pr("c".repeat(40)) },
	{ name: "head ref", view: pr(NEW, "OPEN", false, "other") },
	{ name: "draft", view: pr(NEW, "OPEN", true) },
	{ name: "state", view: pr(NEW, "CLOSED") },
];

for (const item of PR_CHANGE_CASES) {
	test(`blocks merge when the PR ${item.name} changes after confirmation`, async () => {
		const calls: string[][] = [];
		let views = 0;
		const exec: ExecFn = async (_command, args) => {
			calls.push(args);
			if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
			if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "pr" && args[1] === "view") {
				const current = views++;
				return { code: 0, stdout: current < 2 ? pr(NEW) : item.view, stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const result = await runLand(
			{ target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash" },
			deps(exec),
		);
		assert.equal(result.status, "blocked");
		assert.deepEqual(result.blockers, ["PR changed after confirmation; merge was not attempted."]);
		assert.equal(result.frontiers[0]?.state, "not-attempted");
		assert.equal(result.frontiers[0]?.expectedHeadSha, NEW);
		assert.equal(
			calls.some((args) => args[0] === "pr" && args[1] === "merge"),
			false,
		);
	});
}

test("blocks early when GitHub only allows merge commits (no squash or rebase)", async () => {
	const mergeOnly = JSON.stringify({
		nameWithOwner: "o/m",
		defaultBranchRef: { name: "main" },
		squashMergeAllowed: false,
		rebaseMergeAllowed: false,
	});
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: mergeOnly, stderr: "" };
		if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: pr(NEW), stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const result = await runLand(
		{ target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash" },
		deps(exec),
	);
	assert.equal(result.status, "blocked");
	assert.match(result.blockers.join("\n"), /only allows merge commits/i);
	assert.match(result.blockers.join("\n"), /kstack does not support/i);
});
