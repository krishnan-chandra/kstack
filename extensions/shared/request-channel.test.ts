import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequestChannel, type RequestEnvelope } from "./request-channel.ts";
import { type BoundaryValue, isObject, isString } from "./validation.ts";

interface Payload {
	value: string;
}

const channel = createRequestChannel<Payload, string, 2>({
	event: "test:request",
	schemaVersion: 2,
	isPayload: (value): value is Payload =>
		isObject(value) && value !== null && "value" in value && isString(value.value),
});

function fakePi(listener?: (value: BoundaryValue) => void): ExtensionAPI {
	return /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		events: {
			emit: (event: string, value: BoundaryValue) => {
				assert.equal(event, "test:request");
				listener?.(value);
			},
		},
	} as ExtensionAPI;
}

test("claims a valid request exactly once", async () => {
	const envelope: RequestEnvelope<Payload, string, 2> = {
		schemaVersion: 2,
		payload: { value: "one" },
		claimed: false,
	};
	assert.equal(
		channel.claim(envelope, async ({ value }) => value.toUpperCase()),
		true,
	);
	assert.equal(
		channel.claim(envelope, async () => "second"),
		false,
	);
	assert.equal(await envelope.completion, "ONE");
});

test("rejects the wrong schema version", () => {
	assert.equal(channel.isRequest({ schemaVersion: 1, payload: { value: "one" }, claimed: false }), false);
});

test("requires a boolean claimed field", () => {
	assert.equal(channel.isRequest({ schemaVersion: 2, payload: { value: "one" } }), false);
});

test("consults the payload validator", () => {
	assert.equal(channel.isRequest({ schemaVersion: 2, payload: { value: 1 }, claimed: false }), false);
});

test("reports an unclaimed request as unhandled", async () => {
	assert.deepEqual(await channel.request(fakePi(), { value: "one" }), { handled: false });
});

test("awaits the claimed request result", async () => {
	const result = await channel.request(
		fakePi((value) => channel.claim(value, async ({ value: text }) => text.toUpperCase())),
		{ value: "one" },
	);
	assert.deepEqual(result, { handled: true, outcome: "ONE" });
});

test("passes the exact payload object to the runner", async () => {
	const payload = { value: "same" };
	let received: Payload | undefined;
	await channel.request(
		fakePi((value) =>
			channel.claim(value, async (claimedPayload) => {
				received = claimedPayload;
				return "done";
			}),
		),
		payload,
	);
	assert.equal(received, payload);
});
