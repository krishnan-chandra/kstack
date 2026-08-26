import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeLand } from "./routing.ts";
import type { LandResult } from "./types.ts";

function singleResult(): LandResult {
	return {
		status: "landed",
		frontiers: [
			{
				prNumber: 12,
				url: "https://example/12",
				expectedHeadSha: "bbb",
				method: "squash",
				state: "landed",
			},
		],
		autopilotRan: true,
		remainingRefs: [],
		completedMutations: ["single"],
		blockers: [],
	};
}

describe("routeLand", () => {
	it("routes a selected stacked PR through the complete stack prefix", async () => {
		let ranSingle = false;
		const result = await routeLand({
			provider: "jj",
			requestStackLanding: async () => ({
				handled: true,
				outcome: {
					status: "stack",
					outcome: {
						status: "completed",
						frontiers: [
							{
								ref: "feat1",
								prNumber: 11,
								url: "https://example/11",
								expectedHeadSha: "aaa",
								method: "squash",
								state: "landed",
							},
							{
								ref: "feat2",
								prNumber: 12,
								url: "https://example/12",
								expectedHeadSha: "bbb",
								method: "squash",
								state: "landed",
							},
						],
						remainingRefs: [],
						completedMutations: ["landed 11", "landed 12"],
						recoveryOperationIds: ["op1", "op2"],
					},
				},
			}),
			runSingle: async () => {
				ranSingle = true;
				return singleResult();
			},
		});
		assert.equal(ranSingle, false);
		assert.equal(result.status, "landed");
		assert.deepEqual(
			result.frontiers.map((frontier) => frontier.prNumber),
			[11, 12],
		);
	});

	it("keeps a pre-mutation jj frontier blocked so its recovery is visible", async () => {
		const recovery = "Watch is bounded. Inspect PR #11, then retry /land after CI settles.";
		const result = await routeLand({
			provider: "jj",
			requestStackLanding: async () => ({
				handled: true,
				outcome: {
					status: "stack",
					outcome: {
						status: "partial",
						error: recovery,
						frontiers: [
							{
								ref: "feat1",
								prNumber: 11,
								url: "https://example/11",
								expectedHeadSha: "aaa",
								method: "squash",
								state: "blocked",
							},
						],
						remainingRefs: ["feat1", "feat2"],
						completedMutations: [],
						recoveryOperationIds: [],
					},
				},
			}),
			runSingle: async () => singleResult(),
		});
		assert.equal(result.status, "blocked");
		assert.equal(result.blockers[0], recovery);
	});

	it("preserves single-PR behavior for Git and non-stacks", async () => {
		let requests = 0;
		const git = await routeLand({
			provider: undefined,
			requestStackLanding: async () => {
				requests++;
				return { handled: true, outcome: { status: "not-stack" } };
			},
			runSingle: async () => singleResult(),
		});
		assert.equal(git.status, "landed");
		assert.equal(requests, 0, "Git backend should not invoke stack channels");

		const nonStack = await routeLand({
			provider: "jj",
			requestStackLanding: async () => {
				requests++;
				return { handled: true, outcome: { status: "not-stack" } };
			},
			runSingle: async () => singleResult(),
		});
		assert.equal(nonStack.status, "landed");
		assert.equal(requests, 1);
	});

	it("blocks rather than risking an individual middle merge when stack detection is unavailable", async () => {
		let ranSingle = false;
		const result = await routeLand({
			provider: "jj",
			requestStackLanding: async () => ({ handled: false }),
			runSingle: async () => {
				ranSingle = true;
				return singleResult();
			},
		});
		assert.equal(ranSingle, false);
		assert.equal(result.status, "blocked");
		assert.match(result.blockers.join("\n"), /jj-stacked-prs extension is unavailable/i);
	});

	it("routes Graphite stacks through the shared stack channel", async () => {
		let singles = 0;
		const native = await routeLand({
			provider: "graphite",
			requestStackLanding: async () => ({
				handled: true,
				outcome: {
					status: "stack",
					outcome: {
						status: "completed",
						frontiers: [
							{
								ref: "kstack/one",
								prNumber: 12,
								url: "https://example/12",
								expectedHeadSha: "bbb",
								method: "graphite",
								state: "landed",
							},
						],
						remainingRefs: [],
						completedMutations: ["Graphite accepted native merge"],
						warnings: [],
						recoveryOperationIds: [],
					},
				},
			}),
			runSingle: async () => {
				singles++;
				return singleResult();
			},
		});
		assert.equal(native.status, "landed");
		assert.equal(singles, 0);

		const standalone = await routeLand({
			provider: "graphite",
			requestStackLanding: async () => ({
				handled: true,
				outcome: { status: "not-stack" },
			}),
			runSingle: async () => {
				singles++;
				return singleResult();
			},
		});
		assert.equal(standalone.status, "landed");
		assert.equal(singles, 1);
	});
});
