import assert from "node:assert/strict";
import test from "node:test";
import type { ExecFn } from "./git-exec.ts";
import {
	findOpenPullRequestByHead,
	getPullRequest,
	getRepository,
	mergePullRequest,
	type PullRequestSnapshot,
	type RepositorySnapshot,
} from "./github.ts";

const SHA = "a".repeat(40);

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
