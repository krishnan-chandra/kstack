import assert from "node:assert/strict";
import test from "node:test";
import { completeLandArgs, parseLandArgs } from "./command.ts";

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
	assert.equal(parseLandArgs("--method squash --method rebase").ok, false);
	assert.equal(parseLandArgs("--readiness check --readiness watch").ok, false);
});

test("completes flags and finite values while preserving earlier flags", () => {
	assert.deepEqual(completeLandArgs(""), [
		{ value: "--pr", label: "--pr" },
		{ value: "--method", label: "--method" },
		{ value: "--readiness", label: "--readiness" },
	]);
	assert.deepEqual(completeLandArgs("--m"), [{ value: "--method", label: "--method" }]);
	assert.deepEqual(completeLandArgs("--method "), [
		{ value: "--method squash", label: "squash" },
		{ value: "--method rebase", label: "rebase" },
	]);
	assert.deepEqual(completeLandArgs("--pr 42 --readiness "), [
		{ value: "--pr 42 --readiness check", label: "check" },
		{ value: "--pr 42 --readiness watch", label: "watch" },
	]);
	assert.equal(completeLandArgs("--pr "), null);
	assert.equal(completeLandArgs("--pr 4"), null);
	assert.equal(completeLandArgs("auth-stack"), null);
});
