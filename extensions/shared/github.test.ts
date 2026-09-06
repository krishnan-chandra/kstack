import assert from "node:assert/strict";
import test from "node:test";
import type { ExecFn } from "./git-exec.ts";
import {
	createGitHubGateway,
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

test("head gateway sends the exact owner and ref as a paginated server filter", async () => {
	const head = "feature/slash;$HOME&literal";
	const signal = new AbortController().signal;
	const exec: ExecFn = async (command, args, options) => {
		assert.equal(command, "gh");
		assert.deepEqual(args, [
			"api",
			"--method",
			"GET",
			"/repos/Acme/Widgets/pulls",
			"--field",
			"state=all",
			"--field",
			"per_page=100",
			"--raw-field",
			`head=Acme:${head}`,
			"--paginate",
			"--jq",
			".[] | {number, headRefName: .head.ref, headCommitId: .head.sha, baseRefName: .base.ref, title, isDraft: .draft, url: .html_url, headRepository: {nameWithOwner: .head.repo.full_name}, headRepositoryOwner: {login: .head.repo.owner.login}}",
		]);
		assert.equal(options.cwd, "/repo path");
		assert.equal(options.timeout, 30_000);
		assert.equal(options.signal, signal);
		return {
			code: 0,
			stdout: [
				JSON.stringify([
					{
						number: 41,
						headRefName: head,
						headCommitId: "first",
						baseRefName: "main",
						title: "First match",
						isDraft: false,
						url: "https://github.com/acme/widgets/pull/41",
						headRepository: { nameWithOwner: "ACME/WIDGETS" },
						headRepositoryOwner: { login: "ACME" },
					},
					{
						number: 42,
						headRefName: `${head}-other`,
						headCommitId: "wrong-ref",
						baseRefName: "main",
						headRepository: { nameWithOwner: "Acme/Widgets" },
						headRepositoryOwner: { login: "Acme" },
					},
				]),
				"[]",
				JSON.stringify([
					{
						number: 43,
						headRefName: head,
						headCommitId: "foreign-fork",
						baseRefName: "main",
						headRepository: { nameWithOwner: "other/widgets" },
						headRepositoryOwner: { login: "other" },
					},
					{
						number: 44,
						headRefName: head,
						headCommitId: "historical-match",
						baseRefName: "previous",
						title: "Historical match",
						isDraft: true,
						url: "https://github.com/acme/widgets/pull/44",
						headRepository: { nameWithOwner: "acme/widgets" },
						headRepositoryOwner: { login: "acme" },
					},
				]),
			].join("\n"),
			stderr: "",
		};
	};

	const prs = await createGitHubGateway(exec).listPrsForHead(
		{ owner: "Acme", repo: "Widgets" },
		head,
		"/repo path",
		signal,
	);

	assert.deepEqual(
		prs.map((pr) => ({ number: pr.number, headRef: pr.headRef, headOwner: pr.headOwner })),
		[
			{ number: 41, headRef: head, headOwner: "ACME" },
			{ number: 44, headRef: head, headOwner: "acme" },
		],
	);
});

test("gateway leaves open PR requests unfiltered and accepts empty results", async () => {
	let args: string[] = [];
	const exec: ExecFn = async (_command, receivedArgs) => {
		args = receivedArgs;
		return { code: 0, stdout: "\n", stderr: "" };
	};

	assert.deepEqual(await createGitHubGateway(exec).listOpenPrs({ owner: "acme", repo: "widgets" }, "/repo"), []);
	assert.deepEqual(args, [
		"api",
		"--method",
		"GET",
		"/repos/acme/widgets/pulls",
		"--field",
		"state=open",
		"--field",
		"per_page=100",
		"--paginate",
		"--jq",
		".[] | {number, headRefName: .head.ref, headCommitId: .head.sha, baseRefName: .base.ref, title, isDraft: .draft, url: .html_url, headRepository: {nameWithOwner: .head.repo.full_name}, headRepositoryOwner: {login: .head.repo.owner.login}}",
	]);
});

test("head gateway preserves malformed-output and API failure behavior", async () => {
	const malformed: ExecFn = async () => ({ code: 0, stdout: "{", stderr: "" });
	await assert.rejects(
		createGitHubGateway(malformed).listPrsForHead({ owner: "acme", repo: "widgets" }, "feature", "/repo"),
		/Could not parse GitHub JSON sequence/,
	);

	const failed: ExecFn = async () => ({ code: 1, stdout: "", stderr: "permission denied" });
	await assert.rejects(
		createGitHubGateway(failed).listPrsForHead({ owner: "acme", repo: "widgets" }, "feature", "/repo"),
		/gh api failed: permission denied/,
	);
});
