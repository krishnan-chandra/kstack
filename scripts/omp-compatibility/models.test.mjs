import assert from "node:assert/strict";
import test from "node:test";
import { runPackageProbe } from "./probes.mjs";

const ompCheckout = process.env.OMP_CHECKOUT;
const probeTest = ompCheckout ? test : test.skip;

probeTest("OMP model facade resolves explicit, bare, role, current, and missing references", async () => {
	const probe = await runPackageProbe({ ompCheckout, kind: "models" });
	assert.equal(probe.result.code, 0, `diagnostics: ${probe.runRoot}\n${probe.result.stderr}`);
	assert.deepEqual(probe.modelResults?.current, { provider: "compat", id: "fixture-model" });
	assert.deepEqual(probe.modelResults?.explicit, probe.modelResults?.current);
	assert.deepEqual(probe.modelResults?.bare, probe.modelResults?.current);
	assert.deepEqual(probe.modelResults?.role, probe.modelResults?.current);
	assert.equal(probe.modelResults?.missing, undefined);
	assert.equal(probe.modelResults?.sameFamily, true);
});
