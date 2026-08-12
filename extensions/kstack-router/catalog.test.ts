import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCatalog, getAllRoutes, getRouteMetadata, checkDependencies } from "./catalog.ts";

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
			"investigate",
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
		assert.equal(getRouteMetadata("unknown" as never), undefined);
	});
});