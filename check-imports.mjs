#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(REPO_ROOT, "extensions");
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.\.?\/[^"']+)\1/g;

export const IMPORT_EXCEPTIONS = [
	{
		importer: "handoff/command.ts",
		target: "session-archive/archive-files.ts",
		reason: "handoff reads and archives the source session",
	},
	{
		importer: "handoff/command.ts",
		target: "session-archive/archive-ops.ts",
		reason: "handoff optionally archives the source session",
	},
	{
		importer: "handoff/history-reader.ts",
		target: "session-archive/archive-files.ts",
		reason: "handoff reads the session archive",
	},
	{
		importer: "handoff/history-reader.ts",
		target: "session-archive/archive-store.ts",
		reason: "handoff reads the session archive",
	},
	{
		importer: "handoff/history-reader.ts",
		target: "session-archive/session-jsonl.ts",
		reason: "handoff parses active session history with the archive parser",
	},
	{
		importer: "handoff/history-reader.ts",
		target: "session-archive/tool-output.ts",
		reason: "handoff uses the archive output bounds",
	},
	{
		importer: "jj-stacked-prs/index.ts",
		target: "land/confirmation.ts",
		reason: "the trusted stack lander mints Land confirmation capabilities",
	},
];

export function isTestFile(path) {
	return /\.test\.[cm]?[jt]s$/.test(path);
}

export function collectTypeScriptFiles(root) {
	const files = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(path);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
		}
	}
	return files.sort();
}

function relativePath(root, path) {
	return relative(root, path).split(sep).join("/");
}

export function collectRelativeImports(source) {
	return [...source.matchAll(RELATIVE_IMPORT)].map((match) => match[2]);
}

function extensionName(root, path) {
	const pathFromRoot = relative(root, path);
	if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") return undefined;
	return pathFromRoot.split(sep)[0];
}

function exceptionFor(importer, target, exceptions) {
	return exceptions.find((entry) => entry.importer === importer && entry.target === target);
}

export function findImportViolations({ root = DEFAULT_ROOT, exceptions = IMPORT_EXCEPTIONS } = {}) {
	const violations = [];
	for (const importerPath of collectTypeScriptFiles(root)) {
		if (isTestFile(importerPath)) continue;
		const importer = relativePath(root, importerPath);
		const importerExtension = extensionName(root, importerPath);
		for (const specifier of collectRelativeImports(readFileSync(importerPath, "utf8"))) {
			const targetPath = resolve(dirname(importerPath), specifier);
			const target = relativePath(root, targetPath);
			const targetExtension = extensionName(root, targetPath);
			if (!targetExtension) {
				violations.push({ importer, target, rule: "relative imports must stay under extensions/" });
				continue;
			}
			if (targetExtension === importerExtension) continue;
			if (importerExtension === "shared") {
				violations.push({ importer, target, rule: "shared modules cannot import extension modules" });
				continue;
			}
			if (targetExtension === "shared") continue;
			if (basename(targetPath) === "api.ts" || basename(targetPath) === "types.ts") continue;
			if (exceptionFor(importer, target, exceptions)) continue;
			violations.push({ importer, target, rule: "sibling imports must target api.ts or types.ts" });
		}
	}
	return violations;
}

export function findStaleImportExceptions({ root = DEFAULT_ROOT, exceptions = IMPORT_EXCEPTIONS } = {}) {
	return exceptions.filter((exception) => {
		const importerPath = join(root, exception.importer);
		const targetPath = join(root, exception.target);
		if (!existsSync(importerPath) || !existsSync(targetPath)) return true;
		return !collectRelativeImports(readFileSync(importerPath, "utf8")).some(
			(specifier) => resolve(dirname(importerPath), specifier) === targetPath,
		);
	});
}

function main() {
	const violations = findImportViolations();
	const stale = findStaleImportExceptions();
	for (const violation of violations) {
		console.error(`${violation.importer} -> ${violation.target} (${violation.rule})`);
	}
	for (const exception of stale) {
		console.error(`${exception.importer} -> ${exception.target} (stale import exception: ${exception.reason})`);
	}
	if (violations.length > 0 || stale.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
