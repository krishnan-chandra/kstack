import assert from "node:assert/strict";
import { it } from "node:test";
import { GitHubError, type GitHubGateway } from "../github.ts";
import type { CompletedPublicationAction } from "./outcome.ts";
import { createPrTransitions } from "./pr-transitions.ts";

const repository = { owner: "o", repo: "r" };
const created = {
	number: 11,
	url: "https://example/11",
	draft: true,
	headRef: "one",
	baseRef: "main",
	title: "One",
	headOwner: "o",
	headCommitId: "sha",
};
const metadata = { base: "main", title: "One", body: "Body" };
type PublicationRow = Parameters<ReturnType<typeof createPrTransitions>["ready"]>[0] & { headSha: string };

function fixture(overrides: Partial<Pick<GitHubGateway, "createDraftPr" | "markPrReady">> = {}) {
	const events: unknown[] = [];
	const completed: CompletedPublicationAction[] = [];
	const row: PublicationRow = {
		ref: "one",
		draft: false,
		headSha: "sha",
	};
	const transitions = createPrTransitions({
		repository,
		cwd: "/repo",
		gateway: {
			createDraftPr: async (input) => {
				events.push(["create", input]);
				return created;
			},
			markPrReady: async (...args) => {
				events.push(["ready", args]);
			},
			...overrides,
		},
		completed: (action) => {
			completed.push(action);
			events.push(["completed", action]);
		},
	});
	return { transitions, row, completed, events };
}

it("returns the created PR, updates only caller-owned identity fields, and accounts before returning", async () => {
	const { transitions, row, completed, events } = fixture();
	const result = await transitions.create({ row, ...metadata });
	assert.equal(result, created);
	assert.deepEqual(row, { ref: "one", draft: true, headSha: "sha", prNumber: 11, url: created.url });
	await transitions.ready(row);
	assert.equal(row.draft, false);
	assert.deepEqual(completed, [
		{ kind: "create-draft-pr", ref: "one", prNumber: 11, url: created.url },
		{ kind: "mark-pr-ready", ref: "one", prNumber: 11 },
	]);
	assert.deepEqual(events, [
		["create", { repo: repository, ref: "one", ...metadata, cwd: "/repo", signal: undefined }],
		["completed", completed[0]],
		["ready", [repository, 11, "/repo", undefined]],
		["completed", completed[1]],
	]);
	await transitions.ready(row);
	assert.equal(events.length, 4);
});

it("adopts a non-draft creation without dispatching readiness", async () => {
	const { transitions, row, completed, events } = fixture({
		createDraftPr: async () => ({ ...created, draft: false }),
	});
	row.draft = true;
	await transitions.create({ row, ...metadata });
	assert.equal(row.draft, false);
	await transitions.ready(row);
	assert.equal(completed.length, 1);
	assert.deepEqual(events, [["completed", completed[0]]]);
});

it("rejects missing readiness identity before dispatch or accounting", async () => {
	const { transitions, row, events } = fixture();
	await assert.rejects(transitions.ready(row), /No proven PR number/);
	assert.deepEqual(events, []);
});

it("does not update the row or account for a pending creation", async () => {
	let resolve: (value: typeof created) => void = () => {};
	const pending = new Promise<typeof created>((settle) => {
		resolve = settle;
	});
	const { transitions, row, completed } = fixture({ createDraftPr: () => pending });
	const before = { ...row };
	const creation = transitions.create({ row, ...metadata });
	assert.deepEqual(row, before);
	assert.deepEqual(completed, []);
	resolve(created);
	await creation;
	assert.equal(row.prNumber, created.number);
	assert.equal(completed.length, 1);
});

for (const failure of [new Error("rejected"), new GitHubError("uncertain", "indeterminate")]) {
	for (const operation of ["create", "ready"] as const) {
		it(`preserves prior row, progress and original ${failure.message} identity on ${operation}`, async () => {
			let fail = false;
			const calls: string[] = [];
			const { transitions, row, completed } = fixture({
				createDraftPr: async () => {
					calls.push("create");
					if (fail) throw failure;
					return created;
				},
				markPrReady: async () => {
					calls.push("ready");
					if (fail) throw failure;
				},
			});
			await transitions.create({ row, ...metadata });
			const before = { ...row };
			fail = true;
			const mutation = operation === "create" ? transitions.create({ row, ...metadata }) : transitions.ready(row);
			await assert.rejects(mutation, (error) => error === failure);
			assert.deepEqual(row, before);
			assert.equal(completed.length, 1);
			assert.deepEqual(calls, ["create", operation]);
		});
	}
}

it("forwards an aborted signal without adding a checkpoint between creation and readiness", async () => {
	const signal = AbortSignal.abort();
	const calls: unknown[] = [];
	const row = { ref: "one", draft: true };
	const transitions = createPrTransitions({
		repository,
		cwd: "/repo",
		signal,
		completed: (action) => calls.push(action.kind),
		gateway: {
			createDraftPr: async (input) => {
				assert.equal(input.signal, signal);
				return created;
			},
			markPrReady: async (_repo, _number, _cwd, received) => {
				assert.equal(received, signal);
				calls.push("ready");
			},
		},
	});
	await transitions.create({ row, ...metadata });
	await transitions.ready(row);
	assert.deepEqual(calls, ["create-draft-pr", "ready", "mark-pr-ready"]);
});
