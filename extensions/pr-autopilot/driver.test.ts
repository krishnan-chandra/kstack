import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import { applyThreadReplies, parseTriage } from "./autopilot-operations.ts";
import { runAutopilot } from "./driver.ts";
import { versionReviewItem } from "./review-handling.ts";
import { BRANCH, config, createHarness, deferred, SHA, triage } from "./test-harness.ts";
import type { AutopilotMode, ExecFn, ExecFnResult, PRState, ReviewThread } from "./types.ts";

type DriverMode = Exclude<AutopilotMode, "cleanup">;

async function run(mode: DriverMode, scenario: Parameters<typeof createHarness>[0] = {}) {
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

function failedLogCalls(calls: string[]): string[] {
	return calls.filter((call) => call.startsWith("gh run view"));
}

function mutatingCalls(calls: string[]): string[] {
	return calls.filter(
		(call) =>
			/^(git (add|commit|push))/.test(call) ||
			(call.startsWith("gh api ") && (call.includes("--method POST") || call.includes("resolveReviewThread"))),
	);
}

test("check mode performs two fresh reads without fetching failed logs or mutating", async (t) => {
	const { harness, result } = await run("check");
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 2);
	assert.deepEqual(failedLogCalls(harness.calls), []);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("check mode reports pending mergeability after exactly two reads", async (t) => {
	const { harness, result } = await run("check", {
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.match(result.blockedReasons.join("; "), /mergeability pending/);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 2);
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

for (const state of ["CLOSED", "MERGED"] as const) {
	for (const mode of ["check", "threads", "drive", "watch"] as const) {
		test(`${mode} mode stops on a ${state.toLowerCase()} PR before children or mutations`, async (t) => {
			const { harness, result } = await run(mode, { state });
			t.after(() => harness.cleanup());
			assert.equal(result.status, "incomplete");
			assert.match(result.blockedReasons.join("; "), new RegExp(state.toLowerCase()));
			assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, mode === "check" ? 2 : 1);
			assert.deepEqual(harness.waits, []);
			assert.deepEqual(harness.roles, []);
			assert.deepEqual(mutatingCalls(harness.calls), []);
		});
	}
}

for (const mode of ["drive", "watch"] as const) {
	test(`${mode} mode waits for pending mergeability to become clean`, async (t) => {
		const pending = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" as const };
		const { harness, result } = await run(mode, {
			prObservations: [pending, pending, { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }],
		});
		t.after(() => harness.cleanup());
		assert.equal(result.status, "merge-ready");
		assert.equal(result.prState?.verifiedHeadSha, SHA);
		assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 3);
		assert.deepEqual(harness.waits, [1000]);
		assert.deepEqual(harness.roles, []);
	});
}

test("threads mode reports pending mergeability without polling or model work", async (t) => {
	const { harness, result } = await run("threads", {
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.match(result.blockedReasons.join("; "), /mergeability pending/);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 2);
	assert.deepEqual(harness.waits, []);
	assert.deepEqual(harness.roles, []);
});

test("drive mode stops after five extra pending-mergeability observations", async (t) => {
	const { harness, result } = await run("drive", {
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.deepEqual(result.blockedReasons, ["mergeability pending after 5 additional observations"]);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 7);
	assert.deepEqual(harness.waits, [1000, 1000, 1000, 1000, 1000]);
	assert.deepEqual(harness.roles, []);
});

test("mergeability polling does not reset its budget when the head keeps moving", async (t) => {
	const pending = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" as const };
	const observations = [
		{ ...pending, headSha: SHA },
		{ ...pending, headSha: SHA },
		...Array.from({ length: 5 }, (_, index) => ({ ...pending, headSha: `${index + 1}`.repeat(40) })),
	];
	const { harness, result } = await run("drive", { prObservations: observations });
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.match(result.blockedReasons.join("; "), /mergeability pending after 5/);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 7);
	assert.equal(harness.waits.length, 5);
	assert.deepEqual(harness.roles, []);
});

test("a pending head that moves on the initial settle read enters bounded polling", async (t) => {
	const movedSha = "abcdef0123456789abcdef0123456789abcdef01";
	const { harness, result } = await run("drive", {
		prObservations: [
			{ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", headSha: SHA },
			{ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", headSha: movedSha },
			{ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: movedSha },
		],
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.equal(result.prState?.verifiedHeadSha, movedSha);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 3);
	assert.deepEqual(harness.waits, [1000]);
	assert.deepEqual(harness.roles, []);
});

test("a head that moves during mergeability polling needs a fresh same-head observation", async (t) => {
	const movedSha = "abcdef0123456789abcdef0123456789abcdef01";
	const pending = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" as const, headSha: SHA };
	const cleanMoved = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" as const, headSha: movedSha };
	const { harness, result } = await run("drive", {
		prObservations: [pending, pending, cleanMoved, cleanMoved],
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.equal(result.prState?.headSha, movedSha);
	assert.equal(result.prState?.verifiedHeadSha, movedSha);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 4);
	assert.deepEqual(harness.waits, [1000, 1000]);
	assert.deepEqual(harness.roles, []);
});

test("a PR that closes during mergeability polling ends incomplete", async (t) => {
	const pending = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" as const };
	const { harness, result } = await run("drive", {
		prObservations: [pending, pending, { ...pending, state: "CLOSED" }],
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.match(result.blockedReasons.join("; "), /closed/);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 3);
	assert.deepEqual(harness.waits, [1000]);
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("a failed required read during mergeability polling fails the run", async (t) => {
	const { harness, result } = await run("drive", {
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
		failPrReadAt: 3,
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "failed");
	assert.match(result.blockedReasons.join("; "), /mergeability read failed/);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 3);
	assert.deepEqual(harness.waits, [1000]);
	assert.deepEqual(harness.roles, []);
});

test("a confirmed draft uses bounded mergeability settling after mark-ready", async (t) => {
	const { harness, result } = await run("drive", {
		prObservations: [
			{ isDraft: true, mergeable: "UNKNOWN", mergeStateStatus: "DRAFT" },
			{ isDraft: false, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
			{ isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
		],
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr ready")).length, 1);
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 3);
	assert.deepEqual(harness.waits, [1000]);
	assert.deepEqual(harness.roles, []);
});

test("check mode observes Actions failures without fetching failed logs", async (t) => {
	const { harness, result } = await run("check", {
		checks: [
			{
				name: "build",
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/123",
			},
		],
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "incomplete");
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(failedLogCalls(harness.calls), []);
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

test("a merge-ready readiness pass never validates the PR workspace or fetches failed logs", async (t) => {
	const { harness, result } = await run("drive", { branch: "kstack/other" });
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(failedLogCalls(harness.calls), []);
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
	assert.deepEqual(failedLogCalls(harness.calls), []);
});

test("triage fetches each distinct failed run log once", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [
			{
				name: "build",
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/123",
			},
			{
				name: "unit",
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/123",
			},
			{
				name: "integration",
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/456",
			},
		],
		triage: triage({
			checks: [
				{ key: "check-1", cls: "unknown", action: "report" },
				{ key: "check-2", cls: "unknown", action: "report" },
				{ key: "check-3", cls: "unknown", action: "report" },
			],
		}),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.deepEqual(harness.roles, ["triager"]);
	assert.deepEqual(failedLogCalls(harness.calls), ["gh run view 123 --log-failed", "gh run view 456 --log-failed"]);
});

test("fixer input reuses the failed logs hydrated for its triage cycle", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [
			{
				name: "build",
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/123",
			},
		],
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix build" }] }),
		confirm: false,
	});
	t.after(() => harness.cleanup());

	assert.equal(result.status, "incomplete");
	assert.match(await readFile(join(harness.cwd, "triager-1.md"), "utf8"), /test failed/);
	assert.match(await readFile(join(harness.cwd, "fixer-1.md"), "utf8"), /test failed/);
	assert.deepEqual(failedLogCalls(harness.calls), ["gh run view 123 --log-failed"]);
});

test("cancellation during failed-log hydration launches no model", async (t) => {
	const harness = await createHarness({
		checks: [
			{
				name: "build",
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/123",
			},
		],
	});
	t.after(() => harness.cleanup());
	const hydration = deferred<ExecFnResult>();
	const hydrationStarted = deferred<void>();
	const exec: ExecFn = async (command, args, options) => {
		if (command === "gh" && args[0] === "run" && args[1] === "view") {
			hydrationStarted.resolve();
			return hydration.promise;
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
	await hydrationStarted.promise;
	controller.abort();
	hydration.resolve({ code: 0, stdout: "failure marker\n", stderr: "" });

	const result = await pending;
	assert.equal(result.status, "aborted");
	assert.deepEqual(harness.roles, []);
	assert.deepEqual(mutatingCalls(harness.calls), []);
});

test("a behind PR merges its base and pushes", async (t) => {
	const { harness, result } = await run("drive", { mergeStateStatus: "BEHIND" });
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.ok(harness.calls.some((call) => call === "git fetch origin main"));
	assert.ok(harness.calls.some((call) => call === "git merge --no-edit origin/main"));
	assert.ok(harness.calls.some((call) => call === `git push origin HEAD:${BRANCH}`));
	assert.deepEqual(harness.waits, []);
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

test("a pending reply keeps an otherwise ignored thread visible", async (t) => {
	const body = "Please explain this design";
	const version = versionReviewItem("review-thread", "thread-1", [
		{
			id: "PRRC_7",
			body,
			updatedAt: "2026-09-06T00:00:00Z",
			author: "reviewer",
			path: "src/a.ts",
			line: 1,
		},
	]);
	const { harness, result } = await run("drive", {
		thread: { id: "thread-1", body },
		persisted: {
			schemaVersion: 2,
			repoKey: "repo",
			prNumber: 42,
			headSha: "",
			handled: [{ id: "thread-1", source: "review-thread", version, decision: "ignore" }],
			pendingReviewReplies: [{ id: "thread-1", version: "a".repeat(64) }],
			legacyPendingReplyIds: [],
			flakeRetried: [],
		},
		triage: triage({ threads: [{ key: "thread-1", decision: "ask", action: "inspect pending reply" }] }),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.deepEqual(harness.roles, ["triager"]);
});

test("blocked loaded state allows inspection but prevents review mutations and persistence", async (t) => {
	const { harness, result } = await run("drive", {
		thread: { id: "thread-1", body: "Please explain this design" },
		loaded: {
			kind: "blocked",
			state: {
				schemaVersion: 2,
				repoKey: "repo",
				prNumber: 42,
				headSha: "",
				handled: [],
				pendingReviewReplies: [],
				legacyPendingReplyIds: [],
				flakeRetried: [],
			},
			reviewMutationBlocker: "PR autopilot state needs inspection: unsupported schemaVersion 99.",
		},
		triage: triage({
			threads: [{ key: "thread-1", decision: "dismiss", action: "as intended", reply: "As intended." }],
		}),
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.match(result.blockedReasons.join("; "), /needs inspection/);
	assert.deepEqual(harness.roles, ["triager"]);
	assert.deepEqual(harness.savedStates, []);
	assert.equal(
		harness.calls.some((call) => call.includes("/pulls/42/comments") || call.includes("resolveReviewThread")),
		false,
	);
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

test("a live legacy pending reply blocks before triage or remote mutation", async (t) => {
	const { harness, result } = await run("drive", {
		thread: { id: "thread-1", body: "Please explain this design" },
		persisted: {
			schemaVersion: 2,
			repoKey: "repo",
			prNumber: 42,
			headSha: "",
			handled: [],
			pendingReviewReplies: [],
			legacyPendingReplyIds: ["thread-1"],
			flakeRetried: [],
		},
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.match(result.blockedReasons.join("; "), /Legacy pending replies need inspection/);
	assert.deepEqual(harness.roles, []);
	assert.equal(
		harness.calls.some((call) => call.includes("/pulls/42/comments") || call.includes("resolveReviewThread")),
		false,
	);
});

test("a complete observation removes an absent legacy pending reply", async (t) => {
	const { harness, result } = await run("drive", {
		persisted: {
			schemaVersion: 2,
			repoKey: "repo",
			prNumber: 42,
			headSha: "",
			handled: [],
			pendingReviewReplies: [],
			legacyPendingReplyIds: ["thread-1"],
			flakeRetried: [],
		},
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "merge-ready");
	assert.deepEqual((await harness.ops.loadPersistedState("repo", 42)).state.legacyPendingReplyIds, []);
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

test("drive mode stops at its configured cycle bound and hydrates each cycle afresh", async (t) => {
	const { harness, result } = await run("drive", {
		checks: [
			{
				name: "test",
				state: "FAILURE",
				bucket: "fail",
				link: "https://github.com/example/repo/actions/runs/123",
			},
		],
		triage: triage({ checks: [{ key: "check-1", cls: "code", action: "fix test" }] }),
		fixerChanges: true,
	});
	t.after(() => harness.cleanup());
	assert.equal(result.status, "blocked");
	assert.equal(result.cyclesCompleted, 3);
	assert.ok(result.blockedReasons.some((reason) => reason.includes("max cycles reached")));
	assert.equal(harness.roles.filter((role) => role === "fixer").length, 3);
	assert.equal(failedLogCalls(harness.calls).length, 3);
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
	assert.deepEqual(failedLogCalls(harness.calls), []);
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

const REVIEW_VERSION = versionReviewItem("review-thread", "thread-1", [
	{
		id: "PRRC_7",
		body: "rename this",
		updatedAt: "2026-09-06T00:00:00Z",
		author: "reviewer",
		path: "src/a.ts",
		line: 1,
	},
]);

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

function makeReplyExec(
	overrides: {
		replyCode?: number;
		resolveCode?: number;
		issueReplyCode?: number;
		observationCode?: number;
		observedBody?: string;
		resolvedBeforeMutation?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
			if (args.some((arg) => arg.includes("resolveReviewThread"))) {
				const code = overrides.resolveCode ?? 0;
				return { code, stdout: "", stderr: code === 0 ? "" : "resolve failed" };
			}
			const code = overrides.observationCode ?? 0;
			if (code !== 0) return { code, stdout: "", stderr: "inspection failed" };
			return {
				code: 0,
				stdout: JSON.stringify({
					data: {
						node: {
							id: "thread-1",
							isResolved: overrides.resolvedBeforeMutation ?? false,
							comments: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [
									{
										id: "PRRC_7",
										databaseId: 7,
										body: overrides.observedBody ?? "rename this",
										updatedAt: "2026-09-06T00:00:00Z",
										path: "src/a.ts",
										line: 1,
										author: { login: "reviewer" },
									},
								],
							},
						},
					},
				}),
				stderr: "",
			};
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

function replyOptions(resolveFix: boolean, pendingReviewReplies: Array<{ id: string; version: string }> = []) {
	return { resolveFix, pendingReviewReplies, legacyPendingReplyIds: [] };
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
			version: REVIEW_VERSION,
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
	const pendingReviewReplies: Array<{ id: string; version: string }> = [];
	const handled = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		replyOptions(true, pendingReviewReplies),
		() => {},
	);
	assert.deepEqual(handled, {
		ok: true,
		handled: [{ id: "thread-1", source: "review-thread", version: REVIEW_VERSION, decision: "fix" }],
		pendingReviewReplies: [],
	});
	assert.deepEqual(pendingReviewReplies, []);
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
			version: "issue-version-1",
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
	const result = await applyThreadReplies(exec, "/repo", state, parsed, replyOptions(false), () => {});
	assert.deepEqual(result, {
		ok: true,
		handled: [
			{
				id: "issue-comment-1",
				source: "issue-comment",
				version: "issue-version-1",
				decision: "ignore",
			},
		],
		pendingReviewReplies: [],
	});
	assert.deepEqual(calls, []);
});

test("dismiss decision replies to an issue comment without resolving", async () => {
	const state = makeThreadState([
		{
			id: "issue-comment-1",
			commenter: "reviewer",
			body: "remove this",
			source: "issue-comment",
			replyToId: 1,
			version: "issue-version-1",
		},
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
	const handled = await applyThreadReplies(exec, "/repo", state, parsed, replyOptions(false), () => {});
	assert.deepEqual(handled, {
		ok: true,
		handled: [
			{
				id: "issue-comment-1",
				source: "issue-comment",
				version: "issue-version-1",
				decision: "dismiss",
			},
		],
		pendingReviewReplies: [],
	});
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
			version: REVIEW_VERSION,
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
	const pendingReviewReplies: Array<{ id: string; version: string }> = [];
	const handled = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		replyOptions(true, pendingReviewReplies),
		(message) => warnings.push(message),
	);
	assert.deepEqual(handled, {
		ok: false,
		handled: [],
		pendingReviewReplies: [],
		error: "Could not reply to thread thread-1: reply failed",
	});
	assert.deepEqual(pendingReviewReplies, []);
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
			version: REVIEW_VERSION,
		},
		{
			id: "issue-comment-2",
			commenter: "reviewer",
			body: "remove this",
			source: "issue-comment",
			replyToId: 2,
			version: "issue-version-2",
		},
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
	const result = await applyThreadReplies(exec, "/repo", state, parsed, replyOptions(true), () => {});
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
			version: REVIEW_VERSION,
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
	const pendingReviewReplies: Array<{ id: string; version: string }> = [];
	const handled = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		replyOptions(true, pendingReviewReplies),
		() => {},
	);
	assert.deepEqual(handled, {
		ok: false,
		handled: [],
		pendingReviewReplies: [{ id: "thread-1", version: REVIEW_VERSION }],
		error: "Could not resolve thread thread-1: resolve failed",
	});
	assert.deepEqual(pendingReviewReplies, []);
});

function pendingReplyCase() {
	const state = makeThreadState([
		{
			id: "thread-1",
			commenter: "reviewer",
			body: "rename this",
			path: "src/a.ts",
			line: 1,
			replyToId: 7,
			source: "review-thread",
			version: REVIEW_VERSION,
		},
	]);
	const parsed = parseThreads(
		JSON.stringify({
			checks: [],
			threads: [{ key: "thread-1", decision: "dismiss", action: "as intended", reply: "As intended." }],
			conflicts: false,
			draft: false,
			summary: "",
		}),
	);
	return { state, parsed };
}

test("a matching pending reply resolves without posting twice", async () => {
	const { state, parsed } = pendingReplyCase();
	const { exec, calls } = makeReplyExec();
	const pending = [{ id: "thread-1", version: REVIEW_VERSION }];
	const result = await applyThreadReplies(exec, "/repo", state, parsed, replyOptions(false, pending), () => {});
	assert.equal(result.ok, true);
	assert.deepEqual(result.pendingReviewReplies, []);
	assert.deepEqual(pending, [{ id: "thread-1", version: REVIEW_VERSION }]);
	assert.equal(
		calls.some((call) => call.includes("/pulls/42/comments")),
		false,
	);
	assert.equal(calls.filter((call) => call.includes("resolveReviewThread")).length, 1);
});

test("changed feedback after posting retains pending progress and does not resolve", async () => {
	const { state, parsed } = pendingReplyCase();
	const { exec, calls } = makeReplyExec({ observedBody: "new feedback" });
	const pending: Array<{ id: string; version: string }> = [];
	const result = await applyThreadReplies(exec, "/repo", state, parsed, replyOptions(false, pending), () => {});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /changed after its reply/);
	assert.deepEqual(result.pendingReviewReplies, [{ id: "thread-1", version: REVIEW_VERSION }]);
	assert.deepEqual(pending, []);
	assert.equal(calls.filter((call) => call.includes("/pulls/42/comments")).length, 1);
	assert.equal(
		calls.some((call) => call.includes("resolveReviewThread")),
		false,
	);
});

test("a failed final observation retains pending progress and does not resolve", async () => {
	const { state, parsed } = pendingReplyCase();
	const { exec, calls } = makeReplyExec({ observationCode: 1 });
	const pending: Array<{ id: string; version: string }> = [];
	const result = await applyThreadReplies(exec, "/repo", state, parsed, replyOptions(false, pending), () => {});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /Could not inspect thread/);
	assert.deepEqual(result.pendingReviewReplies, [{ id: "thread-1", version: REVIEW_VERSION }]);
	assert.deepEqual(pending, []);
	assert.equal(
		calls.some((call) => call.includes("resolveReviewThread")),
		false,
	);
});

test("an already resolved thread settles pending progress without another mutation", async () => {
	const { state, parsed } = pendingReplyCase();
	const { exec, calls } = makeReplyExec({ resolvedBeforeMutation: true });
	const pending = [{ id: "thread-1", version: REVIEW_VERSION }];
	const result = await applyThreadReplies(exec, "/repo", state, parsed, replyOptions(false, pending), () => {});
	assert.equal(result.ok, true);
	assert.deepEqual(result.pendingReviewReplies, []);
	assert.deepEqual(pending, [{ id: "thread-1", version: REVIEW_VERSION }]);
	assert.equal(
		calls.some((call) => call.includes("/pulls/42/comments")),
		false,
	);
	assert.equal(
		calls.some((call) => call.includes("resolveReviewThread")),
		false,
	);
});

test("a live legacy pending reply blocks posting and resolution", async () => {
	const { state, parsed } = pendingReplyCase();
	const { exec, calls } = makeReplyExec();
	const result = await applyThreadReplies(
		exec,
		"/repo",
		state,
		parsed,
		{ ...replyOptions(false), legacyPendingReplyIds: ["thread-1"] },
		() => {},
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /legacy pending reply/);
	assert.deepEqual(calls, []);
});
