import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import { applyThreadReplies, parseTriage } from "./autopilot-operations.ts";
import { runAutopilot } from "./driver.ts";
import { BRANCH, config, createHarness, deferred, SHA, triage } from "./test-harness.ts";
import type { ExecFn, ExecFnResult, PRState, ReviewThread } from "./types.ts";

async function run(mode: "check" | "drive", scenario: Parameters<typeof createHarness>[0] = {}) {
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

test("aborting during the first refresh starts no later actions", async (t) => {
	const harness = await createHarness({ mergeStateStatus: "BEHIND" });
	t.after(() => harness.cleanup());
	const refresh = deferred<ExecFnResult>();
	const refreshStarted = deferred<void>();
	let held = false;
	const exec: ExecFn = async (command, args, options) => {
		if (!held && command === "gh" && args[0] === "pr" && args[1] === "view") {
			held = true;
			refreshStarted.resolve();
			return refresh.promise;
		}
		return harness.exec(command, args, options);
	};
	const controller = new AbortController();
	const pending = runAutopilot(
		"drive",
		{
			config,
			exec,
			backend: new GitBackend(exec),
			cwd: harness.cwd,
			explicitPR: 42,
			promptDir: harness.cwd,
			triagerPromptFile: join(harness.cwd, "triager.md"),
			fixerPromptFile: join(harness.cwd, "fixer.md"),
		},
		harness.handlers,
		controller.signal,
		harness.ops,
	);
	await refreshStarted.promise;
	controller.abort();
	refresh.resolve({
		code: 0,
		stdout: JSON.stringify({
			number: 42,
			title: "Fix the thing",
			state: "OPEN",
			isDraft: false,
			mergeable: "true",
			mergeStateStatus: "BEHIND",
			headRefName: BRANCH,
			baseRefName: "main",
			headRefOid: SHA,
			commits: [{ oid: SHA }],
		}),
		stderr: "",
	});
	const result = await pending;
	assert.equal(result.status, "aborted");
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("a push confirmation resolving true after abort starts no publication", async (t) => {
	const harness = await createHarness({
		thread: { id: "thread-1", body: "Please fix this" },
		triage: triage({
			threads: [{ key: "thread-1", decision: "fix", cls: "code", action: "fix", reply: "fixed" }],
		}),
		fixerChanges: true,
	});
	t.after(() => harness.cleanup());
	const confirmation = deferred<boolean>();
	const confirmationStarted = deferred<void>();
	harness.handlers.confirm = async () => {
		confirmationStarted.resolve();
		return confirmation.promise;
	};
	const controller = new AbortController();
	const pending = runAutopilot(
		"drive",
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
		controller.signal,
		harness.ops,
	);
	await confirmationStarted.promise;
	controller.abort();
	confirmation.resolve(true);
	const result = await pending;
	assert.equal(result.status, "aborted");
	assert.ok(!harness.calls.some((call) => call.startsWith("git add") || call.startsWith("git push")));
});

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

test("check mode does not treat top-level discussion as unresolved review feedback", async (t) => {
	const { harness, result } = await run("check", {
		issueComment: { id: 9, body: "Thanks for the update" },
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("dirty worktree blocks the fixer before any mutation", async (t) => {
	const { harness, result } = await run("drive", {
		dirty: true,
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix test" }] }),
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
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix test" }] }),
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

test("informational issue comments are ignored without posting and do not block readiness", async (t) => {
	const { harness, result } = await run("drive", {
		issueComment: { id: 9, body: "Thanks for the update" },
		triage: triage({
			threads: [{ key: "thread-1", decision: "ignore", action: "informational acknowledgement" }],
		}),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.equal(
		harness.calls.some((call) => call.startsWith("gh pr comment") || call.includes("/pulls/42/comments")),
		false,
	);
	assert.deepEqual(harness.roles, ["triager"]);
});

test("ask threads block without invoking a fixer", async (t) => {
	const { harness, result } = await run("drive", {
		thread: { id: "thread-1", body: "Please explain this design" },
		triage: triage({ threads: [{ key: "thread-1", decision: "ask", cls: "code", action: "Need a product decision" }] }),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.ok(result.blockedReasons.includes("ask threads: thread-1"));
	assert.deepEqual(harness.roles, ["triager"]);
});

test("VERIFY_FAIL from a fixer is never pushed", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix test" }] }),
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
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix test" }] }),
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
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix test" }] }),
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
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix test" }] }),
		fixerChanges: true,
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.equal(result.cyclesCompleted, 3);
	assert.ok(result.blockedReasons.some((reason) => reason.includes("max cycles reached")));
	assert.equal(harness.roles.filter((role) => role === "fixer").length, 3);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh repo view")).length, 1);
});

test("flake reruns use the trusted key without changing the remote check name", async (t) => {
	const remoteName = `System Prompt Contract Tests ${"x".repeat(140)}`;
	const { harness } = await run("drive", {
		checks: [
			{
				name: remoteName,
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/12345",
			},
		],
		triage: triage({ checks: [{ key: "check-1", cls: "flake", action: "rerun once" }] }),
	});
	t.after(() => harness.cleanup());
	assert.ok(harness.calls.some((call) => call === "gh run rerun 12345 --failed"));
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
	const backend = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		id: "jj",
		preflight: async () => ({ ok: true, workspaceRoot: cwd }),
	} as never;
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
		hasUnresolvedThreads: threads.some((thread) => thread.source === "review-thread"),
	};
}

function makeReplyExec(overrides: { replyCode?: number; resolveCode?: number; issueReplyCode?: number } = {}) {
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
			threads: [{ key: "thread-1", decision: "fix", cls: "code", action: "rename", reply: "Renamed." }],
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
	assert.deepEqual(handled, { ok: true, handled: ["thread-1"] });
	assert.deepEqual(repliedThreadIds, ["thread-1"]);
	assert.ok(calls.some((call) => call.startsWith("gh api repos/{owner}/{repo}/pulls/42/comments")));
	assert.ok(calls.some((call) => call.startsWith("gh api graphql") && call.includes("id=thread-1")));
});

test("ignore decision marks an issue comment handled without posting", async () => {
	const state = makeThreadState([
		{
			id: "issue-comment-1",
			commenter: "reviewer",
			body: "Thanks for the update",
			source: "issue-comment",
			replyToId: 1,
		},
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [{ key: "thread-1", decision: "ignore", action: "informational" }],
			conflicts: false,
			draft: false,
			summary: "",
		}),
	);
	const { exec, calls } = makeReplyExec();
	const result = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		{ resolveFix: false, repliedThreadIds: [] },
		() => {},
	);
	assert.deepEqual(result, { ok: true, handled: ["issue-comment-1"] });
	assert.deepEqual(calls, []);
});

test("dismiss decision replies to an issue comment without resolving", async () => {
	const state = makeThreadState([
		{ id: "issue-comment-1", commenter: "reviewer", body: "remove this", source: "issue-comment", replyToId: 1 },
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [{ key: "thread-1", decision: "dismiss", action: "out of scope", reply: "" }],
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
	assert.deepEqual(handled, { ok: true, handled: ["issue-comment-1"] });
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
			threads: [{ key: "thread-1", decision: "fix", cls: "code", action: "rename", reply: "Renamed." }],
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
	assert.deepEqual(handled, { ok: false, handled: [], error: "Could not reply to thread thread-1: reply failed" });
	assert.deepEqual(repliedThreadIds, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /Could not reply to thread thread-1/);
});

test("a reply failure stops later GitHub comment writes", async () => {
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
		{ id: "issue-comment-2", commenter: "reviewer", body: "remove this", source: "issue-comment", replyToId: 2 },
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [
				{ key: "thread-1", decision: "fix", cls: "code", action: "rename", reply: "Renamed." },
				{ key: "thread-2", decision: "dismiss", action: "out of scope", reply: "Not changing this." },
			],
			conflicts: false,
			draft: false,
			summary: "",
		}),
	);
	const { exec, calls } = makeReplyExec({ replyCode: 1 });
	const result = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		{ resolveFix: true, repliedThreadIds: [] },
		() => {},
	);
	assert.equal(result.ok, false);
	assert.equal(calls.filter((call) => call.startsWith("gh pr comment 42")).length, 0);
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
			threads: [{ key: "thread-1", decision: "fix", cls: "code", action: "rename", reply: "Renamed." }],
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
	assert.deepEqual(handled, { ok: false, handled: [], error: "Could not resolve thread thread-1: resolve failed" });
	assert.deepEqual(repliedThreadIds, ["thread-1"]);
});
