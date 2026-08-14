import assert from "node:assert/strict";
import test from "node:test";
import type { AutopilotResult } from "../pr-autopilot/driver.ts";
import { runLand } from "./orchestrator.ts";
import type { ExecFn, ExecResult } from "./types.ts";
const OLD = "a".repeat(40); const NEW = "b".repeat(40);
const repo = JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" }, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
function pr(sha: string, state = "OPEN", isDraft = false): string { return JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7", title: "x", state, isDraft, headRefName: "feature", baseRefName: "main", headRefOid: sha, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", mergedAt: state === "MERGED" ? "2026-01-01" : null, mergeCommit: state === "MERGED" ? { oid: "c".repeat(40) } : null }); }
function ready(sha: string): AutopilotResult { return { status: "merge-ready", mergeReady: true, cyclesCompleted: 1, blockedReasons: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, prState: { number: 7, title: "x", state: "open", isDraft: false, headSha: sha, verifiedHeadSha: sha, baseRef: "main", headRef: "feature", mergeable: "mergeable", mergeStateStatus: "CLEAN", checks: [], threads: [], hasUnresolvedThreads: false } }; }
function deps(exec: ExecFn, outcome = ready(NEW)) { const controller = new AbortController(); return { exec, cwd: "/repo", signal: controller.signal, runAutopilot: async () => ({ handled: true as const, outcome }), selectMethod: async () => "squash" as const, confirmMerge: async () => true, now: () => 0, sleep: async () => {} }; }

test("lets autopilot transition an initially draft PR to ready", async () => {
	let views = 0;
	let autopilotRan = false;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			return { code: 0, stdout: current === 0 ? pr(OLD, "OPEN", true) : current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runDeps = { ...deps(exec), runAutopilot: async () => { autopilotRan = true; return { handled: true as const, outcome: ready(NEW) }; } };
	const result = await runLand({ target: { kind: "single", prNumber: 7 }, readiness: "watch", method: "squash" }, runDeps);
	assert.equal(autopilotRan, true);
	assert.equal(result.status, "landed");
});

test("watch mode adopts the freshly verified autopilot head", async () => {
	const calls: string[][] = []; let views = 0;
	const exec: ExecFn = async (_command, args): Promise<ExecResult> => {
		calls.push(args);
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "view") {
			const current = views++;
			return { code: 0, stdout: current === 0 ? pr(OLD) : current < 3 ? pr(NEW) : pr(NEW, "MERGED"), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const result = await runLand({ target: { kind: "single", prNumber: 7 }, readiness: "watch", method: "squash" }, deps(exec));
	assert.equal(result.status, "landed");
	assert.ok(calls.some((args) => args.includes(NEW) && args.includes("--match-head-commit")));
});

test("preserves accepted mutation when verification throws", async () => {
	let views = 0;
	const exec: ExecFn = async (_command, args) => { if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" }; if (args[0] === "pr" && args[1] === "merge") return { code: 0, stdout: "", stderr: "" }; if (views++ < 3) return { code: 0, stdout: pr(NEW), stderr: "" }; throw new Error("network down"); };
	const result = await runLand({ target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash" }, deps(exec));
	assert.equal(result.status, "partially-landed");
	assert.equal(result.frontiers[0]?.state, "queued");
	assert.match(result.completedMutations.join("\n"), /accepted merge\/queue/);
	assert.match(result.blockers.join("\n"), /network down/);
});

test("reports partial landing when polling is aborted after acceptance", async () => {
	const controller = new AbortController(); let views = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[0] === "repo") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "pr" && args[1] === "merge") { controller.abort(); return { code: 0, stdout: "", stderr: "" }; }
		if (views++ < 3) return { code: 0, stdout: pr(NEW), stderr: "" };
		throw new Error("aborted");
	};
	const runDeps = { ...deps(exec), signal: controller.signal };
	const result = await runLand({ target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash" }, runDeps);
	assert.equal(result.status, "partially-landed");
	assert.match(result.completedMutations.join("\n"), /accepted merge\/queue/);
	assert.match(result.blockers.join("\n"), /aborted after GitHub accepted/);
});
