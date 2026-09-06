import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectExports, findUnusedExports } from "./index.mjs";

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

test("does not mistake a same-named property or comment for an import", () => {
	const root = tempRoot();
	write(root, "unused.ts", "export function fileSize() { return 1; }\n");
	write(root, "unrelated.ts", "const record = { fileSize: 1 }; // fileSize\n");
	assert.deepEqual(findUnusedExports({ root }), [{ file: "unused.ts", line: 1, symbol: "fileSize" }]);
});

test("resolves imported names to their source module, including aliases", () => {
	const root = tempRoot();
	write(root, "used.ts", "export const LIMITS = {};\n");
	write(root, "unused.ts", "export const LIMITS = {};\n");
	write(root, "consumer.ts", 'import { LIMITS as limits } from "./used.ts";\nvoid limits;\n');
	assert.deepEqual(findUnusedExports({ root }), [{ file: "unused.ts", line: 1, symbol: "LIMITS" }]);
});

test("reports unused forwarding exports even when the original has a consumer", () => {
	const root = tempRoot();
	write(root, "source.ts", "export const helper = 1;\n");
	write(root, "barrel.ts", 'export { helper } from "./source.ts";\n');
	write(root, "consumer.ts", 'import { helper } from "./source.ts";\nvoid helper;\n');
	assert.deepEqual(findUnusedExports({ root }), [{ file: "barrel.ts", line: 1, symbol: "helper" }]);
});

test("accepts a test-referenced export", () => {
	const root = tempRoot();
	write(root, "used.ts", "export function helper() {\n\treturn 1;\n}\n");
	write(root, "used.test.ts", 'import { helper } from "./used.ts";\nvoid helper;\n');
	assert.deepEqual(findUnusedExports({ root }), []);
});

test("recognizes mixed default/named imports, type aliases, and qualified import types", () => {
	const root = tempRoot();
	write(root, "source.ts", "export const helper = 1;\nexport interface Payload {}\nexport interface Options {}\n");
	write(
		root,
		"consumer.ts",
		'import factory, { helper as value, type Payload as Data } from "./source.ts";\ntype Config = import("./source.ts").Options;\n',
	);
	assert.deepEqual(findUnusedExports({ root }), []);
});

test("conservatively retains exports reached through namespace and dynamic imports", () => {
	for (const statement of [
		'import * as helpers from "./source.ts";',
		'const helpers = await import("./source.ts");',
		'import("./source.ts").then(({ helper }) => helper());',
	]) {
		const root = tempRoot();
		write(root, "source.ts", "export const helper = 1;\n");
		write(root, "consumer.ts", statement);
		assert.deepEqual(findUnusedExports({ root }), []);
	}
});

test("accepts a marker-comment export", () => {
	const root = tempRoot();
	write(
		root,
		"marked.ts",
		"/* exported: request-channel contract */\nexport interface Payload {\n\tvalue: string;\n}\n",
	);
	assert.deepEqual(findUnusedExports({ root }), []);
});

test("honors an export marker on the line immediately above", () => {
	const root = tempRoot();
	write(root, "marked-above.ts", "/* exported: contract */\nexport function standalone() {\n\treturn 1;\n}\n");
	assert.deepEqual(findUnusedExports({ root }), []);
});

test("ignores an export marker separated by a blank line (pins current 2-line window)", () => {
	// Documents, not endorses, that hasExportMarker only looks back one line above the export.
	const root = tempRoot();
	write(root, "marked-blank.ts", "/* exported: contract */\n\nexport function standalone() {\n\treturn 1;\n}\n");
	assert.deepEqual(findUnusedExports({ root }), [{ file: "marked-blank.ts", line: 3, symbol: "standalone" }]);
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
