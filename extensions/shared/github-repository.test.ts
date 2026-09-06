import assert from "node:assert/strict";
import test from "node:test";
import { getRepository, resolveRepoName } from "./github.ts";
import { isRepositoryName, resolveGitHubRepository, scopeGitHubExec } from "./github-repository.ts";

test("resolves a non-colocated jj repository from its origin remote", async () => {
	const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
	const signal = new AbortController().signal;
	const result = await resolveGitHubRepository(
		async (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd });
			return {
				code: 0,
				stdout: "upstream https://github.com/acme/upstream.git\norigin git@github.com:acme/widgets.git\n",
				stderr: "",
			};
		},
		"/secondary",
		"jj",
		signal,
	);

	assert.deepEqual(result, { ok: true, repository: "acme/widgets" });
	assert.deepEqual(calls, [
		{
			command: "jj",
			args: ["git", "remote", "list", "--no-pager", "--color=never"],
			cwd: "/secondary",
		},
	]);
});

test("preserves cancellation from jj and Git repository discovery", async () => {
	for (const backend of ["jj", "git"] as const) {
		for (const failure of ["reject", "nonzero"] as const) {
			const controller = new AbortController();
			const result = await resolveGitHubRepository(
				async () => {
					controller.abort();
					if (failure === "reject") throw new Error("executor aborted");
					return { code: 130, stdout: "", stderr: "aborted" };
				},
				"/workspace",
				backend,
				controller.signal,
			);
			assert.deepEqual(result, { ok: false, kind: "cancelled" }, `${backend} ${failure}`);
		}
	}
});

test("fails closed when a jj origin cannot identify one GitHub repository", async () => {
	for (const [stdout, expected] of [
		["upstream git@github.com:acme/widgets.git\n", /requires a GitHub remote named origin/],
		["origin https://gitlab.com/acme/widgets.git\n", /origin remote is not a valid GitHub repository/],
		["origin git@github.com:acme/one.git\norigin git@github.com:acme/two.git\n", /duplicate remote "origin"/],
		["malformed\n", /malformed remote output/],
	] as const) {
		const result = await resolveGitHubRepository(async () => ({ code: 0, stdout, stderr: "" }), "/secondary", "jj");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.kind, "failed");
		if (!result.ok && result.kind === "failed") assert.match(result.error, expected);
	}
});

test("keeps ambient GitHub discovery for Git worktrees", async () => {
	const result = await resolveGitHubRepository(
		async (command, args, options) => {
			assert.equal(command, "gh");
			assert.deepEqual(args, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
			assert.equal(options.cwd, "/git-worktree");
			return { code: 0, stdout: "acme/widgets\n", stderr: "" };
		},
		"/git-worktree",
		"git",
	);
	assert.deepEqual(result, { ok: true, repository: "acme/widgets" });
});

test("scopes delegated GitHub commands while preserving cwd, timeout, and cancellation", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const options = { cwd: "/secondary", timeout: 123, signal: new AbortController().signal };
	const exec = scopeGitHubExec(async (command, args, receivedOptions) => {
		assert.equal(receivedOptions, options);
		calls.push({ command, args });
		return { code: 0, stdout: "", stderr: "" };
	}, "acme/widgets");
	const inputs = [
		["pr", "view", "12", "--json", "number"],
		["pr", "checks", "12", "--watch", "--fail-fast"],
		["pr", "merge", "12", "--squash", "--match-head-commit", "a".repeat(40)],
		["run", "view", "100", "--log-failed"],
		["repo", "view", "--json", "nameWithOwner"],
		["api", "repos/acme/widgets/pulls/12"],
		["api", "graphql", "-F", "owner=acme", "-F", "name=widgets"],
	];
	for (const args of inputs) await exec("gh", args, options);
	await exec("jj", ["git", "fetch"], options);
	assert.deepEqual(
		calls.map((call) => call.args),
		[
			...inputs.slice(0, 4).map((args) => [...args, "--repo", "acme/widgets"]),
			["repo", "view", "acme/widgets", "--json", "nameWithOwner"],
			...inputs.slice(5),
			["git", "fetch"],
		],
	);
	assert.equal(calls.at(-1)?.command, "jj");
	assert.deepEqual(inputs[0], ["pr", "view", "12", "--json", "number"]);
});

test("resolves delegated repository metadata without ambient Git discovery", async () => {
	const exec = scopeGitHubExec(async (command, args) => {
		assert.equal(command, "gh");
		assert.deepEqual(args.slice(0, 3), ["repo", "view", "acme/widgets"]);
		const stdout = args.includes("-q")
			? "acme/widgets\n"
			: JSON.stringify({
					nameWithOwner: "acme/widgets",
					defaultBranchRef: { name: "main" },
					squashMergeAllowed: true,
				});
		return { code: 0, stdout, stderr: "" };
	}, "acme/widgets");
	assert.equal(await resolveRepoName(exec, "/secondary"), "acme/widgets");
	assert.deepEqual(await getRepository(exec, "/secondary"), {
		nameWithOwner: "acme/widgets",
		defaultBranch: "main",
		allowedMethods: ["squash"],
	});
});

test("rejects malformed repository coordinates before invoking commands", () => {
	for (const repository of ["", "owner", "a/b/c", "../b", "-R/b", "owner/repo\n", "https://github.com/a/b"]) {
		assert.equal(isRepositoryName(repository), false);
		assert.throws(
			() =>
				scopeGitHubExec(async () => {
					throw new Error("must not execute");
				}, repository),
			/Invalid GitHub repository/,
		);
	}
});
