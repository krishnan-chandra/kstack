import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

	it("ships a self-contained engineering-principles index for every change kind", () => {
		const path = join(PLAYBOOKS_DIR, "engineering-principles.md");
		assert.ok(existsSync(path));
		const principles = readFileSync(path, "utf8");
		assert.match(principles, /Start from the observable outcome/);
		assert.match(principles, /Subtract and flatten first/);
		assert.match(principles, /Model the domain explicitly/);
		assert.match(principles, /Fix causes, not symptoms/);
		assert.match(principles, /Sequence and prove real behavior/);
		assert.doesNotMatch(principles, /principle-[a-z-]+/);
	});
});
