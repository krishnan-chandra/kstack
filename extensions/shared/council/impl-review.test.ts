import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runCouncilImplReview } from "./impl-review.ts";
import type { SeatLetter } from "./roster.ts";
import type { SeatAsk, SeatAskResult } from "./round.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const APPROVE = "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n";

function makeFixture(maxRounds = 3) {
	const root = mkdtempSync(join(tmpdir(), "kstack-impl-review-"));
	roots.push(root);
	const dir = join(root, "council");
	const bundle = join(root, "implement");
	mkdirSync(dir, { recursive: true });
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(bundle, "task.md"), "Fix the bug.\n");
	writeFileSync(join(bundle, "approved-plan.md"), "# Plan\n\n1. [STEP-1] Fix it.\n");
	writeFileSync(join(bundle, "execution-ledger.md"), "- [STEP-1] Fix it. — done\n");
	writeFileSync(join(bundle, "diff.patch"), "diff --git a/a.ts b/a.ts\n+// v1\n");
	writeFileSync(join(bundle, "vcs-policy.md"), "Backend: jj\n");
	const asks: SeatAsk[] = [];
	const run = (
		handler: (ask: SeatAsk) => Promise<SeatAskResult> | SeatAskResult,
		options: {
			seats?: readonly SeatLetter[];
			workstreamCwd?: string;
			seatModels?: Partial<Record<SeatLetter, string>>;
		} = {},
	) =>
		runCouncilImplReview(
			{
				dir,
				bundleDir: bundle,
				workstreamCwd: options.workstreamCwd ?? root,
				seats: options.seats ?? ["A", "B"],
				seatModels: options.seatModels ?? { A: "anthropic/claude-opus-5-5:high", B: "openai/gpt-6-astra:high" },
				maxRounds,
				timeoutMs: 600_000,
				seatPanes: { A: "block:a", B: "block:b" },
			},
			{
				askSeat: async (ask) => {
					asks.push(ask);
					return handler(ask);
				},
			},
		);
	return { root, dir, bundle, asks, run };
}

describe("runCouncilImplReview", () => {
	it("validates bundle files and optional playbook-path.txt before asking any seat", async () => {
		const f = makeFixture();
		rmSync(join(f.bundle, "diff.patch"));
		const missing = await f.run(() => ({ status: "completed", output: APPROVE }));
		assert.equal(missing.status, "failed");
		assert.equal(missing.exitCode, 1);
		assert.match(missing.error ?? "", /diff\.patch/);
		assert.equal(f.asks.length, 0);

		writeFileSync(join(f.bundle, "diff.patch"), "diff\n");
		writeFileSync(join(f.bundle, "playbook-path.txt"), "relative/playbook.md\n");
		const badPlaybook = await f.run(() => ({ status: "completed", output: APPROVE }));
		assert.equal(badPlaybook.status, "failed");
		assert.match(badPlaybook.error ?? "", /playbook/);
		assert.equal(f.asks.length, 0);
	});

	it("tracks open findings across rounds, repairs malformed critiques, and writes verdict.md", async () => {
		const f = makeFixture(2);
		const playbook = join(f.root, "bug-fix.md");
		writeFileSync(playbook, "# Bug fix playbook\n");
		writeFileSync(join(f.bundle, "playbook-path.txt"), `${playbook}\n`);

		const r1 = await f.run((ask) => {
			const prompt = readFileSync(ask.promptFile, "utf8");
			assert.ok(prompt.includes(join(f.bundle, "review-round-1", "playbook.md")));
			if (ask.seat === "A") {
				return {
					status: "completed",
					output:
						"Verdict: revise\n\n## Blocking\n- [B-1] Missing regression test\n\n## Suggestions\n- [S-1] Tighten name\n",
				};
			}
			return { status: "completed", output: APPROVE };
		});
		assert.equal(r1.status, "complete");
		assert.equal(r1.decision, "revise");
		assert.deepEqual(r1.blocking, ["A/B-1"]);
		assert.match(readFileSync(join(f.bundle, "verdict.md"), "utf8"), /^Decision: revise\n/);

		// Round 2: Seat A initially omits B-1 from Blocking/Resolved, triggering one repair ask.
		writeFileSync(join(f.bundle, "diff.patch"), "diff --git a/a.ts b/a.ts\n+// v2 with test\n");
		let seatAAttempts = 0;
		const r2 = await f.run((ask) => {
			if (ask.seat === "A") {
				seatAAttempts++;
				if (seatAAttempts === 1) return { status: "completed", output: APPROVE };
				return {
					status: "completed",
					output: `${APPROVE}\n## Resolved from previous round\n- B-1: Added regression test\n`,
				};
			}
			return { status: "completed", output: APPROVE };
		});
		assert.equal(seatAAttempts, 2);
		assert.equal(r2.status, "complete");
		assert.equal(r2.decision, "approve");
		const verdict2 = readFileSync(join(f.bundle, "verdict.md"), "utf8");
		assert.match(verdict2, /^Decision: approve\n/);
		assert.match(verdict2, /- B-1: Added regression test/);
	});

	it("resumes an incomplete round for only unfinished seats when diff is unchanged, and resets when diff changes", async () => {
		const f = makeFixture(3);
		const r1 = await f.run((ask) =>
			ask.seat === "A" ? { status: "completed", output: APPROVE } : { status: "failed", error: "Timed out" },
		);
		assert.equal(r1.status, "incomplete");
		assert.equal(r1.exitCode, 1);
		assert.deepEqual(
			r1.failures?.map((item) => [item.seat, item.pane]),
			[["B", "block:b"]],
		);

		// Same diff: asks only B.
		f.asks.length = 0;
		const resumed = await f.run(() => ({
			status: "completed",
			output: "Verdict: revise\n\n## Blocking\n- [B-1] Still broken\n\n## Suggestions\nNone.\n",
		}));
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.resumed, true);
		assert.deepEqual(
			f.asks.map((ask) => ask.seat),
			["B"],
		);
		assert.equal(resumed.decision, "revise");

		// Round 2 starts incomplete on A, then diff changes before rerun -> re-asks both A and B on the new diff.
		writeFileSync(join(f.bundle, "diff.patch"), "diff v2\n");
		const r2Partial = await f.run((ask) =>
			ask.seat === "A" ? { status: "completed", output: APPROVE } : { status: "aborted" },
		);
		assert.equal(r2Partial.status, "incomplete");
		assert.equal(r2Partial.cancelled, true);

		writeFileSync(join(f.bundle, "diff.patch"), "diff v3\n");
		f.asks.length = 0;
		const r2Fresh = await f.run((ask) => ({
			status: "completed",
			output: ask.seat === "B" ? `${APPROVE}\n## Resolved from previous round\n- B-1: Fixed in v3\n` : APPROVE,
		}));
		assert.equal(r2Fresh.status, "complete");
		assert.equal(r2Fresh.resumed, false);
		assert.equal(r2Fresh.round, 2);
		assert.deepEqual(f.asks.map((ask) => ask.seat).sort(), ["A", "B"]);
		assert.equal(r2Fresh.decision, "approve");
	});

	it("returns exhausted on the final round when findings remain and refuses further rounds", async () => {
		const f = makeFixture(1);
		const r1 = await f.run(() => ({
			status: "completed",
			output: "Verdict: revise\n\n## Blocking\n- [B-1] Unresolved\n\n## Suggestions\nNone.\n",
		}));
		assert.equal(r1.status, "complete");
		assert.equal(r1.decision, "exhausted");
		assert.match(readFileSync(join(f.bundle, "verdict.md"), "utf8"), /^Decision: revise\n/);

		writeFileSync(join(f.bundle, "diff.patch"), "diff v2\n");
		const r2 = await f.run(() => ({ status: "completed", output: APPROVE }));
		assert.equal(r2.status, "failed");
		assert.equal(r2.exitCode, 1);
		assert.match(r2.error ?? "", /used/);
	});

	it("invalidates cached incomplete-round approvals when workstreamCwd or bundle inputs change, and rejects seat-model mismatches", async () => {
		const f = makeFixture(3);
		const altCwd = join(f.root, "worktree");
		mkdirSync(altCwd, { recursive: true });

		// Seat A approves under f.root while Seat B fails.
		const partial1 = await f.run((ask) =>
			ask.seat === "A" ? { status: "completed", output: APPROVE } : { status: "failed", error: "Timed out" },
		);
		assert.equal(partial1.status, "incomplete");

		// Changing --cwd invalidates Seat A's cached approval so both seats review altCwd.
		f.asks.length = 0;
		const partial2 = await f.run(
			(ask) => {
				const prompt = readFileSync(ask.promptFile, "utf8");
				assert.ok(prompt.includes(altCwd));
				return ask.seat === "A" ? { status: "completed", output: APPROVE } : { status: "failed", error: "Timed out" };
			},
			{ workstreamCwd: altCwd },
		);
		assert.equal(partial2.status, "incomplete");
		assert.equal(partial2.resumed, false);
		assert.deepEqual(f.asks.map((ask) => ask.seat).sort(), ["A", "B"]);

		// Changing approved-plan.md also invalidates Seat A's cached approval and refreshes the round snapshot.
		writeFileSync(join(f.bundle, "approved-plan.md"), "# Plan\n\n1. [STEP-1] Updated plan.\n");
		f.asks.length = 0;
		const complete = await f.run(
			(ask) => {
				const snapPlan = readFileSync(join(f.bundle, "review-round-1", "approved-plan.md"), "utf8");
				assert.match(snapPlan, /Updated plan/);
				return ask.seat === "A"
					? {
							status: "completed",
							output: "Verdict: revise\n\n## Blocking\n- [B-1] Plan mismatch\n\n## Suggestions\nNone.\n",
						}
					: { status: "completed", output: APPROVE };
			},
			{ workstreamCwd: altCwd },
		);
		assert.equal(complete.status, "complete");
		assert.equal(complete.resumed, false);
		assert.equal(complete.decision, "revise");
		assert.deepEqual(f.asks.map((ask) => ask.seat).sort(), ["A", "B"]);

		// Reusing the bundle with different models for the same letters A, B is refused.
		writeFileSync(join(f.bundle, "diff.patch"), "diff v2\n");
		const wrongModels = await f.run(() => ({ status: "completed", output: APPROVE }), {
			workstreamCwd: altCwd,
			seatModels: { A: "google/gemini-4-carbon:high", B: "openai/gpt-6-astra:high" },
		});
		assert.equal(wrongModels.status, "failed");
		assert.match(wrongModels.error ?? "", /different council seat roster/);
	});
});
