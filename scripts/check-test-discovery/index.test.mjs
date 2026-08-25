import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Meta-test: ensures every *.test.ts and *.test.mjs file in the repository
 * (excluding known exceptions) is covered by the `test` script in package.json.
 *
 * This prevents silently orphaned tests when new directories are added.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const EXCLUDED_DIRS = ["node_modules", "local", ".workspace", ".git", "evals"];
const EXCLUDED_GLOBS = EXCLUDED_DIRS.flatMap((directory) => [
	directory,
	`${directory}/**`,
	`**/${directory}`,
	`**/${directory}/**`,
]);

function getTestScriptPatterns() {
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	const testScript = pkg.scripts.test;
	// Extract quoted glob/file arguments from the test command
	return Array.from(testScript.matchAll(/"([^"]+)"/g), (match) => match[1]);
}

function findTestFiles() {
	const files = [];
	const patterns = ["**/*.test.ts", "**/*.test.mjs"];

	for (const pattern of patterns) {
		const found = globSync(pattern, {
			cwd: REPO_ROOT,
			absolute: false,
			exclude: EXCLUDED_GLOBS,
		});
		files.push(...found);
	}

	// Filter out excluded directories
	return files.filter((file) => {
		const parts = file.split("/");
		return !parts.some((part) => EXCLUDED_DIRS.includes(part));
	});
}

function findMatchedTestFiles(patterns) {
	return new Set(
		patterns.flatMap((pattern) =>
			globSync(pattern, {
				cwd: REPO_ROOT,
				absolute: false,
				exclude: EXCLUDED_GLOBS,
			}),
		),
	);
}

describe("Test discovery coverage", () => {
	it("every test file is matched by the test script patterns", () => {
		const patterns = getTestScriptPatterns();
		const matchedTestFiles = findMatchedTestFiles(patterns);
		const orphaned = findTestFiles().filter((file) => !matchedTestFiles.has(file));

		if (orphaned.length > 0) {
			const message = [
				"Found test files not matched by the `test` script in package.json:",
				...orphaned.map((f) => `  - ${f}`),
				"",
				"Add a pattern to the `test` script to include these files.",
			].join("\n");
			assert.fail(message);
		}
	});
});
