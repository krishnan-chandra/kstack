import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBunTestIgnorePatterns, parseNodeTestFiles, validateTestSplit } from "./test-split-check.mjs";

const SQLITE_TESTS = [
	"extensions/handoff/history-reader.test.ts",
	"extensions/handoff/index.test.ts",
	"extensions/session-archive/archive-ops.test.ts",
	"extensions/session-archive/archive-store.test.ts",
	"extensions/session-archive/reconcile.test.ts",
];

function packageJson(scripts) {
	return JSON.stringify({ scripts });
}

test("parses Bun test exclusions and Node test file arguments", () => {
	assert.deepEqual(
		parseBunTestIgnorePatterns(`
[test]
pathIgnorePatterns = [
  "extensions/handoff/history-reader.test.ts",
  "skills/tdd/evals",
]
`),
		["extensions/handoff/history-reader.test.ts", "skills/tdd/evals"],
	);
	assert.deepEqual(
		parseNodeTestFiles("node --test extensions/handoff/history-reader.test.ts extensions/handoff/index.test.ts"),
		["extensions/handoff/history-reader.test.ts", "extensions/handoff/index.test.ts"],
	);
});

test("accepts matching Bun exclusions and Node sqlite test scripts", () => {
	const errors = validateTestSplit({
		bunfigText: `[test]\npathIgnorePatterns = [\n${SQLITE_TESTS.map((path) => `  "${path}",`).join("\n")}\n  "skills/tdd/evals",\n]`,
		packageJsonText: packageJson({
			"test:sqlite:handoff": `node --test ${SQLITE_TESTS.slice(0, 2).join(" ")}`,
			"test:sqlite:session-archive": `node --test ${SQLITE_TESTS.slice(2).join(" ")}`,
		}),
	});
	assert.deepEqual(errors, []);
});

test("reports Node sqlite tests missing from Bun exclusions", () => {
	const errors = validateTestSplit({
		bunfigText: `[test]\npathIgnorePatterns = [\n  "${SQLITE_TESTS[0]}",\n]`,
		packageJsonText: packageJson({
			"test:sqlite:handoff": `node --test ${SQLITE_TESTS.slice(0, 2).join(" ")}`,
			"test:sqlite:session-archive": `node --test ${SQLITE_TESTS.slice(2).join(" ")}`,
		}),
	});
	assert.deepEqual(errors, [
		"Bun must exclude every Node sqlite test: extensions/handoff/index.test.ts, extensions/session-archive/archive-ops.test.ts, extensions/session-archive/archive-store.test.ts, extensions/session-archive/reconcile.test.ts",
	]);
});

test("reports Bun exclusions missing from Node sqlite scripts", () => {
	const errors = validateTestSplit({
		bunfigText: `[test]\npathIgnorePatterns = [\n${SQLITE_TESTS.map((path) => `  "${path}",`).join("\n")}\n]`,
		packageJsonText: packageJson({
			"test:sqlite:handoff": `node --test ${SQLITE_TESTS.slice(0, 2).join(" ")}`,
			"test:sqlite:session-archive": `node --test ${SQLITE_TESTS.slice(2, 4).join(" ")}`,
		}),
	});
	assert.deepEqual(errors, [
		"Node sqlite scripts must run every Bun-excluded test: extensions/session-archive/reconcile.test.ts",
	]);
});
