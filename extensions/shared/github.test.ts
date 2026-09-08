import assert from "node:assert/strict";
import test from "node:test";
import type { ExecFn } from "./git-exec.ts";
import {
	createGitHubGateway,
	type DeleteRemoteBranchResult,
	findOpenPullRequestByHead,
	GitHubError,
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

test("mergePullRequest rejects an already-aborted signal with zero exec calls", async () => {
	let calls = 0;
	const controller = new AbortController();
	controller.abort();
	const exec: ExecFn = async () => {
		calls++;
		return { code: 0, stdout: "", stderr: "" };
	};
	await assert.rejects(
		mergePullRequest(exec, "/repo", 3, "squash", SHA, controller.signal),
		(error) => error instanceof GitHubError && error.kind === "failed" && /aborted before dispatch/.test(error.message),
	);
	assert.equal(calls, 0);
});

test("mergePullRequest classifies a killed result as indeterminate", async () => {
	const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "signal: killed", killed: true });
	await assert.rejects(
		mergePullRequest(exec, "/repo", 3, "squash", SHA),
		(error) => error instanceof GitHubError && error.kind === "indeterminate",
	);
});

test("mergePullRequest classifies a rejected exec promise as indeterminate", async () => {
	const exec: ExecFn = async () => {
		throw new Error("subprocess disconnected");
	};
	await assert.rejects(
		mergePullRequest(exec, "/repo", 3, "squash", SHA),
		(error) => error instanceof GitHubError && error.kind === "indeterminate",
	);
});

test("mergePullRequest classifies an un-killed nonzero exit as failed with its diagnostic", async () => {
	const exec: ExecFn = async () => ({
		code: 1,
		stdout: "",
		stderr: "GraphQL: Pull Request is not mergeable",
		killed: false,
	});
	await assert.rejects(
		mergePullRequest(exec, "/repo", 3, "squash", SHA),
		(error) =>
			error instanceof GitHubError &&
			error.kind === "failed" &&
			/GraphQL: Pull Request is not mergeable/.test(error.message),
	);
});

test("runGh classifies mutations according to the evidence table", async () => {
	let calls = 0;
	const controller = new AbortController();
	controller.abort();
	const gatewayAborted = createGitHubGateway(async () => {
		calls++;
		return { code: 0, stdout: "", stderr: "" };
	});
	await assert.rejects(
		gatewayAborted.markPrReady({ owner: "o", repo: "r" }, 3, "/repo", controller.signal),
		(error) => error instanceof GitHubError && error.kind === "failed",
	);
	assert.equal(calls, 0);

	const gatewayKilled = createGitHubGateway(async () => ({ code: 1, stdout: "", stderr: "timeout", killed: true }));
	await assert.rejects(
		gatewayKilled.markPrReady({ owner: "o", repo: "r" }, 3, "/repo"),
		(error) => error instanceof GitHubError && error.kind === "indeterminate",
	);

	const gatewayRefusal = createGitHubGateway(async () => ({ code: 1, stdout: "", stderr: "not found", killed: false }));
	await assert.rejects(
		gatewayRefusal.markPrReady({ owner: "o", repo: "r" }, 3, "/repo"),
		(error) => error instanceof GitHubError && error.kind === "failed" && /not found/.test(error.message),
	);
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

test("deleteRemoteBranch deletes an unchanged remote branch at the expected head SHA", async () => {
	const calls: string[][] = [];
	const exec: ExecFn = async (_command, args) => {
		calls.push(args);
		if (args[1]?.includes("/git/ref/heads/feature")) {
			return { code: 0, stdout: `${SHA}\n`, stderr: "" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return { code: 0, stdout: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	const result: DeleteRemoteBranchResult = await gateway.deleteRemoteBranch({
		repo: { owner: "acme", repo: "widgets" },
		branch: "feature",
		expectedHeadSha: SHA,
		cwd: "/repo",
	});

	assert.deepEqual(result, { kind: "deleted" });
	assert.equal(calls.length, 3);
	assert.ok(calls[0].includes("/repos/acme/widgets/git/ref/heads/feature"));
	assert.ok(calls[1].includes("/repos/acme/widgets"));
	assert.ok(calls[2].includes("repositoryId=R_node123"));
	assert.ok(calls[2].includes("name=refs/heads/feature"));
	assert.ok(calls[2].includes(`beforeOid=${SHA}`));
	assert.ok(calls[2].includes(`afterOid=${"0".repeat(40)}`));
	for (const field of [
		"repositoryId=R_node123",
		"name=refs/heads/feature",
		`beforeOid=${SHA}`,
		`afterOid=${"0".repeat(40)}`,
	]) {
		assert.equal(calls[2][calls[2].indexOf(field) - 1], "-f", `${field} must remain a JSON string`);
	}
});

test("deleteRemoteBranch short-circuits when the remote branch is already gone", async () => {
	const calls: string[][] = [];
	const exec: ExecFn = async (_command, args) => {
		calls.push(args);
		return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
	};

	const gateway = createGitHubGateway(exec);
	const result = await gateway.deleteRemoteBranch({
		repo: { owner: "acme", repo: "widgets" },
		branch: "feature",
		expectedHeadSha: SHA,
		cwd: "/repo",
	});

	assert.deepEqual(result, { kind: "already-gone" });
	assert.equal(calls.length, 1);
});

test("deleteRemoteBranch skips deletion when the remote head already changed before mutation", async () => {
	const calls: string[][] = [];
	const otherSha = "b".repeat(40);
	const exec: ExecFn = async (_command, args) => {
		calls.push(args);
		return { code: 0, stdout: `${otherSha}\n`, stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	const result = await gateway.deleteRemoteBranch({
		repo: { owner: "acme", repo: "widgets" },
		branch: "feature",
		expectedHeadSha: SHA,
		cwd: "/repo",
	});

	assert.deepEqual(result, { kind: "changed", actualHeadSha: otherSha });
	assert.equal(calls.length, 1);
});

test("deleteRemoteBranch classifies concurrent remote change during mutation via re-read", async () => {
	let callCount = 0;
	const otherSha = "c".repeat(40);
	const exec: ExecFn = async (_command, args) => {
		callCount++;
		if (args[1]?.includes("/git/ref/heads/feature")) {
			// First read matches expected SHA; post-failure read returns changed SHA
			return { code: 0, stdout: `${callCount === 1 ? SHA : otherSha}\n`, stderr: "" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return { code: 1, stdout: "", stderr: "updateRefs failed: stale oid" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	const result = await gateway.deleteRemoteBranch({
		repo: { owner: "acme", repo: "widgets" },
		branch: "feature",
		expectedHeadSha: SHA,
		cwd: "/repo",
	});

	assert.deepEqual(result, { kind: "changed", actualHeadSha: otherSha });
});

test("deleteRemoteBranch classifies concurrent remote deletion during mutation via re-read", async () => {
	let callCount = 0;
	const exec: ExecFn = async (_command, args) => {
		callCount++;
		if (args[1]?.includes("/git/ref/heads/feature")) {
			if (callCount === 1) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return { code: 1, stdout: "", stderr: "updateRefs failed: ref not found" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	const result = await gateway.deleteRemoteBranch({
		repo: { owner: "acme", repo: "widgets" },
		branch: "feature",
		expectedHeadSha: SHA,
		cwd: "/repo",
	});

	assert.deepEqual(result, { kind: "already-gone" });
});

test("deleteRemoteBranch preserves rejection when re-read confirms head is unchanged", async () => {
	const exec: ExecFn = async (_command, args) => {
		if (args[1]?.includes("/git/ref/heads/feature")) {
			return { code: 0, stdout: `${SHA}\n`, stderr: "" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return { code: 1, stdout: "", stderr: "protected branch deletion forbidden" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	await assert.rejects(
		gateway.deleteRemoteBranch({
			repo: { owner: "acme", repo: "widgets" },
			branch: "feature",
			expectedHeadSha: SHA,
			cwd: "/repo",
		}),
		/protected branch deletion forbidden/,
	);
});

test("deleteRemoteBranch detects GraphQL errors in exit-0 response", async () => {
	const exec: ExecFn = async (_command, args) => {
		if (args[1]?.includes("/git/ref/heads/feature")) {
			return { code: 0, stdout: `${SHA}\n`, stderr: "" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return {
				code: 0,
				stdout: JSON.stringify({ errors: [{ message: "ref is protected" }] }),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	await assert.rejects(
		gateway.deleteRemoteBranch({
			repo: { owner: "acme", repo: "widgets" },
			branch: "feature",
			expectedHeadSha: SHA,
			cwd: "/repo",
		}),
		/ref is protected/,
	);
});

test("deleteRemoteBranch rethrows GraphQL error when recovery read fails", async () => {
	let readCount = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[1]?.includes("/git/ref/heads/feature")) {
			readCount++;
			if (readCount === 1) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
			return { code: 1, stdout: "", stderr: "rate limit exceeded" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return {
				code: 0,
				stdout: JSON.stringify({ errors: [{ message: "mutation failed: branch rule locked" }] }),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	await assert.rejects(
		gateway.deleteRemoteBranch({
			repo: { owner: "acme", repo: "widgets" },
			branch: "feature",
			expectedHeadSha: SHA,
			cwd: "/repo",
		}),
		/mutation failed: branch rule locked/,
	);
});

test("deleteRemoteBranch classifies concurrent change from GraphQL errors exit-0 response via re-read", async () => {
	let readCount = 0;
	const otherSha = "d".repeat(40);
	const exec: ExecFn = async (_command, args) => {
		if (args[1]?.includes("/git/ref/heads/feature")) {
			readCount++;
			if (readCount === 1) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
			return { code: 0, stdout: `${otherSha}\n`, stderr: "" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return {
				code: 0,
				stdout: JSON.stringify({ errors: [{ message: "stale oid" }] }),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	const result = await gateway.deleteRemoteBranch({
		repo: { owner: "acme", repo: "widgets" },
		branch: "feature",
		expectedHeadSha: SHA,
		cwd: "/repo",
	});
	assert.deepEqual(result, { kind: "changed", actualHeadSha: otherSha });
});

test("deleteRemoteBranch classifies concurrent deletion from GraphQL errors exit-0 response via re-read", async () => {
	let readCount = 0;
	const exec: ExecFn = async (_command, args) => {
		if (args[1]?.includes("/git/ref/heads/feature")) {
			readCount++;
			if (readCount === 1) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			return {
				code: 0,
				stdout: JSON.stringify({ errors: [{ message: "ref not found" }] }),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	const result = await gateway.deleteRemoteBranch({
		repo: { owner: "acme", repo: "widgets" },
		branch: "feature",
		expectedHeadSha: SHA,
		cwd: "/repo",
	});
	assert.deepEqual(result, { kind: "already-gone" });
});

test("deleteRemoteBranch rejects missing repository metadata", async () => {
	const exec: ExecFn = async (_command, args) => {
		if (args[1]?.includes("/git/ref/heads/feature")) {
			return { code: 0, stdout: `${SHA}\n`, stderr: "" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "\n", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	await assert.rejects(
		gateway.deleteRemoteBranch({
			repo: { owner: "acme", repo: "widgets" },
			branch: "feature",
			expectedHeadSha: SHA,
			cwd: "/repo",
		}),
		/Could not resolve repository ID/,
	);
});

test("deleteRemoteBranch propagates indeterminate runner errors without retry", async () => {
	let calls = 0;
	const exec: ExecFn = async (_command, args) => {
		calls++;
		if (args[1]?.includes("/git/ref/heads/feature")) {
			return { code: 0, stdout: `${SHA}\n`, stderr: "" };
		}
		if (args[1] === "/repos/acme/widgets") {
			return { code: 0, stdout: "R_node123\n", stderr: "" };
		}
		if (args[1] === "graphql") {
			throw new Error("transport timeout");
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const gateway = createGitHubGateway(exec);
	let caughtError: GitHubError | undefined;
	await assert.rejects(
		gateway
			.deleteRemoteBranch({
				repo: { owner: "acme", repo: "widgets" },
				branch: "feature",
				expectedHeadSha: SHA,
				cwd: "/repo",
			})
			.catch((err: Error) => {
				if (err instanceof GitHubError) caughtError = err;
				throw err;
			}),
		/transport timeout/,
	);
	assert.equal(caughtError?.kind, "indeterminate");
	// 1: ref check, 2: repo id, 3: graphql mutation. No 4th call (no re-read or retry).
	assert.equal(calls, 3);
});

test("deleteRemoteBranch validates branch name and SHA before effects", async () => {
	let called = false;
	const exec: ExecFn = async () => {
		called = true;
		return { code: 0, stdout: "", stderr: "" };
	};
	const gateway = createGitHubGateway(exec);

	await assert.rejects(
		gateway.deleteRemoteBranch({
			repo: { owner: "acme", repo: "widgets" },
			branch: "",
			expectedHeadSha: SHA,
			cwd: "/repo",
		}),
		/Invalid branch name/,
	);
	assert.equal(called, false);

	await assert.rejects(
		gateway.deleteRemoteBranch({
			repo: { owner: "acme", repo: "widgets" },
			branch: "feature",
			expectedHeadSha: "not-a-sha",
			cwd: "/repo",
		}),
		/Invalid expected head SHA/,
	);
	assert.equal(called, false);
});
