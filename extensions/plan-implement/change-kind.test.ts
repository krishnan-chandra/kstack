import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CHANGE_KINDS, changeKindLabel, changeKindPlaybookFile, isChangeKind } from "./change-kind.ts";

const PLAYBOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "playbooks");

describe("change-kind playbooks", () => {
	it("accepts only the declared taxonomy", () => {
		for (const kind of CHANGE_KINDS) assert.ok(isChangeKind(kind));
		assert.ok(!isChangeKind("migration"));
	});

	it("labels every kind and ships every specialized playbook", () => {
		for (const kind of CHANGE_KINDS) {
			assert.ok(changeKindLabel(kind));
			const file = changeKindPlaybookFile(kind);
			if (kind === "generic") assert.equal(file, undefined);
			else assert.ok(file && existsSync(join(PLAYBOOKS_DIR, file)), `Missing ${kind} playbook`);
		}
	});
});
