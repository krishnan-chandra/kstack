import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findImportViolations, findStaleImportExceptions, IMPORT_EXCEPTIONS } from "./index.mjs";

const EXTENSIONS_ROOT = join(import.meta.dirname, "..", "extensions");

function tempRoot() {
	return mkdtempSync(join(tmpdir(), "kstack-check-imports-"));
}

function write(root, relativePath, source = "export {};\n") {
	const path = join(root, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, source);
}

test("allows sibling api.ts imports", () => {
	const root = tempRoot();
	write(root, "alpha/index.ts", 'import { request } from "../beta/api.ts";\nvoid request;\n');
	write(root, "beta/api.ts", "export const request = 1;\n");
	assert.deepEqual(findImportViolations({ root, exceptions: [] }), []);
});

test("rejects sibling implementation imports", () => {
	const root = tempRoot();
	write(root, "alpha/index.ts", 'import { run } from "../beta/orchestrator.ts";\nvoid run;\n');
	write(root, "beta/orchestrator.ts", "export const run = 1;\n");
	assert.deepEqual(findImportViolations({ root, exceptions: [] }), [
		{
			importer: "alpha/index.ts",
			target: "beta/orchestrator.ts",
			rule: "sibling imports must target api.ts or types.ts",
		},
	]);
});

test("allows an exact documented exception", () => {
	const root = tempRoot();
	write(root, "alpha/index.ts", 'import { run } from "../beta/orchestrator.ts";\nvoid run;\n');
	write(root, "beta/orchestrator.ts", "export const run = 1;\n");
	const exceptions = [{ importer: "alpha/index.ts", target: "beta/orchestrator.ts", reason: "fixture" }];
	assert.deepEqual(findImportViolations({ root, exceptions }), []);
});

test("rejects shared imports from an extension", () => {
	const root = tempRoot();
	write(root, "shared/helper.ts", 'import type { Payload } from "../beta/types.ts";\nvoid 0;\n');
	write(root, "beta/types.ts", "export interface Payload { value: string }\n");
	assert.deepEqual(findImportViolations({ root, exceptions: [] }), [
		{
			importer: "shared/helper.ts",
			target: "beta/types.ts",
			rule: "shared modules cannot import extension modules",
		},
	]);
});

test("keeps every documented exception tied to existing files", () => {
	assert.deepEqual(findStaleImportExceptions({ root: EXTENSIONS_ROOT, exceptions: IMPORT_EXCEPTIONS }), []);
});

test("rejects relative imports escaping extensions root", () => {
	const root = tempRoot();
	write(root, "alpha/index.ts", 'import { outside } from "../../outside.ts";\nvoid outside;\n');
	assert.deepEqual(findImportViolations({ root, exceptions: [] }), [
		{
			importer: "alpha/index.ts",
			target: "../outside.ts",
			rule: "relative imports must stay under extensions/",
		},
	]);
});

test("flags stale import exception when importer does not exist", () => {
	const root = tempRoot();
	write(root, "beta/target.ts", "export const value = 1;\n");
	const exceptions = [
		{
			importer: "alpha/missing.ts",
			target: "beta/target.ts",
			reason: "missing importer test",
		},
	];
	assert.deepEqual(findStaleImportExceptions({ root, exceptions }), exceptions);
});

test("flags stale import exception when import is no longer present", () => {
	const root = tempRoot();
	write(root, "alpha/index.ts", "export const x = 1;\n");
	write(root, "beta/target.ts", "export const value = 1;\n");
	const exceptions = [
		{
			importer: "alpha/index.ts",
			target: "beta/target.ts",
			reason: "unused exception test",
		},
	];
	assert.deepEqual(findStaleImportExceptions({ root, exceptions }), exceptions);
});
