import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import type { ChildUsage, runChildAgent } from "../shared/child-agent-runner.ts";
import type { GitVcsBackend, IsolationPlan, JjVcsBackend } from "../shared/vcs/backend.ts";
import { buildImplementerGuidance, runWorktreeFastImplement } from "./runner.ts";
import { type FastImplementRequest, LIMITS, type ResolvedRole } from "./types.ts";

type ChildRunOptions = Parameters<typeof runChildAgent>[0];

const usage: ChildUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const childSession = {
	kind: "persisted" as const,
	id: "00000000-0000-4000-8000-000000000001",
	name: "fast-implement/implementer",
	file: "/sessions/child.jsonl",
};

const request: FastImplementRequest = {
	task: "Fix the narrow bug",
	workLocation: "worktree",
	changeKind: "bug-fix",
};

const role: ResolvedRole = {
	implementer: { model: "openai/gpt-5.6-sol", thinking: "low" },
	timeoutMinutes: 12,
	source: "config",
};

const isolationPlan: IsolationPlan = {
	sourceRepoRoot: "/repo",
	ref: "kstack/fix-the-narrow-bug",
	path: "/tmp/kstack-worktrees/fix-the-narrow-bug",
	baseRef: "origin/main",
	baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const emptyUsage = (): ChildUsage => ({ ...usage });

function fakeGitBackend(overrides: Partial<GitVcsBackend> = {}): GitVcsBackend & { calls: string[] } {
	const calls: string[] = [];
	return {
		id: "git",
		descriptor: { refNoun: "branch", workstreamNoun: "Git checkout", baseUpdateVerb: "merge" },
		calls,
		childGuidance: () => "VCS backend: git.",
		preflight: async (cwd) => {
			calls.push(`preflight:${cwd}`);
			return { ok: true, workspaceRoot: cwd };
		},
		headSha: async () => ({ ok: true, sha: isolationPlan.baseSha }),
		currentRef: async () => ({ ok: true, ref: { kind: "branch", name: "main" } }),
		workstreamIdentity: async () => ({
			ok: true,
			identity: { kind: "git", ref: "main", headSha: isolationPlan.baseSha },
		}),
		captureWorkstream: async () => ({ ok: true, snapshot: { ref: "main", token: `main@${isolationPlan.baseSha}` } }),
		assertWorkstreamUnchanged: async () => ({ ok: true }),
		changedPaths: async () => ({ ok: true, paths: [] }),
		isWorkingCopyEmpty: async () => ({ ok: true, empty: true }),
		createWorkstream: async () => ({ ok: true, ref: isolationPlan.ref, baseSha: isolationPlan.baseSha }),
		verifyCommittedWorkstream: async (cwd, expected) => {
			calls.push(`verify:${cwd}:${expected.ref}:${expected.baseSha}:${expected.requireNewCommit}`);
			return { ok: true, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
		},
		verifyRecordedWorkstream: async (cwd, expected) => {
			calls.push(`verify:${cwd}:${expected.ref}:${expected.baseSha}:${expected.requireNewCommit}`);
			return { ok: true, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
		},
		commitPaths: async () => ({ ok: true }),
		recordPaths: async () => ({ ok: true }),
		restorePaths: async () => ({ ok: true }),
		push: async () => ({ ok: true }),
		publishRecordedChanges: async () => ({ ok: true }),
		fetchRemoteHead: async () => ({ ok: true, sha: isolationPlan.baseSha }),
		mergeBaseIntoHead: async () => ({ kind: "already-current" }),
		updateBase: async () => ({ kind: "already-current" }),
		planIsolation: async (cwd, task) => {
			calls.push(`plan:${cwd}:${task}`);
			return { ok: true, plan: isolationPlan };
		},
		createIsolation: async (plan) => {
			calls.push(`create:${plan.path}:${plan.ref}`);
			return { ok: true, plan };
		},
		removeIsolation: async (cwd, ref) => {
			calls.push(`remove:${cwd}:${ref}`);
			return { ok: true };
		},
		isolation: {
			plan: async (cwd, task) => {
				calls.push(`plan:${cwd}:${task}`);
				return { ok: true, plan: isolationPlan };
			},
			create: async (plan) => {
				calls.push(`create:${plan.path}:${plan.ref}`);
				return { ok: true, plan };
			},
			remove: async (cwd, ref) => {
				calls.push(`remove:${cwd}:${ref}`);
				return { ok: true };
			},
		},
		...overrides,
	};
}

function fakeJjBackend(overrides: Partial<JjVcsBackend> = {}): JjVcsBackend & { calls: string[] } {
	const calls: string[] = [];
	return {
		id: "jj",
		descriptor: { refNoun: "bookmark", workstreamNoun: "jj workspace", baseUpdateVerb: "merge" },
		calls,
		childGuidance: () => "VCS backend: jj.",
		preflight: async (cwd) => {
			calls.push(`preflight:${cwd}`);
			return { ok: true, workspaceRoot: cwd };
		},
		headSha: async () => ({ ok: true, sha: isolationPlan.baseSha }),
		currentRef: async () => ({ ok: true, ref: { kind: "bookmark", name: "main" } }),
		workstreamIdentity: async () => ({
			ok: true,
			identity: { kind: "jj", ref: "main", changeId: "change", parentCommitIds: ["trunk"] },
		}),
		captureWorkstream: async () => ({ ok: true, snapshot: { ref: "main", token: "main@change" } }),
		assertWorkstreamUnchanged: async () => ({ ok: true }),
		changedPaths: async () => ({ ok: true, paths: [] }),
		isWorkingCopyEmpty: async () => ({ ok: true, empty: true }),
		createWorkstream: async () => ({ ok: true, ref: isolationPlan.ref, baseSha: isolationPlan.baseSha }),
		verifyCommittedWorkstream: async () => ({ ok: true, headSha: isolationPlan.baseSha }),
		verifyRecordedWorkstream: async () => ({ ok: true, headSha: isolationPlan.baseSha }),
		commitPaths: async () => ({ ok: true }),
		recordPaths: async () => ({ ok: true }),
		restorePaths: async () => ({ ok: true }),
		push: async () => ({ ok: true }),
		publishRecordedChanges: async () => ({ ok: true }),
		fetchRemoteHead: async () => ({ ok: true, sha: isolationPlan.baseSha }),
		mergeBaseIntoHead: async () => ({ kind: "already-current" }),
		updateBase: async () => ({ kind: "already-current" }),
		...overrides,
	};
}

function completedChild(output = "implemented") {
	return { status: "completed" as const, output, usage: emptyUsage(), session: childSession };
}

function promptFileFrom(options: ChildRunOptions): string {
	const promptFile = options.args[options.args.indexOf("--append-system-prompt") + 1];
	assert.ok(promptFile);
	return promptFile;
}

describe("runWorktreeFastImplement fixtures", () => {
	it("builds a typed Git backend without launching Pi or Git", () => {
		const backend = fakeGitBackend();
		assert.equal(backend.id, "git");
		assert.deepEqual(backend.calls, []);
	});
});

describe("request and backend validation", () => {
	it("rejects a current-checkout request before preflight", async () => {
		const backend = fakeGitBackend();
		let ranChild = false;
		const result = await runWorktreeFastImplement({ ...request, workLocation: "current" }, role, "/repo", {
			backend,
			runChild: async () => {
				ranChild = true;
				return completedChild();
			},
		});
		assert.deepEqual(result, {
			status: "failed",
			error: "The configured VCS backend does not support managed worktrees.",
		});
		assert.deepEqual(backend.calls, []);
		assert.equal(ranChild, false);
	});

	it("rejects a jj backend before preflight", async () => {
		const backend = fakeJjBackend();
		let ranChild = false;
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async () => {
				ranChild = true;
				return completedChild();
			},
		});
		assert.deepEqual(result, {
			status: "failed",
			error: "The configured VCS backend does not support managed worktrees.",
		});
		assert.deepEqual(backend.calls, []);
		assert.equal(ranChild, false);
	});
});

describe("worktree setup short-circuits", () => {
	it("returns a failed preflight and does not plan, create, or run the child", async () => {
		const backend = fakeGitBackend({
			preflight: async (cwd) => {
				backend.calls.push(`preflight:${cwd}`);
				return { ok: false, error: "dirty working tree" };
			},
		});
		let ranChild = false;
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async () => {
				ranChild = true;
				return completedChild();
			},
		});
		assert.deepEqual(result, { status: "failed", error: "dirty working tree" });
		assert.deepEqual(backend.calls, ["preflight:/repo"]);
		assert.equal(ranChild, false);
	});

	it("returns a failed plan and does not create or run the child", async () => {
		const backend = fakeGitBackend({
			isolation: {
				plan: async (cwd, task) => {
					backend.calls.push(`plan:${cwd}:${task}`);
					return { ok: false, error: "no unused branch" };
				},
				create: async () => ({ ok: false, error: "unused" }),
				remove: async () => ({ ok: true }),
			},
		});
		let ranChild = false;
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async () => {
				ranChild = true;
				return completedChild();
			},
		});
		assert.deepEqual(result, { status: "failed", error: "no unused branch" });
		assert.deepEqual(backend.calls, ["preflight:/repo", `plan:/repo:${request.task}`]);
		assert.equal(ranChild, false);
	});

	it("returns a failed create and does not run the child", async () => {
		const backend = fakeGitBackend({
			isolation: {
				plan: async (cwd, task) => {
					backend.calls.push(`plan:${cwd}:${task}`);
					return { ok: true, plan: isolationPlan };
				},
				create: async (plan) => {
					backend.calls.push(`create:${plan.path}:${plan.ref}`);
					return { ok: false, error: "worktree add failed" };
				},
				remove: async () => ({ ok: true }),
			},
		});
		let ranChild = false;
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async () => {
				ranChild = true;
				return completedChild();
			},
		});
		assert.deepEqual(result, { status: "failed", error: "worktree add failed" });
		assert.deepEqual(backend.calls, [
			"preflight:/repo",
			`plan:/repo:${request.task}`,
			`create:${isolationPlan.path}:${isolationPlan.ref}`,
		]);
		assert.equal(ranChild, false);
	});

	it("plans and creates the worktree once, in order, with the request cwd and task", async () => {
		const backend = fakeGitBackend();
		await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async () => completedChild(),
		});
		assert.deepEqual(backend.calls.slice(0, 3), [
			"preflight:/repo",
			`plan:/repo:${request.task}`,
			`create:${isolationPlan.path}:${isolationPlan.ref}`,
		]);
	});
});

describe("completed child and verification", () => {
	it("runs the child in the worktree, verifies a new commit, and removes temporary files", async () => {
		const backend = fakeGitBackend();
		const signal = new AbortController().signal;
		let childOptions: ChildRunOptions | undefined;
		let taskContents = "";
		let promptContents = "";
		let taskMode = 0;
		let promptMode = 0;
		let tempDir = "";
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			signal,
			runChild: async (options) => {
				childOptions = options;
				const promptFile = promptFileFrom(options);
				const taskArg = options.args.find((arg) => arg.startsWith("Read the user task at "));
				assert.ok(taskArg);
				const taskFile = taskArg.slice("Read the user task at ".length).split(",", 1)[0];
				tempDir = dirname(promptFile);
				taskContents = readFileSync(taskFile, "utf8");
				promptContents = readFileSync(promptFile, "utf8");
				if (process.platform !== "win32") {
					taskMode = statSync(taskFile).mode & 0o777;
					promptMode = statSync(promptFile).mode & 0o777;
				}
				return completedChild("child output");
			},
		});
		assert.ok(childOptions);
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.equal(result.branch, isolationPlan.ref);
			assert.equal(result.cwd, isolationPlan.path);
			assert.equal(result.output, "child output");
		}
		assert.equal(childOptions.cwd, isolationPlan.path);
		assert.equal(childOptions.signal, signal);
		assert.ok(!childOptions.args.includes("--no-session"));
		assert.ok(childOptions.args.includes("--no-extensions"));
		assert.ok(childOptions.args.includes("--no-prompt-templates"));
		assert.ok(!childOptions.args.includes("--no-skills"));
		assert.ok(!childOptions.args.includes("--no-context-files"));
		assert.deepEqual(
			childOptions.args.slice(childOptions.args.indexOf("--model"), childOptions.args.indexOf("--model") + 2),
			["--model", "openai/gpt-5.6-sol:low"],
		);
		assert.equal(childOptions.deps?.maxRuntimeMs, 12 * 60_000);
		assert.equal(childOptions.deps?.outputCapBytes, LIMITS.outputBytes);
		assert.equal(childOptions.deps?.stderrCapBytes, LIMITS.stderrBytes);
		assert.equal(childOptions.deps?.stdoutLineCapBytes, LIMITS.stdoutLineBytes);
		assert.equal(childOptions.deps?.killGraceMs, LIMITS.killGraceMs);
		assert.ok(taskContents.includes(request.task));
		assert.ok(taskContents.includes("VCS backend: git"));
		assert.ok(taskContents.includes(`Workstream: ${isolationPlan.ref}`));
		assert.equal(promptContents, buildImplementerGuidance(request.changeKind, backend));
		if (process.platform !== "win32") {
			assert.equal(taskMode, 0o600);
			assert.equal(promptMode, 0o600);
		}
		assert.ok(
			backend.calls.includes(`verify:${isolationPlan.path}:${isolationPlan.ref}:${isolationPlan.baseSha}:true`),
		);
		assert.ok(tempDir);
		assert.equal(existsSync(tempDir), false);
		assert.ok(!backend.calls.some((call) => call.startsWith("remove:")));
	});
});

describe("retained outcomes after worktree creation", () => {
	it("returns a failed child with branch and cwd and does not verify", async () => {
		const backend = fakeGitBackend();
		let tempDir = "";
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async (options) => {
				tempDir = dirname(promptFileFrom(options));
				return { status: "failed", error: "child crashed", usage: emptyUsage(), stderr: "boom", session: childSession };
			},
		});
		assert.deepEqual(result, {
			status: "failed",
			error: "child crashed",
			branch: isolationPlan.ref,
			cwd: isolationPlan.path,
			session: childSession,
		});
		assert.ok(!backend.calls.some((call) => call.startsWith("verify:")));
		assert.ok(!backend.calls.some((call) => call.startsWith("remove:")));
		assert.equal(existsSync(tempDir), false);
	});

	it("returns an aborted child with the abort message, branch, and cwd", async () => {
		const backend = fakeGitBackend();
		let tempDir = "";
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async (options) => {
				tempDir = dirname(promptFileFrom(options));
				return { status: "aborted", usage: emptyUsage(), session: childSession };
			},
		});
		assert.deepEqual(result, {
			status: "aborted",
			error: "Implementation child was aborted.",
			branch: isolationPlan.ref,
			cwd: isolationPlan.path,
			session: childSession,
		});
		assert.ok(!backend.calls.some((call) => call.startsWith("verify:")));
		assert.ok(!backend.calls.some((call) => call.startsWith("remove:")));
		assert.equal(existsSync(tempDir), false);
	});

	it("converts a throwing child into a retained failed outcome", async () => {
		const backend = fakeGitBackend();
		let tempDir = "";
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async (options) => {
				tempDir = dirname(promptFileFrom(options));
				throw new Error("spawn exploded");
			},
		});
		assert.deepEqual(result, {
			status: "failed",
			error: "spawn exploded",
			branch: isolationPlan.ref,
			cwd: isolationPlan.path,
		});
		assert.ok(!backend.calls.some((call) => call.startsWith("verify:")));
		assert.ok(!backend.calls.some((call) => call.startsWith("remove:")));
		assert.equal(existsSync(tempDir), false);
	});

	it("returns a failed verification with child output, branch, and cwd", async () => {
		const backend = fakeGitBackend({
			verifyRecordedWorkstream: async (cwd, expected) => {
				backend.calls.push(`verify:${cwd}:${expected.ref}:${expected.baseSha}:${expected.requireNewCommit}`);
				return { ok: false, error: "no new commit" };
			},
		});
		let tempDir = "";
		const result = await runWorktreeFastImplement(request, role, "/repo", {
			backend,
			runChild: async (options) => {
				tempDir = dirname(promptFileFrom(options));
				return completedChild("partial work");
			},
		});
		assert.deepEqual(result, {
			status: "failed",
			error: "no new commit",
			branch: isolationPlan.ref,
			cwd: isolationPlan.path,
			output: "partial work",
			session: childSession,
		});
		assert.ok(
			backend.calls.includes(`verify:${isolationPlan.path}:${isolationPlan.ref}:${isolationPlan.baseSha}:true`),
		);
		assert.ok(!backend.calls.some((call) => call.startsWith("remove:")));
		assert.equal(existsSync(tempDir), false);
	});
});
