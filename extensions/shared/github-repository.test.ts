import assert from "node:assert/strict";
import test from "node:test";
import { getRepository, resolveRepoName } from "./github.ts";
import { isRepositoryName, scopeGitHubExec } from "./github-repository.ts";

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
