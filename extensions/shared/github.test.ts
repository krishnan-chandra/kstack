import assert from "node:assert/strict";
import test from "node:test";
import type { ExecFn } from "./git-exec.ts";
import {
	findOpenPullRequestByHead,
	getPullRequest,
	getPullRequestReviewTarget,
	getRepository,
	ghExec,
	mergePullRequest,
	type PullRequestSnapshot,
	type RepositorySnapshot,
	resolveRepoName,
	resolveRepoNameResult,
} from "./github.ts";

const SHA = "a".repeat(40);

test("ghExec passes successful results through and converts execution failures to envelopes", async () => {
	const success = { code: 0, stdout: "ok", stderr: "" };
	const successfulExec: ExecFn = async () => success;
	assert.equal(await ghExec(successfulExec, "/repo", ["status"]), success);

	const failedExec: ExecFn = async () => {
		throw new Error("gh unavailable");
	};
	assert.deepEqual(await ghExec(failedExec, "/repo", ["status"]), {
		code: 1,
		stdout: "",
		stderr: "gh unavailable",
	});

	const nonErrorExec: ExecFn = async () => {
		throw "gh unavailable";
	};
	assert.deepEqual(await ghExec(nonErrorExec, "/repo", ["status"]), {
		code: 1,
		stdout: "",
		stderr: "gh unavailable",
	});
});

test("ghExec retains the 15-second default, custom timeout, and signal", async () => {
	let options: { timeout?: number; signal?: AbortSignal } | undefined;
	const exec: ExecFn = async (_command, _args, received) => {
		options = received;
		return { code: 0, stdout: "", stderr: "" };
	};
	await ghExec(exec, "/repo", ["status"]);
	assert.equal(options?.timeout, 15_000);

	const controller = new AbortController();
	await ghExec(exec, "/repo", ["status"], 20_000, controller.signal);
	assert.equal(options?.timeout, 20_000);
	assert.equal(options?.signal, controller.signal);
});

test("resolveRepoName accepts only a trimmed owner/name result", async () => {
	const valid: ExecFn = async () => ({ code: 0, stdout: " owner/repo\n", stderr: "" });
	assert.equal(await resolveRepoName(valid, "/repo"), "owner/repo");

	const failed = { code: 1, stdout: "owner/repo", stderr: "not authenticated" };
	const failedExec: ExecFn = async () => failed;
	assert.deepEqual(await resolveRepoNameResult(failedExec, "/repo"), { ...failed, repo: undefined });

	for (const output of [
		{ code: 0, stdout: "", stderr: "" },
		{ code: 0, stdout: "owner only", stderr: "" },
	]) {
		const exec: ExecFn = async () => output;
		assert.equal(await resolveRepoName(exec, "/repo"), undefined);
	}
});

test("parses repository policy and a pinned PR snapshot", async () => {
	const outputs = [
		JSON.stringify({
			nameWithOwner: "o/r",
			defaultBranchRef: { name: "main" },
			squashMergeAllowed: true,
			rebaseMergeAllowed: true,
		}),
		JSON.stringify({
			number: 3,
			url: "https://github.com/o/r/pull/3",
			title: "x",
			state: "OPEN",
			isDraft: false,
			headRefName: "feature",
			baseRefName: "main",
			headRefOid: SHA,
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			mergedAt: null,
			mergeCommit: null,
		}),
	];
	const exec: ExecFn = async () => ({ code: 0, stdout: outputs.shift() ?? "", stderr: "" });
	const repository: RepositorySnapshot = await getRepository(exec, "/repo");
	assert.deepEqual(repository, {
		nameWithOwner: "o/r",
		defaultBranch: "main",
		allowedMethods: ["squash", "rebase"],
	});
	const pullRequest: PullRequestSnapshot = await getPullRequest(exec, "/repo", 3);
	assert.equal(pullRequest.headOid, SHA);
});

test("parses the extra pinned fields needed for PR review", async () => {
	const exec: ExecFn = async () => ({
		code: 0,
		stdout: JSON.stringify({
			number: 3,
			url: "https://github.com/o/r/pull/3",
			title: "x",
			state: "OPEN",
			baseRefName: "main",
			headRefOid: SHA,
			baseRefOid: "b".repeat(40),
		}),
		stderr: "",
	});
	const target = await getPullRequestReviewTarget(exec, "/repo", 3);
	assert.deepEqual(target, {
		number: 3,
		url: "https://github.com/o/r/pull/3",
		title: "x",
		state: "OPEN",
		baseRef: "main",
		headOid: SHA,
		baseOid: "b".repeat(40),
	});
});

test("builds allowedMethods from squash and rebase only, ignoring merge commit capability", async () => {
	const exec: ExecFn = async () => ({
		code: 0,
		stdout: JSON.stringify({
			nameWithOwner: "o/r",
			defaultBranchRef: { name: "main" },
			squashMergeAllowed: true,
			rebaseMergeAllowed: false,
		}),
		stderr: "",
	});
	assert.deepEqual(await getRepository(exec, "/repo"), {
		nameWithOwner: "o/r",
		defaultBranch: "main",
		allowedMethods: ["squash"],
	});
});

test("resolves exactly one open PR for the current branch", async () => {
	const exec: ExecFn = async () => ({
		code: 0,
		stdout: JSON.stringify([{ number: 8, headRefName: "feature" }]),
		stderr: "",
	});
	assert.equal(await findOpenPullRequestByHead(exec, "/repo", "feature"), 8);
});

test("honors a custom query timeout", async () => {
	let timeout: number | undefined;
	const exec: ExecFn = async (_command, _args, options) => {
		timeout = options.timeout;
		return {
			code: 0,
			stdout: JSON.stringify([{ number: 8, headRefName: "feature" }]),
			stderr: "",
		};
	};
	await findOpenPullRequestByHead(exec, "/repo", "feature", undefined, { queryMs: 42 });
	assert.equal(timeout, 42);
});

test("rejects ambiguous branch mappings", async () => {
	const exec: ExecFn = async () => ({
		code: 0,
		stdout: JSON.stringify([
			{ number: 8, headRefName: "feature" },
			{ number: 9, headRefName: "feature" },
		]),
		stderr: "",
	});
	await assert.rejects(findOpenPullRequestByHead(exec, "/repo", "feature"), /exactly one.*found 2/i);
});

test("merge invocation pins the exact head and never bypasses protection", async () => {
	let seen: string[] = [];
	const exec: ExecFn = async (_command, args) => {
		seen = args;
		return { code: 0, stdout: "", stderr: "" };
	};
	await mergePullRequest(exec, "/repo", 3, "squash", SHA);
	assert.deepEqual(seen, ["pr", "merge", "3", "--squash", "--match-head-commit", SHA]);
	assert.equal(seen.includes("--admin"), false);
});
