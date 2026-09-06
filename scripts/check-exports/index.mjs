#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_ROOT = join(REPO_ROOT, "extensions");
const DECLARATION_EXPORT =
	/^export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]+)\}/gm;
const EXPORTED_MARKER = /\/\*\s*exported:\s*.+?\s*\*\//;

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

function parseExportList(body) {
	return body
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const withoutType = part.replace(/^type\s+/, "");
			const alias = withoutType.match(/\sas\s+([A-Za-z_][A-Za-z0-9_]*)$/);
			return alias ? alias[1] : withoutType;
		})
		.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

function lineNumberAt(source, index) {
	return source.slice(0, index).split("\n").length;
}

function hasExportMarker(source, index) {
	const lines = source.slice(0, index).split("\n");
	const current = lines.at(-1) ?? "";
	const previous = lines.at(-2) ?? "";
	return EXPORTED_MARKER.test(current) || EXPORTED_MARKER.test(previous);
}

export function collectExports(source) {
	const exports = [];
	for (const match of source.matchAll(DECLARATION_EXPORT)) {
		exports.push({
			name: match[1],
			line: lineNumberAt(source, match.index ?? 0),
			marked: hasExportMarker(source, match.index ?? 0),
		});
	}
	for (const match of source.matchAll(EXPORT_LIST)) {
		const line = lineNumberAt(source, match.index ?? 0);
		const marked = hasExportMarker(source, match.index ?? 0);
		for (const name of parseExportList(match[1])) {
			exports.push({ name, line, marked });
		}
	}
	return exports;
}

function collectReferences(source) {
	const references = [];
	const declarations =
		/^\s*(?:import|export)\s+(?:type\s+)?(?:\w+\s*,\s*)?(\{[^}]+\}|\*(?:\s+as\s+\w+)?)\s+from\s+["'](\.[^"']+)["']/gm;
	for (const match of source.matchAll(declarations)) {
		const names = match[1].startsWith("*")
			? ["*"]
			: match[1]
					.slice(1, -1)
					.split(",")
					.map(
						(item) =>
							item
								.trim()
								.replace(/^type\s+/, "")
								.split(/\s+as\s+/)[0],
					)
					.filter(Boolean);
		references.push({ specifier: match[2], names });
	}
	// Namespace and import() expressions conservatively consume the whole module.
	// A following property may be a Promise method, not a qualified import type.
	for (const match of source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
		references.push({ specifier: match[1], names: ["*"] });
	}
	return references;
}

export function findUnusedExports({ root = DEFAULT_ROOT } = {}) {
	const sources = new Map(collectTypeScriptFiles(root).map((file) => [resolve(file), readFileSync(file, "utf8")]));
	const references = new Map();
	for (const [file, source] of sources) {
		for (const reference of collectReferences(source)) {
			const target = resolve(dirname(file), reference.specifier);
			if (target === file) continue;
			const names = references.get(target) ?? new Set();
			for (const name of reference.names) names.add(name);
			references.set(target, names);
		}
	}
	const unused = [];
	for (const [file, source] of sources) {
		if (isTestFile(file)) continue;
		const names = references.get(file);
		for (const exported of collectExports(source)) {
			if (exported.marked) continue;
			if (!names?.has(exported.name) && !names?.has("*")) {
				unused.push({
					file: relative(root, file),
					line: exported.line,
					symbol: exported.name,
				});
			}
		}
	}
	return unused;
}

function main() {
	const unused = findUnusedExports();
	if (unused.length === 0) return;
	for (const finding of unused) {
		console.error(`${finding.file}:${finding.line} ${finding.symbol}`);
	}
	process.exitCode = 1;
}

if (import.meta.main) {
	main();
}
