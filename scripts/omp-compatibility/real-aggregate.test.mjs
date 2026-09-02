import assert from "node:assert/strict";
import test from "node:test";
import { runRealAggregateProbe } from "./probes.mjs";

const ompCheckout = process.env.OMP_CHECKOUT;
const probeTest = ompCheckout ? test : test.skip;

probeTest("real KStack aggregate produces a bounded OMP loading result", async () => {
	const probe = await runRealAggregateProbe({ ompCheckout });
	assert.equal(probe.result.timedOut, false, `diagnostics: ${probe.runRoot}`);
	assert.equal(probe.result.code, 0, `diagnostics: ${probe.runRoot}\n${probe.result.stderr}`);
	assert.match(probe.result.stderr, /Failed to load extension.*node:sqlite/s);
	assert.equal(probe.commandNames.includes("sessions"), false);
});

probeTest("safe real factories have explicit per-factory OMP results", async () => {
	const probe = await runRealAggregateProbe({ ompCheckout, splitFactories: true });
	assert.equal(probe.result.timedOut, false, `diagnostics: ${probe.runRoot}`);
	assert.equal(probe.result.code, 0, `diagnostics: ${probe.runRoot}\n${probe.result.stderr}`);
	assert.deepEqual(probe.factories, [
		{ name: "graphite-stacked-prs", status: "PASS" },
		{ name: "github-stacked-prs", status: "PASS" },
		{ name: "handoff", status: "FAIL" },
		{ name: "jj-stacked-prs", status: "PASS" },
		{ name: "kstack-router", status: "PASS" },
		{ name: "land", status: "PASS" },
		{ name: "panel-review", status: "PASS" },
		{ name: "parallel-agents", status: "PASS" },
		{ name: "plan-implement", status: "PASS" },
		{ name: "pr-autopilot", status: "PASS" },
		{ name: "session-archive", status: "EXCLUDED", reason: "Pi-specific storage and node:sqlite gate" },
		{ name: "steering-swap", status: "EXCLUDED", reason: "host editor wrapper" },
	]);
});
