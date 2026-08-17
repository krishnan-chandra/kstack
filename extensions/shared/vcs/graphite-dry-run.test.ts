import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGraphiteDryRunAffectedRefs, verifyGraphiteDryRunAffectedRefs } from "./graphite-dry-run.ts";

describe("Graphite dry-run evidence", () => {
	it("parses bounded submit output after stripping terminal sequences", () => {
		const raw =
			"\u001b[32mPreparing to submit PRs for the following branches...\u001b[0m\n▸ kstack/one (Create)\n▸ kstack/two (Update)\n✅ Dry run complete.\n";
		assert.deepEqual(parseGraphiteDryRunAffectedRefs(raw, "submit"), {
			ok: true,
			affectedRefs: ["kstack/one", "kstack/two"],
		});
	});

	it("parses merge output and requires the exact expected order", () => {
		const raw = "Preparing to merge:\n▸ kstack/two\n▸ kstack/one\n✅ Dry run complete.\n";
		assert.equal(verifyGraphiteDryRunAffectedRefs(raw, "merge", ["kstack/two", "kstack/one"]).ok, true);
		const mismatched = verifyGraphiteDryRunAffectedRefs(raw, "merge", ["kstack/one"]);
		assert.equal(mismatched.ok, false);
		assert.match(mismatched.ok ? "" : mismatched.error, /expected/);
	});

	it("fails closed on ambiguous, duplicate, or incomplete output", () => {
		assert.equal(parseGraphiteDryRunAffectedRefs("Dry run complete.", "submit").ok, false);
		assert.equal(
			parseGraphiteDryRunAffectedRefs(
				"Preparing to merge:\n▸ kstack/one\n▸ kstack/one\n✅ Dry run complete.\n",
				"merge",
			).ok,
			false,
		);
		assert.equal(parseGraphiteDryRunAffectedRefs("Preparing to merge:\n▸ kstack/one\n", "merge").ok, false);
	});
});
