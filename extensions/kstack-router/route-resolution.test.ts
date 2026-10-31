import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierRunResult } from "./classifier-runner.ts";
import { type RouteResolutionEffects, resolveRoute } from "./route-resolution.ts";
import type { RouteId, RouterArgs } from "./types.ts";

const completed: ClassifierRunResult = {
	status: "completed",
	envelope: {
		schemaVersion: 1,
		route: "investigate",
		confidence: "high",
		rationale: "This is a read-only research task.",
	},
	model: "test/classifier",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};

function effects(
	options: { classifier?: ClassifierRunResult; routes?: RouteId[]; choices?: string[]; current?: () => boolean } = {},
) {
	const calls: string[] = [];
	const routes = [...(options.routes ?? [])];
	const choices = [...(options.choices ?? [])];
	const fx: RouteResolutionEffects = {
		notify: (message) => calls.push(`notify:${message}`),
		selectRoute: async (title) => {
			calls.push(`route:${title}`);
			return routes.shift();
		},
		selectOption: async (title) => {
			calls.push(`option:${title}`);
			return choices.shift();
		},
		runClassifier: async () => {
			calls.push("classifier");
			return options.classifier ?? completed;
		},
		isSessionCurrent: options.current ?? (() => true),
		beginClassifier: () => {
			calls.push("begin");
			return new AbortController();
		},
		endClassifier: () => calls.push("end"),
		setStatus: (status) => calls.push(`status:${status ?? "clear"}`),
	};
	return { fx, calls };
}

const classifierResolution = { modelId: "test/classifier", source: "config" as const, thinking: "low" as const };

async function resolve(args: RouterArgs, fx: RouteResolutionEffects, resolution = classifierResolution) {
	return resolveRoute({ parsedArgs: args, task: "do work", routerConfig: null, classifierResolution: resolution }, fx);
}

test("an explicit route skips classification", async () => {
	const { fx, calls } = effects();
	const result = await resolve({ route: "investigate", task: "do work" }, fx);
	assert.deepEqual(result, {
		resolved: {
			route: "investigate",
			overrode: false,
			modelSource: "explicit --route",
			confidence: undefined,
		},
	});
	assert.equal(calls.includes("classifier"), false);
});

test("accepting a recommendation uses the recommended route", async () => {
	const { fx } = effects({ routes: ["investigate"] });
	const result = await resolve({ task: "do work" }, fx);
	assert.ok("resolved" in result);
	if ("resolved" in result) {
		assert.equal(result.resolved.route, "investigate");
		assert.equal(result.resolved.overrode, false);
		assert.equal(result.resolved.confidence, "high");
	}
});

test("overriding a recommendation marks the resolution overridden", async () => {
	const { fx } = effects({ routes: ["review"] });
	const result = await resolve({ task: "do work" }, fx);
	assert.ok("resolved" in result);
	if ("resolved" in result) {
		assert.equal(result.resolved.route, "review");
		assert.equal(result.resolved.overrode, true);
	}
});

test("classifier failure falls back to manual selection", async () => {
	const { fx, calls } = effects({
		classifier: { status: "failed", error: "bad envelope", stderr: "" },
		routes: ["investigate"],
	});
	const result = await resolve({ task: "do work" }, fx);
	assert.ok("resolved" in result && result.resolved.route === "investigate");
	assert.ok(calls.includes("route:Select a route:"));
});

test("missing classifier model uses the no-classifier manual prompt", async () => {
	const { fx, calls } = effects({ routes: ["investigate"] });
	const result = await resolveRoute(
		{
			parsedArgs: { task: "do work" },
			task: "do work",
			routerConfig: null,
			classifierResolution: { ok: false, error: "No model available for routing classification." },
		},
		fx,
	);
	assert.ok("resolved" in result && result.resolved.route === "investigate");
	assert.ok(calls.includes("route:No classifier available. Select a route:"));
	assert.ok(calls.includes("notify:No model available for routing classification."));
});

test("session invalidation after route selection cancels further work", async () => {
	let checks = 0;
	const { fx, calls } = effects({
		routes: ["review"],
		current: () => {
			checks += 1;
			return false;
		},
	});
	const result = await resolve({ task: "do work" }, fx);
	assert.deepEqual(result, { cancelled: true });
	assert.equal(checks, 1);
	assert.equal(
		calls.some((call) => call.startsWith("option:")),
		false,
	);
});
