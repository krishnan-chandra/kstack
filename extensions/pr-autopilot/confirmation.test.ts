import assert from "node:assert/strict";
import test from "node:test";

function importIsolated(copy: string): Promise<typeof import("./confirmation.ts")> {
	return import(`./confirmation.ts?copy=${copy}`);
}

test("confirmation minted by an isolated extension module is accepted", async () => {
	const issuer = await importIsolated("issuer");
	const verifier = await importIsolated("verifier");

	const confirmation = issuer.issueAutopilotConfirmation();

	assert.equal(verifier.isAutopilotConfirmation(confirmation), true);
});

test("a reconstructed plain object is not a confirmation", async () => {
	const verifier = await importIsolated("verifier-plain");

	assert.equal(verifier.isAutopilotConfirmation({}), false);
	assert.equal(verifier.isAutopilotConfirmation({ confirmed: true }), false);
	assert.equal(verifier.isAutopilotConfirmation(true), false);
});
