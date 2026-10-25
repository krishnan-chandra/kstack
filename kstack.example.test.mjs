import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfig } from "./extensions/plan-implement/config.ts";
import { validateRouterConfig } from "./extensions/kstack-router/config.ts";
import { resolveCouncilRoster } from "./extensions/shared/council/roster.ts";
import { validateCouncilConfig } from "./extensions/shared/kstack-config.ts";

const REPO_ROOT = import.meta.dirname;
const EXAMPLE_PATH = join(REPO_ROOT, "kstack.example.json");
const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));

test("kstack.example.json passes the plan-implement, council, and router validators", () => {
	const planImplement = validateConfig(example["plan-implement"]);
	assert.equal(planImplement.ok, true, planImplement.ok ? "" : planImplement.error);

	const council = validateCouncilConfig(example.council);
	assert.equal(council.ok, true, council.ok ? "" : council.error);

	const router = validateRouterConfig(example["kstack-router"]);
	assert.equal(router.ok, true, router.ok ? "" : router.error);
});

test("kstack.example.json leaves council seats after the example planner sits out", () => {
	const planImplement = validateConfig(example["plan-implement"]);
	assert.equal(planImplement.ok, true);
	if (!planImplement.ok) return;
	const dir = mkdtempSync(join(tmpdir(), "kstack-example-"));
	try {
		copyFileSync(EXAMPLE_PATH, join(dir, "kstack.json"));
		const roster = resolveCouncilRoster({
			env: { PI_CODING_AGENT_DIR: dir },
			plannerModel: planImplement.config.planner.model,
			whenMissing: "error",
		});
		assert.equal(roster.ok, true, roster.ok ? "" : roster.error);
		if (!roster.ok) return;
		assert.ok((roster.roster?.seats.length ?? 0) >= 1);
		assert.deepEqual(roster.roster?.excluded, ["openai/gpt-6-astra:high"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
