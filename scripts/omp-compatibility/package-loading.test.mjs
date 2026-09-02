import assert from "node:assert/strict";
import test from "node:test";
import { runPackageProbe } from "./probes.mjs";

const ompCheckout = process.env.OMP_CHECKOUT;
const probeTest = ompCheckout ? test : test.skip;

for (const kind of ["pi-manifest", "omp-manifest", "manifest-precedence", "aggregate", "legacy-imports"]) {
	probeTest(`OMP loads ${kind} fixture in explicit-only mode`, async () => {
		const probe = await runPackageProbe({ ompCheckout, kind });
		assert.equal(probe.result.timedOut, false, `diagnostics: ${probe.runRoot}`);
		assert.equal(probe.result.code, 0, `diagnostics: ${probe.runRoot}\n${probe.result.stderr}`);
		for (const command of probe.expectedCommands) {
			assert.ok(probe.commandNames.includes(command), `missing ${command}; diagnostics: ${probe.runRoot}`);
		}
		assert.equal(probe.commandNames.includes("skill:arena"), false, `ambient skill leaked: ${probe.runRoot}`);
		assert.equal(probe.result.stdout.includes("<repo-rules>"), false, `repository context leaked: ${probe.runRoot}`);
		if (kind === "manifest-precedence") assert.equal(probe.commandNames.includes("fixture-pi"), false);
		if (kind === "aggregate") assert.ok(probe.toolNames.includes("fixture_tool"));
	});
}

probeTest("OMP discards all aggregate registrations when a child factory throws", async () => {
	const probe = await runPackageProbe({ ompCheckout, kind: "aggregate-failure" });
	assert.equal(probe.result.timedOut, false, `diagnostics: ${probe.runRoot}`);
	assert.equal(probe.result.code, 0, `diagnostics: ${probe.runRoot}\n${probe.result.stderr}`);
	assert.ok(
		probe.result.stderr.includes("intentional aggregate failure"),
		`missing failure diagnostic: ${probe.runRoot}`,
	);
	assert.equal(probe.commandNames.includes("fixture-before-failure"), false);
	assert.equal(probe.commandNames.includes("fixture-after-failure"), false);
});
