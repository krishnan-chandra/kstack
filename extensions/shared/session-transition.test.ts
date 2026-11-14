import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	claimSessionTransition,
	consumeSessionTransition,
	parseToolTokenArg,
	releaseSessionTransition,
} from "./session-transition.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
	releaseSessionTransition(SESSION_A);
	releaseSessionTransition(SESSION_B);
});

describe("session transition registry", () => {
	it("claims at most one pending transition per session until consumed or released", () => {
		const token = claimSessionTransition(SESSION_A, "handoff");
		assert.ok(token);
		assert.equal(claimSessionTransition(SESSION_A, "archive_session"), undefined);
		assert.equal(claimSessionTransition(SESSION_A, "handoff"), undefined);

		// Another session remains independent.
		const other = claimSessionTransition(SESSION_B, "archive_session");
		assert.ok(other);
		assert.equal(consumeSessionTransition(SESSION_B, "archive_session", other), true);

		// Wrong kind or wrong token does not consume the claim.
		assert.equal(consumeSessionTransition(SESSION_A, "archive_session", token), false);
		assert.equal(consumeSessionTransition(SESSION_A, "handoff", "wrong-token"), false);
		assert.equal(consumeSessionTransition(SESSION_A, "handoff", token), true);

		// Once consumed, a new transition can be claimed.
		const next = claimSessionTransition(SESSION_A, "archive_session");
		assert.ok(next);
		releaseSessionTransition(SESSION_A, "not-the-token");
		assert.equal(claimSessionTransition(SESSION_A, "handoff"), undefined);
		releaseSessionTransition(SESSION_A, next);
		assert.ok(claimSessionTransition(SESSION_A, "handoff"));
	});

	it("shares pending transition claims across isolated module graphs", async () => {
		const importIsolated = (copy: string): Promise<typeof import("./session-transition.ts")> =>
			import(`./session-transition.ts?copy=${copy}`);
		const copyA = await importIsolated("a");
		const copyB = await importIsolated("b");

		const token = copyA.claimSessionTransition(SESSION_A, "handoff");
		assert.ok(token);
		assert.equal(copyB.claimSessionTransition(SESSION_A, "archive_session"), undefined);
		assert.equal(copyB.consumeSessionTransition(SESSION_A, "handoff", token), true);
	});
});

describe("parseToolTokenArg", () => {
	it("extracts exact --tool-token=<token> values and rejects malformed args", () => {
		assert.equal(parseToolTokenArg("--tool-token=abc-123"), "abc-123");
		assert.equal(parseToolTokenArg("  --tool-token=abc-123  "), "abc-123");
		assert.equal(parseToolTokenArg("--tool-token="), undefined);
		assert.equal(parseToolTokenArg("--tool-token=abc extra"), undefined);
		assert.equal(parseToolTokenArg("--archive goal"), undefined);
		assert.equal(parseToolTokenArg(""), undefined);
	});
});
