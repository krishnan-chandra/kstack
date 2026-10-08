import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDependencies, getAllRoutes, validateCatalog } from "./catalog.ts";
import type { RouteId } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function routeRequires(id: RouteId): readonly string[] {
	return getAllRoutes().find((route) => route.id === id)?.requires ?? [];
}

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
		for (const r of getAllRoutes()) {
			assert.ok(r.label, `Route ${r.id} should have a label`);
			assert.ok(r.description, `Route ${r.id} should have a description`);
		}
	});

	it("change requires plan-implement", () => {
		const deps = routeRequires("change");
		assert.deepEqual(deps, ["plan-implement"]);
	});

	it("review requires the thermo-nuclear skill", () => {
		const deps = routeRequires("review");
		assert.deepEqual(deps, ["skill:thermo-nuclear-code-quality-review"]);
	});

	it("pr-autopilot requires the pr-autopilot extension", () => {
		const deps = routeRequires("pr-autopilot");
		assert.deepEqual(deps, ["pr-autopilot"]);
		assert.ok(checkDependencies("pr-autopilot", [], []).some((m) => m.includes("pr-autopilot")));
		assert.deepEqual(checkDependencies("pr-autopilot", ["pr-autopilot"], []), []);
	});

	it("land requires the land extension", () => {
		const deps = routeRequires("land");
		assert.deepEqual(deps, ["land"]);
		assert.ok(checkDependencies("land", [], []).some((m) => m.includes("land")));
		assert.deepEqual(checkDependencies("land", ["land"], []), []);
	});

	it("arena requires skill:arena", () => {
		const deps = routeRequires("arena");
		assert.ok(deps.includes("skill:arena"));
	});

	it("swarm requires skill:swarm", () => {
		const deps = routeRequires("swarm");
		assert.ok(deps.includes("skill:swarm"));
	});

	it("skill-authoring requires skill:create-skill", () => {
		const deps = routeRequires("skill-authoring");
		assert.ok(deps.includes("skill:create-skill"));
	});

	it("checkDependencies returns missing dependencies", () => {
		const missing = checkDependencies("change", [], []);
		assert.ok(missing.length > 0);
		assert.ok(missing.some((m) => m.includes("plan-implement")));
	});

	it("checkDependencies returns empty when all deps are satisfied", () => {
		const missing = checkDependencies("change", ["plan-implement"], []);
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
});
