import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import { runCleanup } from "./autopilot-operations.ts";
import { runAutopilot } from "./driver.ts";
import { config, createHarness, deferred, type Harness, MERGED_SHA, SHA, triage } from "./test-harness.ts";
import type { AutopilotMode } from "./types.ts";

function driveProbe(
	harness: Harness,
	controller: Pick<AbortController, "signal">,
	mode: AutopilotMode = "drive",
	backend = new GitBackend(harness.exec),
) {
	return runAutopilot(
		mode,
		{
			config,
			exec: harness.exec,
			backend,
			cwd: harness.cwd,
			repository: "owner/repo",
			explicitPR: 42,
			promptDir: harness.cwd,
			triagerPromptFile: join(harness.cwd, "triager.md"),
			fixerPromptFile: join(harness.cwd, "fixer.md"),
		},
		harness.handlers,
		controller.signal,
		harness.ops,
	);
}
const fixScenario = {
	thread: { id: "thread-1", body: "Please fix this" },
	triage: triage({ threads: [{ key: "thread-1", decision: "fix", cls: "code", action: "fix", reply: "fixed" }] }),
	fixerChanges: true,
};

test("cancellation during fixer task write launches no fixer", async (t) => {
	const harness = await createHarness(fixScenario);
	t.after(() => harness.cleanup());
	const started = deferred<void>();
	const released = deferred<void>();
	const originalWrite = fsPromises.writeFile;
	const mockedWrite = t.mock.method(
		fsPromises,
		"writeFile",
		async (...args: Parameters<typeof fsPromises.writeFile>) => {
			if (String(args[0]).includes("fixer-1.md")) {
				started.resolve();
				await released.promise;
			}
			return originalWrite(...args);
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		mockedWrite.mock.restore();
		syncBuiltinESMExports();
	});
	const controller = new AbortController();
	const pending = driveProbe(harness, controller);
	await started.promise;
	controller.abort();
	released.resolve();
	const result = await pending;
	assert.equal(result.status, "aborted");
	assert.deepEqual(harness.roles, ["triager"]);
});

test("cancellation during a mergeability wait stops before the next observation", async (t) => {
	const harness = await createHarness({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
	t.after(() => harness.cleanup());
	const waitStarted = deferred<void>();
	const releaseWait = deferred<void>();
	harness.ops.sleep = async (delayMs, signal) => {
		assert.equal(delayMs, 1000);
		waitStarted.resolve();
		await releaseWait.promise;
		signal.throwIfAborted();
	};
	const controller = new AbortController();
	const pending = driveProbe(harness, controller);
	await waitStarted.promise;
	controller.abort();
	releaseWait.resolve();
	const result = await pending;
	assert.equal(result.status, "aborted");
	assert.equal(harness.calls.filter((call) => call.startsWith("gh pr view")).length, 2);
	assert.deepEqual(harness.roles, []);
});

test("aborted final threads refresh returns aborted", async (t) => {
	const harness = await createHarness({
		issueComment: { id: 9, body: "Thanks for the update" },
		checks: [{ name: "test", state: "FAILURE", bucket: "fail" }],
		triage: triage({ threads: [{ key: "thread-1", decision: "ignore", action: "informational" }] }),
	});
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const exec = harness.exec;
	let views = 0;
	harness.exec = async (...args) => {
		const result = await exec(...args);
		if (args[0] === "gh" && args[1][0] === "pr" && args[1][1] === "view") {
			views++;
			if (views === 2) controller.abort();
		}
		return result;
	};
	const result = await driveProbe(harness, controller, "threads");
	assert.equal(views, 2);
	assert.equal(result.status, "aborted");
});

test("review-pagination cancellation remains aborted in check, drive, and watch modes", async (t) => {
	for (const mode of ["check", "drive", "watch"] as const) {
		const harness = await createHarness();
		t.after(() => harness.cleanup());
		const controller = new AbortController();
		const notices: Array<{ message: string; level: string }> = [];
		harness.handlers.notify = (message, level) => notices.push({ message, level });
		const exec = harness.exec;
		harness.exec = async (...args) => {
			const result = await exec(...args);
			if (
				args[0] === "gh" &&
				args[1][0] === "api" &&
				args[1][1] === "graphql" &&
				args[1].some((arg) => arg.includes("reviewThreads(first: 50"))
			) {
				const payload = JSON.parse(result.stdout);
				payload.data.repository.pullRequest.reviewThreads.pageInfo = {
					hasNextPage: true,
					endCursor: "next-thread-page",
				};
				controller.abort();
				return { ...result, stdout: JSON.stringify(payload) };
			}
			return result;
		};

		const result = await driveProbe(harness, controller, mode);
		assert.equal(result.status, "aborted", `${mode} mode must preserve cancellation`);
		assert.deepEqual(result.blockedReasons, ["aborted by user"]);
		assert.equal(
			notices.some(({ message, level }) => level === "error" && message.includes("Could not fetch review threads")),
			false,
		);
	}
});

test("unpublished local recording is visible in driver notifications", async (t) => {
	const harness = await createHarness(fixScenario);
	t.after(() => harness.cleanup());
	const notices: string[] = [];
	harness.handlers.notify = (message) => notices.push(message);
	const controller = new AbortController();
	const backend = new GitBackend(harness.exec);
	const record = backend.recordPaths.bind(backend);
	backend.recordPaths = async (...args) => {
		const result = await record(...args);
		controller.abort();
		return result;
	};
	const result = await driveProbe(harness, controller, "drive", backend);
	assert.equal(result.status, "aborted");
	assert.match(result.blockedReasons.join("; "), /recorded fixes locally/);
	assert.ok(!harness.calls.some((call) => call.startsWith("git push")));
	assert.match(notices.join("\n"), /recorded fixes locally|remain unpublished/);
});

test("cancellation during last base publication reports aborted after saving head", async (t) => {
	const harness = await createHarness({ mergeStateStatus: "BEHIND" });
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const backend = new GitBackend(harness.exec);
	const publish = backend.publishRecordedChanges.bind(backend);
	let pushes = 0;
	backend.publishRecordedChanges = async (...args) => {
		const result = await publish(...args);
		pushes++;
		controller.abort();
		return result;
	};
	const result = await driveProbe(harness, controller, "threads", backend);
	assert.equal(pushes, 1);
	assert.equal((await harness.ops.loadPersistedState("repo", 42)).state.headSha, MERGED_SHA);
	assert.equal(result.status, "aborted");
});

test("cancellation after successful reply preserves pending resolution", async (t) => {
	const harness = await createHarness({
		thread: { id: "thread-1", body: "Please explain this" },
		triage: triage({
			threads: [{ key: "thread-1", decision: "dismiss", action: "as intended", reply: "as intended" }],
		}),
	});
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const exec = harness.exec;
	harness.exec = async (...args) => {
		if (args[0] === "gh" && args[1].some((arg) => arg.includes("/pulls/42/comments"))) {
			controller.abort();
			return { code: 0, stdout: "{}", stderr: "" };
		}
		return exec(...args);
	};
	const result = await driveProbe(harness, controller);
	assert.equal(result.status, "aborted");
	const persisted = (await harness.ops.loadPersistedState("repo", 42)).state;
	assert.deepEqual(
		persisted.pendingReviewReplies.map((record) => record.id),
		["thread-1"],
	);
	assert.deepEqual(persisted.handled, []);
	assert.ok(!harness.calls.some((call) => call.includes("resolveReviewThread")));
});

test("cancellation retains failed in-flight reply in result diagnostics", async (t) => {
	const harness = await createHarness({
		thread: { id: "thread-1", body: "Please explain this" },
		triage: triage({
			threads: [{ key: "thread-1", decision: "dismiss", action: "as intended", reply: "as intended" }],
		}),
	});
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const exec = harness.exec;
	harness.exec = async (...args) => {
		if (args[0] === "gh" && args[1].some((arg) => arg.includes("/pulls/42/comments"))) {
			controller.abort();
			return { code: 1, stdout: "", stderr: "remote reply response lost" };
		}
		return exec(...args);
	};
	const result = await driveProbe(harness, controller);
	assert.equal(result.status, "aborted");
	assert.match(result.blockedReasons.join("; "), /remote reply response lost/);
});

test("cleanup confirmation after abort cannot remove worktree", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const backend = new GitBackend(harness.exec);
	let removed = 0;
	backend.isolation.remove = async () => {
		removed++;
		return { ok: true };
	};
	const confirmed = deferred<boolean>();
	const started = deferred<void>();
	const pending = runCleanup(
		backend,
		harness.cwd,
		async () => {
			started.resolve();
			return confirmed.promise;
		},
		() => {},
		controller.signal,
	);
	await started.promise;
	controller.abort();
	confirmed.resolve(true);
	assert.equal(await pending, false);
	assert.equal(removed, 0);
});

import { AutopilotLifecycle } from "./lifecycle.ts";

test("shutdown during first refresh stops before base update", async (t) => {
	const harness = await createHarness({ mergeStateStatus: "BEHIND" });
	t.after(() => harness.cleanup());
	const lifecycle = new AutopilotLifecycle();
	lifecycle.startSession();
	const token = lifecycle.beginRun(lifecycle.currentSessionToken()!);
	const signal = lifecycle.runSignal(token!)!;
	const started = deferred<void>();
	const released = deferred<void>();
	const original = harness.exec;
	harness.exec = async (...args) => {
		if (args[0] === "gh" && args[1][0] === "pr" && args[1][1] === "view") {
			started.resolve();
			await released.promise;
		}
		return original(...args);
	};
	const pending = driveProbe(harness, { signal });
	await started.promise;
	lifecycle.shutdownSession();
	released.resolve();
	assert.equal((await pending).status, "aborted");
	assert.deepEqual(harness.roles, []);
	assert.ok(!harness.calls.some((call) => /^git (fetch|merge|push|add|commit)/.test(call)));
});

test("draft-ready confirmation cannot dispatch after abort", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const exec = harness.exec;
	let readies = 0;
	harness.exec = async (...args) => {
		if (args[0] === "gh" && args[1][0] === "pr" && args[1][1] === "ready") readies++;
		const result = await exec(...args);
		if (args[0] === "gh" && args[1][0] === "pr" && args[1][1] === "view") {
			const pr = JSON.parse(result.stdout);
			return { ...result, stdout: JSON.stringify({ ...pr, isDraft: true, mergeStateStatus: "DRAFT" }) };
		}
		return result;
	};
	harness.handlers.confirm = async () => {
		controller.abort();
		return true;
	};
	assert.equal((await driveProbe(harness, controller)).status, "aborted");
	assert.equal(readies, 0);
});

test("abort during first CI rerun prevents second rerun and persists first", async (t) => {
	const harness = await createHarness({
		checks: [
			{ name: "a", state: "FAILURE", bucket: "fail", link: "https://github.com/owner/repo/actions/runs/1/job/1" },
			{ name: "b", state: "FAILURE", bucket: "fail", link: "https://github.com/owner/repo/actions/runs/2/job/2" },
		],
		triage: triage({
			checks: [
				{ key: "check-1", cls: "flake", action: "retry" },
				{ key: "check-2", cls: "flake", action: "retry" },
			],
		}),
	});
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const exec = harness.exec;
	let reruns = 0;
	harness.exec = async (...args) => {
		const result = await exec(...args);
		if (args[0] === "gh" && args[1][0] === "run" && args[1][1] === "rerun") {
			reruns++;
			controller.abort();
		}
		return result;
	};
	assert.equal((await driveProbe(harness, controller)).status, "aborted");
	assert.equal(reruns, 1);
	assert.deepEqual((await harness.ops.loadPersistedState("repo", 42)).state.flakeRunRetries, [
		{ runId: "1", headSha: SHA },
	]);
});

test("failed publication in flight keeps its diagnostic and is not retried", async (t) => {
	const harness = await createHarness(fixScenario);
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const backend = new GitBackend(harness.exec);
	let pushes = 0;
	backend.publishRecordedChanges = async () => {
		pushes++;
		controller.abort();
		return { ok: false, error: "remote push response lost" };
	};
	const result = await driveProbe(harness, controller, "drive", backend);
	assert.match(result.blockedReasons.join("; "), /remote push response lost/);
	assert.equal(pushes, 1);
	assert.ok(!harness.calls.some((call) => call.includes("resolveReviewThread")));
});

test("successful publication in flight persists head and never replies", async (t) => {
	const harness = await createHarness(fixScenario);
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const backend = new GitBackend(harness.exec);
	let pushes = 0;
	backend.publishRecordedChanges = async () => {
		pushes++;
		controller.abort();
		return { ok: true };
	};
	const notices: string[] = [];
	harness.handlers.notify = (message) => notices.push(message);
	const result = await driveProbe(harness, controller, "drive", backend);
	assert.equal(result.status, "aborted");
	assert.equal(pushes, 1);
	assert.equal((await harness.ops.loadPersistedState("repo", 42)).state.headSha, SHA);
	assert.match(notices.join("; "), /Pushed to/);
	assert.ok(!harness.calls.some((call) => call.includes("resolveReviewThread") || call.includes("/pulls/42/comments")));
});

test("abort after first resolution stops next reply and saves handled item", async (t) => {
	const harness = await createHarness({
		thread: { id: "thread-1", body: "Please explain this" },
		issueComment: { id: 9, body: "Please clarify" },
		triage: triage({
			threads: [
				{ key: "thread-1", decision: "dismiss", action: "as intended", reply: "as intended" },
				{ key: "thread-2", decision: "dismiss", action: "as intended", reply: "as intended" },
			],
		}),
	});
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const exec = harness.exec;
	let replies = 0;
	let resolutions = 0;
	harness.exec = async (...args) => {
		if (args[0] === "gh" && args[1].some((arg) => arg.includes("/pulls/42/comments"))) {
			replies++;
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (args[0] === "gh" && args[1][0] === "pr" && args[1][1] === "comment") replies++;
		const result = await exec(...args);
		if (args[0] === "gh" && args[1].some((arg) => arg.includes("resolveReviewThread"))) {
			resolutions++;
			controller.abort();
		}
		return result;
	};
	assert.equal((await driveProbe(harness, controller)).status, "aborted");
	assert.equal(replies, 1);
	assert.equal(resolutions, 1);
	const persisted = (await harness.ops.loadPersistedState("repo", 42)).state;
	assert.deepEqual(
		persisted.handled.map((record) => record.id),
		["thread-1"],
	);
	assert.deepEqual(persisted.pendingReviewReplies, []);
});

test("cleanup already in flight settles and reports removal", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const backend = new GitBackend(harness.exec);
	const started = deferred<void>();
	const released = deferred<{ ok: true }>();
	const notices: string[] = [];
	backend.isolation.remove = async () => {
		started.resolve();
		return released.promise;
	};
	harness.handlers.notify = (message) => notices.push(message);
	const pending = driveProbe(harness, controller, "cleanup", backend);
	await started.promise;
	controller.abort();
	released.resolve({ ok: true });
	assert.equal((await pending).status, "aborted");
	assert.match(notices.join("; "), /Managed worktree and branch removed/);
});

test("cancellation between readiness evaluation and return still finalizes as aborted", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	harness.handlers.notify = (message) => {
		if (message.includes("looks merge-ready")) queueMicrotask(() => controller.abort());
	};
	const result = await driveProbe(harness, controller);
	assert.equal(result.status, "aborted");
	assert.equal(result.mergeReady, false);
});

test("an already cancelled run performs no reads or mutations", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	controller.abort();
	assert.equal((await driveProbe(harness, controller)).status, "aborted");
	assert.deepEqual(harness.calls, []);
	assert.deepEqual(harness.roles, []);
});

test("cancellation after a child settles preserves accumulated usage and current PR state", async (t) => {
	const harness = await createHarness(fixScenario);
	t.after(() => harness.cleanup());
	const controller = new AbortController();
	const childStarted = deferred<void>();
	const childDone = deferred<void>();
	const used = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5, turns: 2 };
	harness.ops.runChildRole = async () => {
		childStarted.resolve();
		await childDone.promise;
		return { ok: true, output: triage(), usage: used };
	};
	const pending = driveProbe(harness, controller);
	await childStarted.promise;
	controller.abort();
	childDone.resolve();
	const result = await pending;
	assert.equal(result.status, "aborted");
	assert.deepEqual(result.usage, used);
	assert.equal(result.prState?.headSha, SHA);
	assert.equal(result.cyclesCompleted, 0);
});
