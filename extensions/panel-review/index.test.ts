import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("panel review context wiring", () => {
	it("checks provenance after assigning the snapshot review root and passes a synthesis recheck", () => {
		const snapshotAssignment = source.indexOf("scope = { ...scope, reviewRoot: prSnapshot.directory }");
		const provenanceCheck = source.indexOf("contextFilesTouchChangedContent({");
		assert.ok(snapshotAssignment >= 0);
		assert.ok(provenanceCheck > snapshotAssignment);
		assert.match(source, /checkContextProvenance,\n\s+waitForIdle/);
	});
});
