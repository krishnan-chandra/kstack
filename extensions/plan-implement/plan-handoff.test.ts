import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadPlanHandoff, readPlanSnapshot } from "./plan-handoff.ts";
import { LIMITS } from "./types.ts";

const validPlan =
	"## Ordered implementation steps\n1. [STEP-1] Make the change.\n\n## Acceptance criteria\n- [AC-1] Tests pass.\n";

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "kstack-plan-handoff-"));
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
	writeFileSync(join(dir, name), text);
	return join(dir, name);
}

describe("loadPlanHandoff", () => {
	it("reads and resolves a valid ordered plan snapshot", async () => {
		write("valid.md", validPlan);
		const loaded = await loadPlanHandoff("valid.md", dir);
		assert.ok(loaded.ok);
		if (loaded.ok) {
			assert.equal(loaded.snapshot.path, join(dir, "valid.md"));
			assert.equal(loaded.snapshot.text, validPlan);
		}
	});

	it("rejects a missing, empty, or oversized file", async () => {
		const missing = await loadPlanHandoff("missing.md", dir);
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.match(missing.error, /Cannot open plan file/);

		write("empty.md", "   \n");
		const empty = await loadPlanHandoff("empty.md", dir);
		assert.equal(empty.ok, false);
		if (!empty.ok) assert.match(empty.error, /is empty/);

		write("big.md", "x".repeat(LIMITS.plannerOutputBytes + 2));
		const big = await loadPlanHandoff("big.md", dir);
		assert.equal(big.ok, false);
		if (!big.ok) assert.match(big.error, /exceeds/);
	});

	it("rejects a file without the ordered step and criterion contract", async () => {
		write("prose.md", "# A plan\n\nJust some prose.\n");
		const loaded = await loadPlanHandoff("prose.md", dir);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) assert.match(loaded.error, /not a valid ordered plan/);
	});

	it("rejects a plan with steps but no acceptance criteria", async () => {
		write("no-criteria.md", "## Ordered implementation steps\n1. [STEP-1] Do it.\n");
		const loaded = await loadPlanHandoff("no-criteria.md", dir);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) assert.match(loaded.error, /no acceptance criteria/);
	});

	it("lets the fast snapshot reader accept a plan that the full handoff rejects", async () => {
		write("prose.md", "# A plan\n\nJust some prose.\n");
		const snapshot = await readPlanSnapshot("prose.md", dir);
		assert.ok(snapshot.ok);
	});
});
