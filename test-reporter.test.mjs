import assert from "node:assert/strict";
import { describe, it } from "node:test";
import quietReporter from "./test-reporter.mjs";

async function collect(source) {
	let output = "";
	for await (const chunk of quietReporter(source)) {
		output += chunk;
	}
	return output;
}

describe("quietReporter", () => {
	it("outputs clean summary when all tests pass", async () => {
		async function* events() {
			yield { type: "test:pass", data: { name: "test 1", details: { type: "test" } } };
			yield { type: "test:pass", data: { name: "test 2", details: { type: "test" } } };
			yield {
				type: "test:summary",
				data: {
					success: true,
					counts: { tests: 2, passed: 2, failed: 0, suites: 1 },
					duration_ms: 1500,
				},
			};
		}

		const output = await collect(events());
		assert.match(output, /✔ 2 tests passed across 1 suites \(1\.50s\)/);
		assert.doesNotMatch(output, /test 1/);
	});

	it("formats test failures with location, error cause, and stack", async () => {
		async function* events() {
			yield {
				type: "test:fail",
				data: {
					name: "should compute total",
					file: "/repo/math.test.ts",
					line: 42,
					column: 5,
					details: {
						type: "test",
						error: {
							code: "ERR_TEST_FAILURE",
							cause: {
								message: "Expected 1 to equal 2",
								stack: "AssertionError: Expected 1 to equal 2\n    at TestContext.<anonymous> (/repo/math.test.ts:43:10)",
							},
						},
					},
				},
			};
			yield {
				type: "test:summary",
				data: {
					success: false,
					counts: { tests: 1, passed: 0, failed: 1, suites: 1 },
					duration_ms: 500,
				},
			};
		}

		const output = await collect(events());
		assert.match(output, /✖ should compute total \(\/repo\/math\.test\.ts:42:5\)/);
		assert.match(output, /Expected 1 to equal 2/);
		assert.match(output, /math\.test\.ts:43:10/);
		assert.match(output, /✖ 1 failed, 0 passed across 1 suites \(0\.50s\)/);
	});

	it("forwards test stderr messages", async () => {
		async function* events() {
			yield { type: "test:stderr", data: { message: "SyntaxError: Unexpected token\n" } };
			yield {
				type: "test:summary",
				data: {
					success: false,
					counts: { tests: 0, passed: 0, failed: 1, suites: 0 },
					duration_ms: 100,
				},
			};
		}

		const output = await collect(events());
		assert.match(output, /SyntaxError: Unexpected token/);
	});
});
