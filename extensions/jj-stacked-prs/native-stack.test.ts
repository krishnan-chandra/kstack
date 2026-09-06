import assert from "node:assert/strict";
import test from "node:test";
import { createNativeStackGateway, NativeStackError } from "./native-stack.ts";
import type { ProcessRunner } from "./process.ts";

const repo = { owner: "acme", repo: "widgets" };
const stackJson = JSON.stringify([
	{
		id: 8,
		number: 17,
		base: { ref: "main" },
		open: true,
		pull_requests: [
			{ number: 101, state: "open", draft: true, merged_at: null, head: { ref: "one", sha: "aaa" } },
			{ number: 102, state: "open", draft: true, merged_at: null, head: { ref: "two", sha: "bbb" } },
		],
	},
]);

function runner(responses: Array<{ kind: "ok"; code: 0; stdout: string; stderr: string }>) {
	const calls: string[][] = [];
	const environments: Array<NodeJS.ProcessEnv | undefined> = [];
	const run: ProcessRunner = async (argv, options) => {
		calls.push([...argv]);
		environments.push(options.env);
		const response = responses.shift();
		if (!response) throw new Error("unexpected process call");
		return response;
	};
	return { calls, environments, run };
}

const ok = (stdout = "") => ({ kind: "ok" as const, code: 0 as const, stdout, stderr: "" });

test("inspects and validates ordered native membership", async () => {
	const fake = runner([ok(stackJson)]);
	const stack = await createNativeStackGateway(fake.run).inspectForPullRequest({ cwd: "/repo", repo, prNumber: 102 });
	assert.equal(stack?.stackNumber, 17);
	assert.deepEqual(
		stack?.pullRequests.map((pr) => pr.number),
		[101, 102],
	);
	assert.deepEqual(fake.calls, [["gh", "api", "repos/acme/widgets/stacks?pull_request=102"]]);
});

test("rejects malformed and ambiguous native responses", async () => {
	const malformed = runner([ok("{}")]);
	await assert.rejects(
		createNativeStackGateway(malformed.run).inspectForPullRequest({ cwd: "/repo", repo, prNumber: 1 }),
		NativeStackError,
	);
	const ambiguous = runner([ok(`[${stackJson.slice(1, -1)},${stackJson.slice(1, -1)}]`)]);
	await assert.rejects(
		createNativeStackGateway(ambiguous.run).inspectForPullRequest({ cwd: "/repo", repo, prNumber: 1 }),
		/multiple native stacks/,
	);
});

test("links explicit PR URLs in the selected repository and verifies exact membership", async () => {
	const originalRepo = process.env.GH_REPO;
	const fake = runner([ok("Linked\n"), ok(stackJson)]);
	const stack = await createNativeStackGateway(fake.run).link({
		cwd: "/repo",
		repo,
		base: "main",
		prNumbers: [101, 102],
	});
	assert.equal(stack.stackNumber, 17);
	assert.deepEqual(fake.calls[0], [
		"gh",
		"stack",
		"link",
		"--base",
		"main",
		"https://github.com/acme/widgets/pull/101",
		"https://github.com/acme/widgets/pull/102",
	]);
	assert.equal(fake.environments[0]?.GH_REPO, "github.com/acme/widgets");
	assert.equal(process.env.GH_REPO, originalRepo);
});

test("resolves an interrupted link with read-after-write verification", async () => {
	let calls = 0;
	const run: ProcessRunner = async () => {
		calls++;
		if (calls === 1) return { kind: "timeout", message: "timed out", stdout: "", stderr: "" };
		return ok(stackJson);
	};
	const stack = await createNativeStackGateway(run).link({
		cwd: "/repo",
		repo,
		base: "main",
		prNumbers: [101, 102],
	});
	assert.equal(stack.stackNumber, 17);
});

test("fails closed when link verification differs", async () => {
	const fake = runner([ok(), ok(stackJson)]);
	await assert.rejects(
		createNativeStackGateway(fake.run).link({ cwd: "/repo", repo, base: "main", prNumbers: [102, 101] }),
		/verification failed/,
	);
});

test("detects merge queues from branch rules", async () => {
	const fake = runner([
		ok(
			JSON.stringify({
				data: { repository: { mergeQueue: null, ref: { rules: { nodes: [{ type: "MERGE_QUEUE" }] } } } },
			}),
		),
	]);
	assert.equal(await createNativeStackGateway(fake.run).baseUsesMergeQueue({ cwd: "/repo", repo, base: "main" }), true);
});

test("preflight checks extension version and repository capability", async () => {
	const fake = runner([ok("gh stack version 0.1.0\n"), ok("[]")]);
	assert.deepEqual(await createNativeStackGateway(fake.run).preflight({ cwd: "/repo", repo }), {
		status: "available",
		version: "0.1.0",
	});
	const old = runner([ok("gh stack version 0.0.9\n")]);
	assert.equal((await createNativeStackGateway(old.run).preflight({ cwd: "/repo", repo })).status, "unavailable");
});

test("classifies a successful non-merged stack merge as enqueued", async () => {
	const fake = runner([ok("Enqueued\n"), ok(stackJson)]);
	const result = await createNativeStackGateway(fake.run).mergeThrough({
		cwd: "/repo",
		repo,
		prNumber: 102,
		method: "squash",
	});
	assert.equal(result.status, "enqueued");
	assert.deepEqual(fake.calls[0], ["gh", "stack", "merge", "102", "--yes", "--squash"]);
	assert.equal(fake.environments[0]?.GH_REPO, "github.com/acme/widgets");
});
