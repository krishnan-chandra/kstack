import assert from "node:assert/strict";
import test from "node:test";
import { parseLandArgs } from "./command.ts";

test("parses supported single-PR options", () => {
	assert.deepEqual(parseLandArgs("--pr 42 --method squash --readiness watch"), {
		ok: true,
		args: { pr: 42, method: "squash", readiness: "watch" },
	});
});

test("rejects the unimplemented stack surface", () => {
	const result = parseLandArgs("--top auth-stack");
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /unknown option.*--top/i);
});

test("rejects malformed and duplicate options", () => {
	assert.equal(parseLandArgs("--pr nope").ok, false);
	assert.equal(parseLandArgs("--method merge --method squash").ok, false);
	assert.equal(parseLandArgs("--readiness check --readiness watch").ok, false);
});
