import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getArgumentCompletions } from "./completion.ts";

describe("getArgumentCompletions", () => {
	it("completes both flags at the start of the arguments", () => {
		assert.deepEqual(getArgumentCompletions(""), [
			{ value: "--mode", label: "--mode" },
			{ value: "--pr", label: "--pr" },
		]);
	});

	it("narrows to a single flag by prefix", () => {
		assert.deepEqual(getArgumentCompletions("--m"), [{ value: "--mode", label: "--mode" }]);
		assert.deepEqual(getArgumentCompletions("--p"), [{ value: "--pr", label: "--pr" }]);
	});

	it("completes --mode values", () => {
		assert.deepEqual(getArgumentCompletions("--mode "), [
			{ value: "--mode check", label: "check" },
			{ value: "--mode threads", label: "threads" },
			{ value: "--mode drive", label: "drive" },
			{ value: "--mode watch", label: "watch" },
			{ value: "--mode cleanup", label: "cleanup" },
		]);
		assert.deepEqual(getArgumentCompletions("--mode dr"), [{ value: "--mode drive", label: "drive" }]);
	});

	it("never suggests a --pr value", () => {
		assert.equal(getArgumentCompletions("--pr "), null);
		assert.equal(getArgumentCompletions("--pr 12"), null);
	});

	it("preserves preceding argument text when completing a later flag", () => {
		assert.deepEqual(getArgumentCompletions("--mode check --p"), [{ value: "--mode check --pr", label: "--pr" }]);
		assert.deepEqual(getArgumentCompletions("--pr 42 --m"), [{ value: "--pr 42 --mode", label: "--mode" }]);
	});

	it("preserves preceding text when completing a --mode value after another flag", () => {
		assert.deepEqual(getArgumentCompletions("--pr 42 --mode wa"), [{ value: "--pr 42 --mode watch", label: "watch" }]);
	});

	it("returns null when no completion matches", () => {
		assert.equal(getArgumentCompletions("--mode zzz"), null);
		assert.equal(getArgumentCompletions("--bogus"), null);
	});
});
