import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierRunResult } from "./classifier-runner.ts";
import { type RouteResolutionEffects, resolveRoute } from "./route-resolution.ts";
import type { RouteId, RouterArgs } from "./types.ts";

const completed: ClassifierRunResult = {
	status: "completed",
	envelope: {
		schemaVersion: 1,
		route: "change",
		confidence: "high",
		rationale: "This changes repository behavior.",
		delivery: "stack",
		changeKind: "feature",
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
			delivery: undefined,
			changeKind: "generic",
			overrode: false,
			modelSource: "explicit --route",
			confidence: undefined,
		},
	});
	assert.equal(calls.includes("classifier"), false);
});

test("accepting a recommendation inherits delivery and change kind", async () => {
	const { fx } = effects({ routes: ["change"] });
	const result = await resolve({ task: "do work" }, fx);
	assert.ok("resolved" in result);
	if ("resolved" in result) {
		assert.equal(result.resolved.route, "change");
		assert.equal(result.resolved.delivery, "stack");
		assert.equal(result.resolved.changeKind, "feature");
		assert.equal(result.resolved.overrode, false);
	}
});

test("overriding a recommendation does not inherit change metadata", async () => {
	const { fx } = effects({ routes: ["review"] });
	const result = await resolve({ task: "do work" }, fx);
	assert.ok("resolved" in result);
	if ("resolved" in result) {
		assert.equal(result.resolved.route, "review");
		assert.equal(result.resolved.delivery, undefined);
		assert.equal(result.resolved.changeKind, "generic");
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
	const { fx, calls } = effects({ routes: ["review"] });
	const result = await resolveRoute(
		{
			parsedArgs: { task: "do work" },
			task: "do work",
			routerConfig: null,
			classifierResolution: { ok: false, error: "No model available for routing classification." },
		},
		fx,
	);
	assert.ok("resolved" in result && result.resolved.route === "review");
	assert.ok(calls.includes("route:No classifier available. Select a route:"));
	assert.ok(calls.includes("notify:No model available for routing classification."));
});

test("change kind is rejected for non-change routes", async () => {
	const { fx } = effects();
	const result = await resolve({ route: "review", changeKind: "feature", task: "do work" }, fx);
	assert.deepEqual(result, { failed: "--change-kind is only valid with the change or fast-change routes." });
});

test("worktree is rejected for non-change routes", async () => {
	const { fx } = effects();
	const result = await resolve({ route: "review", worktree: true, task: "do work" }, fx);
	assert.deepEqual(result, { failed: "--worktree is only valid with the change or fast-change routes." });
});

test("an explicit stack delivery on fast-change fails with a redirect", async () => {
	const { fx } = effects();
	const result = await resolve({ route: "fast-change", delivery: "stack", task: "do work" }, fx);
	assert.deepEqual(result, { failed: "fast-change supports only single-PR workstreams. Use --route change --stack." });
});

test("an accepted fast-change recommendation ignores echoed delivery and forces single", async () => {
	const fastChange: ClassifierRunResult = {
		...completed,
		envelope: { ...completed.envelope, route: "fast-change", delivery: "stack", changeKind: "bug-fix" },
	};
	const { fx } = effects({ classifier: fastChange, routes: ["fast-change"] });
	const result = await resolve({ task: "do work" }, fx);
	assert.ok("resolved" in result);
	if ("resolved" in result) {
		assert.equal(result.resolved.route, "fast-change");
		assert.equal(result.resolved.delivery, "single");
		assert.equal(result.resolved.changeKind, "bug-fix");
	}
});

test("an explicit change route prompts for delivery and honors stack", async () => {
	const { fx, calls } = effects({ choices: ["stack"] });
	const result = await resolve({ route: "change", task: "do work" }, fx);
	assert.ok("resolved" in result && result.resolved.delivery === "stack");
	assert.ok(calls.includes("option:Delivery mode for change?"));
});

test("cancelling delivery selection cancels resolution", async () => {
	const { fx } = effects({ choices: ["Cancel"] });
	const result = await resolve({ route: "change", task: "do work" }, fx);
	assert.deepEqual(result, { cancelled: true });
});

test("a manually overridden change defaults to single without prompting", async () => {
	const manualFx = effects({ routes: ["change"] });
	const result = await resolveRoute(
		{
			parsedArgs: { task: "do work" },
			task: "do work",
			routerConfig: null,
			classifierResolution: { ok: false, error: "none" },
		},
		manualFx.fx,
	);
	assert.ok("resolved" in result && result.resolved.delivery === "single");
	assert.equal(
		manualFx.calls.some((call) => call.startsWith("option:")),
		false,
	);
});

test("session invalidation after route selection cancels further work", async () => {
	let checks = 0;
	const { fx, calls } = effects({ routes: ["change"], current: () => (++checks === 1 ? false : false) });
	const result = await resolve({ task: "do work" }, fx);
	assert.deepEqual(result, { cancelled: true });
	assert.equal(
		calls.some((call) => call.startsWith("option:")),
		false,
	);
});
