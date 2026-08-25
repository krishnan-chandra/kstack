import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoundaryValue } from "../shared/validation.ts";
import {
	buildFastKickoff,
	checkFastSettlement,
	createFastWorkstream,
	FAST_IMPLEMENT_RUN_COMPLETE_ENTRY,
	FAST_IMPLEMENT_RUN_ENTRY,
	type FastPendingRun,
	FastTakeoverController,
	findPendingFastRun,
	preflightFastWorkstream,
	verifyFastRun,
} from "./fast-takeover.ts";

const run: FastPendingRun = {
	schemaVersion: 1,
	runId: "run-1",
	task: "Fix the narrow bug",
	changeKind: "bug-fix",
	backend: "jj",
	cwd: "/repo",
	checkpoint: { ref: "kstack/fix-narrow-bug", baseSha: "abc123" },
};

describe("findPendingFastRun", () => {
	it("returns the newest unresolved valid run", () => {
		assert.deepEqual(
			findPendingFastRun([
				{ type: "custom", customType: FAST_IMPLEMENT_RUN_ENTRY, data: { ...run, runId: "old" } },
				{ type: "custom", customType: FAST_IMPLEMENT_RUN_COMPLETE_ENTRY, data: { runId: "old" } },
				{ type: "custom", customType: FAST_IMPLEMENT_RUN_ENTRY, data: run },
			]),
			run,
		);
	});

	it("ignores resolved and malformed persisted entries", () => {
		assert.equal(
			findPendingFastRun([
				{ type: "custom", customType: FAST_IMPLEMENT_RUN_ENTRY, data: { ...run, backend: "svn" } },
				{ type: "custom", customType: FAST_IMPLEMENT_RUN_ENTRY, data: run },
				{ type: "custom", customType: FAST_IMPLEMENT_RUN_COMPLETE_ENTRY, data: { runId: run.runId } },
			]),
			undefined,
		);
	});
});

describe("FastTakeoverController", () => {
	it("does not latch after an unrelated settle or a completed run", () => {
		const controller = new FastTakeoverController();
		const entries = [{ type: "custom", customType: FAST_IMPLEMENT_RUN_ENTRY, data: run }];
		assert.deepEqual(controller.begin(entries), run);
		assert.equal(controller.begin(entries), undefined, "does not overlap verification");
		controller.finish(run.runId);
		assert.deepEqual(controller.begin(entries), run, "retries after a provisional settle");
		controller.finish(run.runId);
		assert.deepEqual(controller.begin(entries), run, "can verify a later run in the same session");
	});

	it("resets when a replacement session starts", () => {
		const controller = new FastTakeoverController();
		assert.equal(controller.begin([]), undefined);
		controller.reset();
		assert.deepEqual(controller.begin([{ type: "custom", customType: FAST_IMPLEMENT_RUN_ENTRY, data: run }]), run);
	});
});

describe("takeover workstream preparation", () => {
	it("runs backend preflight before confirmation", async () => {
		const result = await preflightFastWorkstream({ preflight: async () => ({ ok: false, error: "dirty" }) }, "/repo");
		assert.deepEqual(result, { ok: false, error: "dirty" });
	});

	it("creates the confirmed current-checkout workstream", async () => {
		const result = await createFastWorkstream(
			{ createWorkstream: async () => ({ ok: true, ref: "work", baseSha: "base" }) },
			"/repo",
			"task",
		);
		assert.deepEqual(result, { ok: true, ref: "work", baseSha: "base" });
	});

	it("turns thrown backend preparation failures into retained outcomes", async () => {
		const preflight = await preflightFastWorkstream(
			{
				preflight: async () => {
					throw new Error("preflight crashed");
				},
			},
			"/repo",
		);
		const created = await createFastWorkstream(
			{
				createWorkstream: async () => {
					throw new Error("create crashed");
				},
			},
			"/repo",
			"task",
		);
		assert.deepEqual(preflight, { ok: false, error: "preflight crashed" });
		assert.deepEqual(created, { ok: false, error: "create crashed" });
	});
});

describe("takeover settlement", () => {
	it("requires and reports a new committed revision", async () => {
		let expected: BoundaryValue;
		const result = await verifyFastRun(run, {
			verifyRecordedWorkstream: async (_cwd, value) => {
				expected = value;
				return { ok: true, headSha: "new-head" };
			},
		});
		assert.deepEqual(expected, { ...run.checkpoint, requireNewCommit: true });
		assert.equal(result.status, "completed");
	});

	it("keeps the run pending after a settle without a commit", async () => {
		const settlement = await checkFastSettlement(run, {
			verifyRecordedWorkstream: async () => ({ ok: false, error: "no commit" }),
		});
		assert.deepEqual(settlement, { kind: "pending", reason: "no commit" });
	});

	it("keeps the run pending after a verification exception", async () => {
		const settlement = await checkFastSettlement(run, {
			verifyRecordedWorkstream: async () => {
				throw new Error("temporary failure");
			},
		});
		assert.deepEqual(settlement, { kind: "pending", reason: "temporary failure" });
	});

	it("completes only after verification succeeds on a later settle", async () => {
		let attempts = 0;
		const backend = {
			verifyRecordedWorkstream: async () => {
				attempts++;
				return attempts === 1 ? { ok: false as const, error: "no commit" } : { ok: true as const, headSha: "new-head" };
			},
		};
		assert.equal((await checkFastSettlement(run, backend)).kind, "pending");
		assert.equal((await checkFastSettlement(run, backend)).kind, "complete");
	});
});

describe("buildFastKickoff", () => {
	it("includes guidance, workstream facts, same-session context, and publication prohibitions", () => {
		const prompt = buildFastKickoff(run, "IMPLEMENTER GUIDANCE");
		assert.ok(prompt.includes("IMPLEMENTER GUIDANCE"));
		assert.ok(prompt.includes(run.task));
		assert.ok(prompt.includes(run.checkpoint.ref));
		assert.ok(prompt.includes("plan and prior discussion already in this session"));
		assert.ok(prompt.includes("Do not push, publish, open a PR, or land."));
	});

	it("rejects an oversized kickoff", () => {
		assert.throws(() => buildFastKickoff(run, "x".repeat(128 * 1024)), /exceeds/);
	});
});
