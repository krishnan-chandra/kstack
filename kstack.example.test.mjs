import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRoutingConfig } from "./extensions/openrouter-floor/routing-policy.ts";
import { validateRouterConfig } from "./extensions/kstack-router/config.ts";
import { resolveCouncilRoster } from "./extensions/shared/council/roster.ts";
import { validateCouncilConfig } from "./extensions/shared/kstack-config.ts";

const REPO_ROOT = import.meta.dirname;
const EXAMPLE_PATH = join(REPO_ROOT, "kstack.example.json");
const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));

test("kstack.example.json passes the council, router, and routing policy validators", () => {
	const council = validateCouncilConfig(example.council);
	assert.equal(council.ok, true, council.ok ? "" : council.error);

	const routing = validateRoutingConfig(example["openrouter-floor"]);
	assert.equal(routing.ok, true, routing.ok ? "" : routing.error);

	const router = validateRouterConfig(example["kstack-router"]);
	assert.equal(router.ok, true, router.ok ? "" : router.error);
});

test("kstack.example.json leaves council seats after the example planner sits out", () => {
	const plannerModel = "openai/gpt-6-astra:high";
	const dir = mkdtempSync(join(tmpdir(), "kstack-example-"));
	try {
		copyFileSync(EXAMPLE_PATH, join(dir, "kstack.json"));
		const roster = resolveCouncilRoster({
			env: { PI_CODING_AGENT_DIR: dir },
			plannerModel,
			whenMissing: "error",
		});
		assert.equal(roster.ok, true, roster.ok ? "" : roster.error);
		if (!roster.ok) return;
		assert.ok((roster.roster?.seats.length ?? 0) >= 1);
		assert.deepEqual(roster.roster?.excluded, [plannerModel]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
