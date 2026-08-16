import assert from "node:assert/strict";
import test from "node:test";

function importIsolated(copy: string): Promise<typeof import("./confirmation.ts")> {
	return import(`./confirmation.ts?copy=${copy}`);
}

test("confirmation minted by an isolated extension module is accepted", async () => {
	const issuer = await importIsolated("issuer");
	const verifier = await importIsolated("verifier");

	const confirmation = issuer.issueLandConfirmation();

	assert.equal(verifier.isLandConfirmation(confirmation), true);
});
