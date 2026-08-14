import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectExports, findUnusedExports } from "./check-exports.mjs";

function tempRoot() {
	return mkdtempSync(join(tmpdir(), "kstack-check-exports-"));
}

function write(root, relativePath, source) {
	const path = join(root, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, source);
}

test("detects an unused export in a fixture temp dir", () => {
	const root = tempRoot();
	write(root, "unused.ts", "export function leftover() {\n\treturn 1;\n}\n");
	assert.deepEqual(findUnusedExports({ root }), [{ file: "unused.ts", line: 1, symbol: "leftover" }]);
});

test("accepts a test-referenced export", () => {
	const root = tempRoot();
	write(root, "used.ts", "export function helper() {\n\treturn 1;\n}\n");
	write(root, "used.test.ts", 'import { helper } from "./used.ts";\nvoid helper;\n');
	assert.deepEqual(findUnusedExports({ root }), []);
});

test("accepts a marker-comment export", () => {
	const root = tempRoot();
	write(root, "marked.ts", "/* exported: request-channel contract */\nexport interface Payload {\n\tvalue: string;\n}\n");
	assert.deepEqual(findUnusedExports({ root }), []);
});

test("passes re-exports through", () => {
	const root = tempRoot();
	write(root, "source.ts", "export function helper() {\n\treturn 1;\n}\n");
	write(root, "barrel.ts", 'export { helper } from "./source.ts";\n');
	write(root, "barrel.test.ts", 'import { helper } from "./barrel.ts";\nvoid helper;\n');
	assert.deepEqual(findUnusedExports({ root }), []);
	assert.deepEqual(
		collectExports('export { helper, type Payload } from "./source.ts";\n').map((item) => item.name),
		["helper", "Payload"],
	);
});
