import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPanel } from "./orchestrator.ts";
import type { ReviewerResult, ReviewerSpec } from "./types.ts";

const specs: ReviewerSpec[] = [
	{ label: "A", model: "a/1" },
	{ label: "B", model: "b/2" },
	{ label: "C", model: "c/3" },
	{ label: "D", model: "d/4" },
];

describe("runPanel", () => {
	it("caps concurrency and returns results in panel order", async () => {
		let running = 0;
		let peak = 0;
		const delays: Record<string, number> = { A: 30, B: 5, C: 20, D: 10 };
		const panel = await runPanel(specs, 2, async (spec) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, delays[spec.label]));
			running--;
			return {
				status: "completed",
				label: spec.label,
				model: spec.model,
				output: spec.label,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			};
		});
		assert.ok(peak <= 2, `peak concurrency ${peak}`);
		// Deterministic order despite D finishing before A.
		assert.deepEqual(
			panel.results.map((r) => r.label),
			["A", "B", "C", "D"],
		);
		assert.equal(panel.completed, 4);
	});

	it("a failed reviewer does not cancel siblings", async () => {
		const panel = await runPanel(specs.slice(0, 2), 2, async (spec): Promise<ReviewerResult> => {
			if (spec.label === "A") return { status: "failed", label: "A", model: "a/1", error: "boom" };
			return {
				status: "completed",
				label: spec.label,
				model: spec.model,
				output: "ok",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			};
		});
		assert.equal(panel.failed, 1);
		assert.equal(panel.completed, 1);
	});

	it("a throwing runner is converted into a failed result", async () => {
		const panel = await runPanel(specs.slice(0, 1), 1, async () => {
			throw new Error("spawn exploded");
		});
		assert.equal(panel.failed, 1);
		assert.equal(panel.results[0].status, "failed");
	});
});
