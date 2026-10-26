import assert from "node:assert/strict";
import { it } from "node:test";
import {
	formatRouteStatus,
	formatRouteSummary,
	overrideFromBranch,
	parseRouteCommand,
	ROUTE_ENTRY_TYPE,
} from "./session-route.ts";

it("parses show, set, reset and rejects extra arguments", () => {
	assert.deepEqual(parseRouteCommand("  "), { ok: true, command: { kind: "show" } });
	for (const variant of ["floor", "nitro", "none"])
		assert.deepEqual(parseRouteCommand(` ${variant} `), { ok: true, command: { kind: "set", variant } });
	assert.deepEqual(parseRouteCommand("reset"), { ok: true, command: { kind: "reset" } });
	for (const args of ["fast", "nitro none", "show"]) assert.equal(parseRouteCommand(args).ok, false);
});
it("replays only valid route entries in active branch order", () => {
	const entry = (override: string | null) => ({
		type: "custom",
		customType: ROUTE_ENTRY_TYPE,
		data: { version: 1, override },
	});
	const first = entry("nitro");
	assert.equal(overrideFromBranch([]), undefined);
	assert.equal(overrideFromBranch([first, entry("none")]), "none");
	assert.equal(overrideFromBranch([first, entry(null)]), undefined);
	assert.equal(
		overrideFromBranch([
			first,
			null,
			entry("bad"),
			{ ...entry("floor"), customType: "other" },
			{ ...entry("floor"), data: { version: 2, override: "floor" } },
		]),
		"nitro",
	);
	assert.equal(overrideFromBranch([first]), "nitro", "returning to earlier branch restores its override");
});
it("keeps config failures visible in route summaries", () => {
	const error = "openrouter-floor.default must be floor, nitro, or none.";
	assert.match(
		formatRouteSummary({ variant: "floor", source: "built-in" }, undefined, error),
		/Config invalid:.*openrouter-floor.default/,
	);
	assert.match(formatRouteSummary(undefined, "nitro", error), /Config invalid:.*openrouter-floor.default/);
	const overridden = formatRouteSummary({ variant: "nitro", source: "session-override" }, "nitro", error);
	assert.match(overridden, /OpenRouter route: nitro \(session-override\)/);
	assert.match(
		overridden,
		/Config falls back to built-in floor\. Session overrides and model suffixes still take precedence\./,
	);
});
it("formats all sources and clears status for other providers", () => {
	assert.equal(formatRouteStatus(undefined), undefined);
	assert.equal(formatRouteStatus({ variant: "floor", source: "built-in" }), "OR floor");
	assert.equal(formatRouteStatus({ variant: "none", source: "config-default" }), "OR none");
	assert.equal(formatRouteStatus({ variant: "nitro", source: "config-model" }), "OR nitro (model config)");
	assert.equal(formatRouteStatus({ variant: "nitro", source: "session-override" }), "OR nitro (session)");
	assert.equal(formatRouteStatus({ variant: "free", source: "model-suffix" }), "OR free (suffix)");
	assert.match(formatRouteSummary(undefined, "nitro"), /Session override: nitro.*once an OpenRouter model/);
	assert.match(
		formatRouteSummary({ variant: "floor", source: "built-in" }, undefined),
		/floor \(built-in\).*No session override/,
	);
});
