import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDependencies, getAllRoutes, getRouteMetadata, validateCatalog } from "./catalog.ts";
import { CLASSIFIER_SENTINEL_END, CLASSIFIER_SENTINEL_START } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

describe("kstack-router catalog", () => {
	it("validates without errors", () => {
		const errors = validateCatalog();
		assert.deepEqual(errors, []);
	});

	it("has all routes defined", () => {
		const routes = getAllRoutes();
		const ids = routes.map((r) => r.id).sort();
		assert.deepEqual(ids, [
			"arena",
			"change",
			"fast-change",
			"investigate",
			"land",
			"pr-autopilot",
			"review",
			"session-pickup",
			"skill-authoring",
			"swarm",
			"unsupported",
		]);
	});

	it("returns metadata for each route", () => {
		const routes = getAllRoutes();
		for (const r of routes) {
			const meta = getRouteMetadata(r.id);
			assert.ok(meta, `Route ${r.id} should have metadata`);
			assert.ok(meta.label, `Route ${r.id} should have a label`);
			assert.ok(meta.description, `Route ${r.id} should have a description`);
		}
	});

	it("change requires plan-implement and panel-review", () => {
		const deps = getRouteMetadata("change")?.requires ?? [];
		assert.ok(deps.includes("plan-implement"));
		assert.ok(deps.includes("panel-review"));
	});

	it("review requires panel-review", () => {
		const deps = getRouteMetadata("review")?.requires ?? [];
		assert.ok(deps.includes("panel-review"));
	});

	it("pr-autopilot requires the pr-autopilot extension", () => {
		const deps = getRouteMetadata("pr-autopilot")?.requires ?? [];
		assert.deepEqual(deps, ["pr-autopilot"]);
		assert.ok(checkDependencies("pr-autopilot", [], []).some((m) => m.includes("pr-autopilot")));
		assert.deepEqual(checkDependencies("pr-autopilot", ["pr-autopilot"], []), []);
	});

	it("land requires the land extension", () => {
		const deps = getRouteMetadata("land")?.requires ?? [];
		assert.deepEqual(deps, ["land"]);
		assert.ok(checkDependencies("land", [], []).some((m) => m.includes("land")));
		assert.deepEqual(checkDependencies("land", ["land"], []), []);
	});

	it("arena requires skill:arena", () => {
		const deps = getRouteMetadata("arena")?.requires ?? [];
		assert.ok(deps.includes("skill:arena"));
	});

	it("swarm requires skill:swarm", () => {
		const deps = getRouteMetadata("swarm")?.requires ?? [];
		assert.ok(deps.includes("skill:swarm"));
	});

	it("skill-authoring requires skill:create-skill", () => {
		const deps = getRouteMetadata("skill-authoring")?.requires ?? [];
		assert.ok(deps.includes("skill:create-skill"));
	});

	it("checkDependencies returns missing dependencies", () => {
		const missing = checkDependencies("change", [], []);
		assert.ok(missing.length > 0);
		assert.ok(missing.some((m) => m.includes("plan-implement")));
		assert.ok(missing.some((m) => m.includes("panel-review")));
	});

	it("checkDependencies returns empty when all deps are satisfied", () => {
		const missing = checkDependencies("change", ["plan-implement", "panel-review"], []);
		assert.deepEqual(missing, []);
	});

	it("checkDependencies handles skill dependencies", () => {
		const missing = checkDependencies("arena", [], []);
		assert.ok(missing.some((m) => m.includes("arena")));

		const satisfied = checkDependencies("arena", [], ["arena"]);
		assert.deepEqual(satisfied, []);
	});

	it("checkDependencies returns empty for routes without dependencies", () => {
		const missing = checkDependencies("investigate", [], []);
		assert.deepEqual(missing, []);
	});

	it("returns undefined for unknown routes", () => {
		assert.equal(
			getRouteMetadata(
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ "unknown" as never,
			),
			undefined,
		);
	});

	it("every playbookFile referenced by the catalog exists", () => {
		for (const route of getAllRoutes()) {
			if (!route.playbookFile) continue;
			const path = join(EXTENSION_DIR, "playbooks", route.playbookFile);
			assert.ok(existsSync(path), `Missing playbook for route ${route.id}: ${path}`);
		}
	});

	it("principles.md exists for the shared active-session preamble", () => {
		assert.ok(existsSync(join(EXTENSION_DIR, "playbooks", "principles.md")));
	});

	it("shared principles require branch-and-commit policy for writable work", () => {
		const principles = readFileSync(join(EXTENSION_DIR, "playbooks", "principles.md"), "utf8");
		assert.match(principles, /## Writable workstreams/);
		assert.match(principles, /dedicated `kstack\/<task-slug>` branch/);
		assert.match(principles, /commits coherent, verified increments/);
		assert.match(
			principles,
			/Read-only routes[\s\S]*`investigate`, `review`, `session-pickup`[\s\S]*do not create branches/,
		);
		assert.match(principles, /Local branch creation and incremental commits are part of writable/);
	});

	it("classifier prompt stays in sync with the catalog", () => {
		const prompt = readFileSync(join(EXTENSION_DIR, "prompts", "classifier.md"), "utf8");
		for (const route of getAllRoutes()) {
			assert.ok(
				prompt.includes(`**${route.id}**`),
				`prompts/classifier.md must describe route "${route.id}" so prompt and catalog cannot drift`,
			);
		}
		assert.ok(prompt.includes(CLASSIFIER_SENTINEL_START), "classifier prompt must include the start sentinel");
		assert.ok(prompt.includes(CLASSIFIER_SENTINEL_END), "classifier prompt must include the end sentinel");
	});
});
