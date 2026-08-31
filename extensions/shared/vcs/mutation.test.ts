import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../git-exec.ts";
import type { VcsBackend, WorkstreamSnapshot } from "./backend.ts";
import { JjBackend } from "./jj-backend.ts";
import { createPrMutation, type MutationCheckout, type MutationTarget } from "./mutation.ts";

const SHA = "1".repeat(40);
const UPDATED_SHA = "2".repeat(40);
const target: MutationTarget = {
	prNumber: 42,
	headRef: "kstack/fix-thing",
	headSha: SHA,
};

function fakeBackend(overrides: Partial<VcsBackend> = {}): VcsBackend & { calls: string[] } {
	const calls: string[] = [];
	return {
		id: "git",
		preflight: async () => ({ ok: true, workspaceRoot: "/repo" }),
		headSha: async () => ({ ok: true, sha: SHA }),
		currentRef: async () => ({ ok: true, ref: { kind: "branch", name: target.headRef } }),
		captureWorkstream: async () => ({
			ok: true,
			snapshot: { ref: target.headRef, token: `${target.headRef}@${SHA}` },
		}),
		assertWorkstreamUnchanged: async () => ({ ok: true }),
		changedPaths: async () => ({ ok: true, paths: [] }),
		isWorkingCopyEmpty: async () => ({ ok: true, empty: true }),
		createWorkstream: async () => ({ ok: true, ref: target.headRef, baseSha: SHA }),
		verifyRecordedWorkstream: async () => ({ ok: true, headSha: SHA }),
		recordPaths: async (_cwd, paths) => {
			calls.push(`record:${paths.join(",")}`);
			return { ok: true };
		},
		restorePaths: async (_cwd, paths) => {
			calls.push(`restore:${paths.join(",")}`);
			return { ok: true };
		},
		publishRecordedChanges: async (_cwd, ref) => {
			calls.push(`publish:${ref}`);
			return { ok: true };
		},
		fetchRemoteHead: async () => ({ ok: true, sha: SHA }),
		updateBase: async () => ({ kind: "already-current" }),
		...overrides,
		calls,
	};
}

function checkout(
	snapshot: WorkstreamSnapshot = { ref: target.headRef, token: `${target.headRef}@${SHA}` },
): MutationCheckout {
	return { snapshot, affectedRefs: [snapshot.ref] };
}

describe("PrMutation.openCheckout", () => {
	it("rejects a checkout on a different branch", async () => {
		const backend = fakeBackend({
			currentRef: async () => ({ ok: true, ref: { kind: "branch", name: "kstack/other" } }),
		});
		const result = await createPrMutation(backend).openCheckout("/repo", target);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /current workstream is kstack\/other/);
	});

	it("rejects a dirty checkout before fetching the remote head", async () => {
		let fetched = false;
		const backend = fakeBackend({
			isWorkingCopyEmpty: async () => ({ ok: true, empty: false, details: "M user-work.ts" }),
			fetchRemoteHead: async () => {
				fetched = true;
				return { ok: true, sha: SHA };
			},
		});
		const result = await createPrMutation(backend).openCheckout("/repo", target);
		assert.equal(result.ok, false);
		assert.equal(fetched, false);
	});

	it("rejects a remote head that advanced after the PR snapshot", async () => {
		const advanced = "8".repeat(40);
		const backend = fakeBackend({ fetchRemoteHead: async () => ({ ok: true, sha: advanced }) });
		const result = await createPrMutation(backend).openCheckout("/repo", target);
		assert.deepEqual(result, {
			ok: false,
			error: `The remote PR head advanced to ${advanced}; refresh GitHub state before editing.`,
		});
	});

	it("uses the target ref when the backend needs no rewrite guard", async () => {
		const result = await createPrMutation(fakeBackend()).openCheckout("/repo", target);
		assert.deepEqual(result, {
			ok: true,
			checkout: {
				snapshot: { ref: target.headRef, token: `${target.headRef}@${SHA}` },
				affectedRefs: [target.headRef],
			},
		});
	});

	it("returns guarded affected refs and blocks a rejected rewrite scope", async () => {
		const guarded = fakeBackend({
			rewriteScope: { assertSingleRef: async () => ({ ok: true, affectedRefs: [target.headRef, "child"] }) },
		});
		const opened = await createPrMutation(guarded).openCheckout("/repo", target);
		assert.equal(opened.ok, true);
		if (opened.ok) assert.deepEqual(opened.checkout.affectedRefs, [target.headRef, "child"]);

		const rejected = fakeBackend({
			rewriteScope: { assertSingleRef: async () => ({ ok: false, error: "local descendants exist" }) },
		});
		assert.deepEqual(await createPrMutation(rejected).openCheckout("/repo", target), {
			ok: false,
			error: "local descendants exist",
		});
	});
});

describe("PrMutation.publishFix", () => {
	it("returns unchanged without recording or publishing when no paths changed", async () => {
		const backend = fakeBackend();
		const result = await createPrMutation(backend).publishFix("/repo", checkout(), {
			message: "Apply fixes",
			isForbiddenPath: () => false,
		});
		assert.deepEqual(result, { kind: "unchanged" });
		assert.deepEqual(backend.calls, []);
	});

	it("rejects a fixer that replaces the workstream identity", async () => {
		const backend = fakeBackend({
			assertWorkstreamUnchanged: async () => ({ ok: false, error: "snapshot token changed" }),
			changedPaths: async () => ({ ok: true, paths: ["src/fix.ts"] }),
		});
		const result = await createPrMutation(backend).publishFix("/repo", checkout(), {
			message: "Apply fixes",
			isForbiddenPath: () => false,
		});
		assert.deepEqual(result, {
			kind: "failed",
			error: "The fixer changed workstream identity: snapshot token changed",
		});
	});

	it("restores forbidden paths and refuses publication", async () => {
		const backend = fakeBackend({ changedPaths: async () => ({ ok: true, paths: [".env.local"] }) });
		const result = await createPrMutation(backend).publishFix("/repo", checkout(), {
			message: "Apply fixes",
			isForbiddenPath: (path) => path.startsWith(".env"),
		});
		assert.deepEqual(result, {
			kind: "failed",
			error: "Fixer touched forbidden paths: .env.local. Those changes were restored.",
		});
		assert.deepEqual(backend.calls, ["restore:.env.local"]);
	});

	it("reports a forbidden-path restoration failure", async () => {
		const backend = fakeBackend({
			changedPaths: async () => ({ ok: true, paths: [".env.local"] }),
			restorePaths: async () => ({ ok: false, error: ".env.local: restore denied" }),
		});
		const result = await createPrMutation(backend).publishFix("/repo", checkout(), {
			message: "Apply fixes",
			isForbiddenPath: (path) => path.startsWith(".env"),
		});
		assert.deepEqual(result, {
			kind: "failed",
			error: "Fixer touched forbidden paths: .env.local. Automatic restoration failed: .env.local: restore denied",
		});
	});

	it("rechecks rewrite scope before recording and publishing", async () => {
		let guardCalls = 0;
		const backend = fakeBackend({
			changedPaths: async () => ({ ok: true, paths: ["src/fix.ts"] }),
			rewriteScope: {
				assertSingleRef: async () => {
					guardCalls++;
					return { ok: true, affectedRefs: [target.headRef] };
				},
			},
			headSha: async () => ({ ok: true, sha: UPDATED_SHA }),
		});
		const result = await createPrMutation(backend).publishFix("/repo", checkout(), {
			message: "Apply fixes",
			isForbiddenPath: () => false,
		});
		assert.deepEqual(result, { kind: "pushed", headSha: UPDATED_SHA });
		assert.equal(guardCalls, 1);
		assert.deepEqual(backend.calls, ["record:src/fix.ts", `publish:${target.headRef}`]);
	});
});

describe("PrMutation with JjBackend", () => {
	it("opens an empty jj child, squashes a fix into its parent, and publishes the bookmark", async () => {
		const changeId = "stable-change-id";
		const calls: string[] = [];
		let squashed = false;
		const exec: ExecFn = async (command, args) => {
			assert.equal(command, "jj");
			calls.push(args.join(" "));
			if (args.includes('if(empty, "true", "false")')) return { code: 0, stdout: "true", stderr: "" };
			if (args.includes("bookmark") && args.includes("list") && args.includes(`exact:${target.headRef}`)) {
				return { code: 0, stdout: `${target.headRef}\t${squashed ? UPDATED_SHA : SHA}\n`, stderr: "" };
			}
			if (args.includes("bookmark") && args.includes("list") && args.includes("-r")) {
				return {
					code: 0,
					stdout: args.includes("parents(@)") ? `${target.headRef}\n` : "",
					stderr: "",
				};
			}
			if (args.includes('change_id ++ "\\n"')) return { code: 0, stdout: `${changeId}\n`, stderr: "" };
			if (args.includes('commit_id ++ "\\n"')) {
				if (args.includes(`${target.headRef}@origin`)) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
				if (args.includes("parents(@)")) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
			}
			if (args.includes("--name-only")) return { code: 0, stdout: "src/fix.ts\n", stderr: "" };
			if (args.includes("squash")) squashed = true;
			return { code: 0, stdout: "", stderr: "" };
		};
		const mutation = createPrMutation(new JjBackend(exec));
		const opened = await mutation.openCheckout("/repo", target);
		assert.equal(opened.ok, true);
		if (!opened.ok) return;

		const published = await mutation.publishFix("/repo", opened.checkout, {
			message: "Apply fixes",
			isForbiddenPath: () => false,
		});

		assert.deepEqual(published, { kind: "pushed", headSha: UPDATED_SHA });
		assert.ok(calls.includes('--no-pager squash --from @ --into @- cwd:"src/fix.ts" --use-destination-message'));
		assert.ok(!calls.some((call) => call.includes("bookmark set")));
		assert.ok(calls.includes(`--no-pager git push --remote origin --bookmark ${target.headRef}`));
	});
});

describe("PrMutation.updateBaseAndPublish", () => {
	it("maps checkout failures to precondition-failed", async () => {
		const backend = fakeBackend({ isWorkingCopyEmpty: async () => ({ ok: true, empty: false }) });
		const result = await createPrMutation(backend).updateBaseAndPublish("/repo", { ...target, baseRef: "main" });
		assert.equal(result.kind, "precondition-failed");
	});

	it("rechecks rewrite scope after a clean update and publishes", async () => {
		let guardCalls = 0;
		const backend = fakeBackend({
			updateBase: async () => ({ kind: "clean", headSha: UPDATED_SHA }),
			rewriteScope: {
				assertSingleRef: async () => {
					guardCalls++;
					return { ok: true, affectedRefs: [target.headRef] };
				},
			},
		});
		const result = await createPrMutation(backend).updateBaseAndPublish("/repo", { ...target, baseRef: "main" });
		assert.deepEqual(result, { kind: "published", headSha: UPDATED_SHA });
		assert.equal(guardCalls, 2);
		assert.deepEqual(backend.calls, [`publish:${target.headRef}`]);
	});

	it("preserves a human-required conflict", async () => {
		const backend = fakeBackend({
			updateBase: async () => ({ kind: "needs-human", files: ["src/a.ts"], error: "conflict" }),
		});
		assert.deepEqual(await createPrMutation(backend).updateBaseAndPublish("/repo", { ...target, baseRef: "main" }), {
			kind: "needs-human",
			files: ["src/a.ts"],
			error: "conflict",
		});
	});
});
