import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateConfig } from "./extensions/plan-implement/config.ts";
import { validateAdversaryConfig } from "./extensions/shared/kstack-config.ts";
import { isObject } from "./extensions/shared/validation.ts";

const REPO_ROOT = import.meta.dirname;
const example = JSON.parse(readFileSync(join(REPO_ROOT, "kstack.example.json"), "utf8"));

function adversaryModelId(entry) {
	return isObject(entry) ? entry.model : entry;
}

test("kstack.example.json passes the plan-implement and adversary validators", () => {
	const planImplement = validateConfig(example["plan-implement"]);
	assert.equal(planImplement.ok, true, planImplement.ok ? "" : planImplement.error);

	const adversary = validateAdversaryConfig(example.adversary);
	assert.equal(adversary.ok, true, adversary.ok ? "" : adversary.error);
});

test("kstack.example.json keeps every adversary model distinct from the planner", () => {
	const planImplement = validateConfig(example["plan-implement"]);
	const adversary = validateAdversaryConfig(example.adversary);
	assert.equal(planImplement.ok, true);
	assert.equal(adversary.ok, true);
	if (!planImplement.ok || !adversary.ok) return;

	const planner = planImplement.config.planner.model;
	for (const entry of adversary.config.adversaries) {
		assert.notEqual(adversaryModelId(entry), planner, "adversary model must differ from the planner model");
	}
});
