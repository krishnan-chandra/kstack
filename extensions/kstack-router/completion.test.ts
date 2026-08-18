import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getArgumentCompletions } from "./completion.ts";

function values(prefix: string): string[] | null {
	const items = getArgumentCompletions(prefix);
	return items ? items.map((item) => item.value) : null;
}

describe("kstack-router argument completions", () => {
	it("offers all flags on an empty prefix", () => {
		const items = getArgumentCompletions("");
		assert.ok(items);
		const labels = items.map((item) => item.label);
		assert.ok(labels.includes("--route"));
		assert.ok(labels.includes("--single"));
		assert.ok(labels.includes("--stack"));
		assert.ok(labels.includes("--worktree"));
		assert.ok(labels.includes("--change-kind"));
		assert.ok(labels.includes("--mode"));
		assert.ok(labels.includes("--pr"));
		assert.ok(labels.includes("--method"));
		assert.ok(labels.includes("--readiness"));
		assert.ok(labels.includes("--"));
	});

	it("narrows flags by partial prefix", () => {
		const result = values("--ro");
		assert.deepEqual(result, ["--route "]);
	});

	it("offers valid route IDs after --route", () => {
		const result = values("--route ");
		assert.ok(result);
		assert.ok(result.includes("--route investigate "));
		assert.ok(result.includes("--route change "));
		assert.ok(result.includes("--route land "));
		assert.ok(!result.some((v) => v.includes("unsupported")));
	});

	it("narrows route values by partial prefix", () => {
		const result = values("--route inv");
		assert.deepEqual(result, ["--route investigate "]);
	});

	it("offers change kinds after --change-kind", () => {
		const result = values("--route change --change-kind ");
		assert.ok(result);
		assert.ok(result.includes("--route change --change-kind bug-fix "));
		assert.ok(result.includes("--route change --change-kind feature "));
	});

	it("offers autopilot modes after --mode", () => {
		const result = values("--route pr-autopilot --mode ");
		assert.ok(result);
		assert.deepEqual(
			result.map((v) => v.trim()),
			[
				"--route pr-autopilot --mode check",
				"--route pr-autopilot --mode threads",
				"--route pr-autopilot --mode drive",
				"--route pr-autopilot --mode watch",
				"--route pr-autopilot --mode cleanup",
			],
		);
	});

	it("offers squash/rebase after --method", () => {
		const result = values("--route land --method ");
		assert.deepEqual(
			result?.map((v) => v.trim()),
			["--route land --method squash", "--route land --method rebase"],
		);
	});

	it("offers check/watch after --readiness", () => {
		const result = values("--route land --readiness ");
		assert.deepEqual(
			result?.map((v) => v.trim()),
			["--route land --readiness check", "--route land --readiness watch"],
		);
	});

	it("does not guess --pr values", () => {
		assert.equal(values("--pr "), null);
		assert.equal(values("--pr 4"), null);
	});

	it("preserves earlier flags when completing a later flag or value", () => {
		assert.deepEqual(values("--route change --ch"), ["--route change --change-kind "]);
		assert.deepEqual(values("--route change --change-kind fe"), ["--route change --change-kind feature "]);
	});

	it("stops offering flags once the task or -- has started", () => {
		assert.equal(values("Refactor the widget --ro"), null);
		assert.equal(values("--route change Refactor --ro"), null);
		assert.equal(values("--route change -- --sin"), null);
		assert.equal(values("-- some task text"), null);
	});

	it("returns null when no flag matches the typed prefix", () => {
		assert.equal(values("--nope"), null);
	});

	it("returns null for free-form task text with no dash prefix", () => {
		assert.equal(values("Refactor the widget"), null);
	});
});
