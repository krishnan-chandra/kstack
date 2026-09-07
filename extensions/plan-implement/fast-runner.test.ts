import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import type { IsolationPlan, VcsBackend } from "../shared/vcs/backend.ts";
import type { RoleRunner, RunAgentOptions } from "./agent-runner.ts";
import { buildFastImplementerGuidance, runFastCurrent, runFastWorktree } from "./fast-runner.ts";
import type { AgentRunResult, RoleSpec } from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const request = { task: "Fix the narrow bug", changeKind: "bug-fix" as const };
const implementer: RoleSpec = { model: "openai/gpt-5.6-sol", thinking: "low" };
const isolationPlan: IsolationPlan = {
	sourceRepoRoot: "/repo",
	ref: "kstack/fix-the-narrow-bug",
	path: "/tmp/kstack-worktrees/fix-the-narrow-bug",
	baseRef: "origin/main",
	baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function fakeBackend(overrides: Partial<VcsBackend> = {}): VcsBackend & { calls: string[] } {
	const calls: string[] = [];
	return {
		id: "git",
		calls,
		preflight: async (cwd) => {
			calls.push(`preflight:${cwd}`);
			return { ok: true, workspaceRoot: cwd };
		},
		headSha: async () => ({ ok: true, sha: isolationPlan.baseSha }),
		currentRef: async () => ({ ok: true, ref: { kind: "branch", name: "main" } }),
		captureWorkstream: async () => ({ ok: true, snapshot: { ref: "main", token: `main@${isolationPlan.baseSha}` } }),
		assertWorkstreamUnchanged: async () => ({ ok: true }),
		changedPaths: async () => ({ ok: true, paths: [] }),
		isWorkingCopyEmpty: async () => ({ ok: true, empty: true }),
		createWorkstream: async (cwd, task) => {
			calls.push(`workstream:${cwd}:${task}`);
			return { ok: true, ref: isolationPlan.ref, baseSha: isolationPlan.baseSha };
		},
		verifyRecordedWorkstream: async (cwd, expected) => {
			calls.push(`verify:${cwd}:${expected.ref}:${expected.requireNewCommit}`);
			return { ok: true, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
		},
		recordPaths: async () => ({ ok: true }),
		restorePaths: async () => ({ ok: true }),
		publishRecordedChanges: async () => ({ ok: true }),
		fetchRemoteHead: async () => ({ ok: true, sha: isolationPlan.baseSha }),
		updateBase: async () => ({ kind: "already-current" }),
		isolation: {
			plan: async (cwd, task) => {
				calls.push(`plan:${cwd}:${task}`);
				return { ok: true, plan: isolationPlan };
			},
			create: async (plan) => {
				calls.push(`create:${plan.path}:${plan.ref}`);
				return { ok: true, plan };
			},
			remove: async () => ({ ok: true }),
		},
		...overrides,
	};
}

function fakeRunner(run: (options: RunAgentOptions) => Promise<AgentRunResult>) {
	let disposeCalls = 0;
	const runner: RoleRunner = {
		tabId: "w1:t-fast",
		paneId: () => "w1:p-fast",
		run,
		abortActive: async () => false,
		dispose: async () => {
			disposeCalls++;
		},
	};
	return { runner, disposeCalls: () => disposeCalls };
}

function completed(output = "implemented"): AgentRunResult {
	return {
		status: "completed",
		role: "implementer",
		model: "openai/gpt-5.6-sol:low",
		output,
		usage,
		session: "/sessions/hosted.jsonl",
	};
}

describe("buildFastImplementerGuidance", () => {
	it("includes the role prompt, engineering principles, playbook, and backend policy", () => {
		const guidance = buildFastImplementerGuidance("bug-fix", { id: "git" });
		assert.match(guidance, /fast implementation/i);
		assert.match(guidance, /bug/i);
		assert.match(guidance, /git/i);
	});
});

describe("runFastWorktree", () => {
	it("rejects unsupported isolation before preflight", async () => {
		const backend = fakeBackend({ isolation: undefined });
		let opened = false;
		const result = await runFastWorktree(request, implementer, "/repo", {
			backend,
			openRunner: async () => {
				opened = true;
				return { ok: false, error: "unused" };
			},
		});
		assert.equal(result.status, "failed");
		assert.equal(opened, false);
		assert.deepEqual(backend.calls, []);
	});

	it("short-circuits failed preflight, plan, and create", async () => {
		const preflight = fakeBackend({ preflight: async () => ({ ok: false, error: "bad repo" }) });
		assert.equal(
			(
				await runFastWorktree(request, implementer, "/repo", {
					backend: preflight,
					openRunner: async () => ({ ok: false, error: "unused" }),
				})
			).status,
			"failed",
		);
		const planned = fakeBackend({
			isolation: {
				plan: async () => ({ ok: false, error: "bad plan" }),
				create: async () => assert.fail("create must not run"),
				remove: async () => ({ ok: true }),
			},
		});
		assert.equal(
			(
				await runFastWorktree(request, implementer, "/repo", {
					backend: planned,
					openRunner: async () => ({ ok: false, error: "unused" }),
				})
			).status,
			"failed",
		);
	});

	it("creates the worktree before opening a hosted runner in it", async () => {
		const backend = fakeBackend();
		let openedCwd = "";
		let seenPrompt = "";
		let promptPath = "";
		const fake = fakeRunner(async (options) => {
			openedCwd = options.cwd;
			promptPath = options.promptFile;
			seenPrompt = readFileSync(options.promptFile, "utf8");
			assert.equal(statSync(options.taskFile).mode & 0o777, 0o600);
			assert.match(readFileSync(options.taskFile, "utf8"), /Fix the narrow bug/);
			return completed();
		});
		const result = await runFastWorktree(request, implementer, "/repo", {
			backend,
			openRunner: async (cwd) => {
				assert.equal(cwd, isolationPlan.path);
				return { ok: true, runner: fake.runner };
			},
		});
		assert.equal(result.status, "completed");
		assert.equal(openedCwd, isolationPlan.path);
		assert.match(seenPrompt, /fast implementation/i);
		assert.equal(existsSync(promptPath), false);
		assert.equal(fake.disposeCalls(), 1);
		assert.deepEqual(backend.calls, [
			"preflight:/repo",
			"plan:/repo:Fix the narrow bug",
			`create:${isolationPlan.path}:${isolationPlan.ref}`,
			`verify:${isolationPlan.path}:${isolationPlan.ref}:true`,
		]);
	});

	it("retains workstream details on hosted-agent and verification failures", async () => {
		const backend = fakeBackend();
		const failed = fakeRunner(async () => ({
			status: "failed",
			role: "implementer",
			model: "m",
			error: "agent failed",
			session: "/sessions/failed.jsonl",
		}));
		const childFailure = await runFastWorktree(request, implementer, "/repo", {
			backend,
			openRunner: async () => ({ ok: true, runner: failed.runner }),
		});
		assert.deepEqual(childFailure, {
			status: "failed",
			error: "agent failed",
			branch: isolationPlan.ref,
			cwd: isolationPlan.path,
			session: "/sessions/failed.jsonl",
		});

		const verifyBackend = fakeBackend({
			verifyRecordedWorkstream: async () => ({ ok: false, error: "not committed" }),
		});
		const verification = await runFastWorktree(request, implementer, "/repo", {
			backend: verifyBackend,
			openRunner: async () => ({ ok: true, runner: fakeRunner(async () => completed("partial")).runner }),
		});
		assert.equal(verification.status, "failed");
		if (verification.status === "failed") {
			assert.equal(verification.output, "partial");
			assert.equal(verification.branch, isolationPlan.ref);
		}
	});
});

describe("runFastCurrent", () => {
	it("creates and verifies a current-workspace workstream around one hosted agent", async () => {
		const backend = fakeBackend();
		const result = await runFastCurrent(request, implementer, "/repo", {
			backend,
			openRunner: async (cwd) => {
				assert.equal(cwd, "/repo");
				return { ok: true, runner: fakeRunner(async () => completed()).runner };
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(backend.calls, [
			"preflight:/repo",
			"workstream:/repo:Fix the narrow bug",
			`verify:/repo:${isolationPlan.ref}:true`,
		]);
	});
});
