import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSynthesisInput, buildSynthesisPrompt, renderRawReports, VERDICT_SECTIONS } from "./synthesis.ts";
import type { ReviewerResult, ScopeBundle } from "./types.ts";

const scope: ScopeBundle = {
	path: "/tmp/bundle.md",
	dir: "/tmp",
	repoRoot: "/repo",
	headSha: "h",
	baseSha: "b",
	baseRef: "main",
	baseStrategy: "explicit",
	fileCount: 3,
	diffBytes: 100,
	untrackedCount: 1,
	binaryCount: 0,
	truncated: false,
	contextFilesTouched: false,
	generatedAt: "2026-01-01T00:00:00Z",
};

const completed = (label: string, output: string): ReviewerResult => ({
	status: "completed",
	label,
	model: `m/${label}`,
	output,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
});

describe("buildSynthesisInput", () => {
	it("includes intent, scope, and every reviewer with failure diagnostics", () => {
		const { input, truncated } = buildSynthesisInput({
			intent: "Do the thing",
			scope,
			results: [
				completed("A", "finding one"),
				{ status: "failed", label: "B", model: "m/B", error: "provider exploded" },
				{ status: "aborted", label: "C", model: "m/C" },
			],
		});
		assert.equal(truncated, false);
		assert.match(input, /Do the thing/);
		assert.match(input, /finding one/);
		assert.match(input, /reviewer failed: provider exploded/);
		assert.match(input, /reviewer aborted/);
	});

	it("caps per-report and aggregate bytes", () => {
		const { input, truncated } = buildSynthesisInput({
			intent: "x",
			scope,
			results: [completed("A", "a".repeat(5000)), completed("B", "b".repeat(5000))],
			perReportCapBytes: 1000,
			aggregateCapBytes: 2500,
		});
		assert.equal(truncated, true);
		assert.ok(Buffer.byteLength(input, "utf8") < 5000);
	});

	it("discloses scope truncation", () => {
		const { input } = buildSynthesisInput({ intent: "x", scope: { ...scope, truncated: true }, results: [completed("A", "ok")] });
		assert.match(input, /Bundle truncated: yes/);
		assert.match(input, /may be incomplete/);
		assert.ok(!/manifest is complete/.test(input));
	});
});

describe("buildSynthesisPrompt", () => {
	it("requires all verdict sections and consensus rules", () => {
		const prompt = buildSynthesisPrompt("# Lead Judgment\nrules", "# Thermo lens\nApproval Bar");
		for (const section of VERDICT_SECTIONS) {
			assert.ok(prompt.includes(`### ${section}`), `missing ${section}`);
		}
		assert.match(prompt, /Consensus is a/);
		assert.match(prompt, /Do not invent findings/);
	});

	it("promotes thermo Approval Bar blockers into Act On", () => {
		const thermo = "# Thermo\nApproval Bar: file over 1k lines is a presumptive blocker.";
		const prompt = buildSynthesisPrompt("# Lead\nrules", thermo);
		assert.match(prompt, /Act On includes the thermo Approval Bar/);
		assert.ok(prompt.includes(thermo));
		for (const section of VERDICT_SECTIONS) {
			assert.ok(prompt.includes(`### ${section}`), `missing ${section}`);
		}
	});
});

describe("renderRawReports", () => {
	it("preserves every report when synthesis fails", () => {
		const text = renderRawReports([
			completed("A", "report A"),
			{ status: "failed", label: "B", model: "m/B", error: "boom" },
		]);
		assert.match(text, /Synthesis Failed/);
		assert.match(text, /report A/);
		assert.match(text, /boom/);
	});
});
