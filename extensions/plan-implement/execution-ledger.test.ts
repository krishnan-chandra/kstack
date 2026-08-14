import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExecutionLedger, extractExecutionLedger, validateExecutionLedger } from "./execution-ledger.ts";

const plan = `## Ordered implementation steps
1. [STEP-1] Add the parser.
2. [STEP-2] Wire the result through review.

## Acceptance criteria
- [AC-1] Every item is visible to synthesis.
- [AC-2] Omitted items block the verdict.
`;

describe("execution ledger", () => {
	it("copies ordered steps and acceptance criteria into a mutable ledger", () => {
		const result = createExecutionLedger(plan);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.match(result.ledger, /\[STEP-1\] Add the parser/);
			assert.match(result.ledger, /\[AC-2\] Omitted items block the verdict/);
			assert.deepEqual(result.items.map((item) => item.id), ["STEP-1", "STEP-2", "AC-1", "AC-2"]);
		}
	});

	it("requires exact item-by-item parity and closed statuses", () => {
		const output = `## Execution Ledger
- [STEP-1] Add the parser. — done
- [STEP-2] Wire the result through review. — blocked: panel contract still needs wiring
- [AC-1] Every item is visible to synthesis. — done
- [AC-2] Omitted items block the verdict. — skip: superseded by the blocking check
`;
	const result = validateExecutionLedger(plan, output);
	assert.equal(result.ok, true);
	if (result.ok) assert.match(result.ledger, /STEP-2.*blocked: panel contract/);
	});

	it("preserves incomplete output so synthesis can report the omission", () => {
		assert.match(extractExecutionLedger("implementation notes"), /missing from implementer result/);
		assert.match(extractExecutionLedger("## Execution Ledger\n- [STEP-1] Add the parser. — done\n\n## Verification\nok"), /STEP-1.*done/);
	});

	it("rejects omitted, changed, and reasonless entries", () => {
		const omitted = validateExecutionLedger(plan, "## Execution Ledger\n- [STEP-1] Add the parser. — done\n");
		assert.match(omitted.ok ? "" : omitted.error, /omitted approved plan item/);
		const changed = validateExecutionLedger(plan, "## Execution Ledger\n- [STEP-1] Add another parser. — done\n- [STEP-2] Wire the result through review. — done\n- [AC-1] Every item is visible to synthesis. — done\n- [AC-2] Omitted items block the verdict. — done\n");
		assert.match(changed.ok ? "" : changed.error, /does not exactly match/);
		const reasonless = validateExecutionLedger(plan, "## Execution Ledger\n- [STEP-1] Add the parser. — skip\n- [STEP-2] Wire the result through review. — done\n- [AC-1] Every item is visible to synthesis. — done\n- [AC-2] Omitted items block the verdict. — done\n");
		assert.match(reasonless.ok ? "" : reasonless.error, /must include a reason/);
		const reordered = validateExecutionLedger(plan, "## Execution Ledger\n- [STEP-2] Wire the result through review. — done\n- [STEP-1] Add the parser. — done\n- [AC-1] Every item is visible to synthesis. — done\n- [AC-2] Omitted items block the verdict. — done\n");
		assert.match(reordered.ok ? "" : reordered.error, /reordered/);
	});
});
