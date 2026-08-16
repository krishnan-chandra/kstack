#!/usr/bin/env bun

import { readFileSync } from "node:fs";

const NODE_SQLITE_SCRIPTS = ["test:sqlite:handoff", "test:sqlite:session-archive"];

export function parseBunTestIgnorePatterns(bunfigText) {
	const patterns = bunfigText.match(/^\s*pathIgnorePatterns\s*=\s*\[([\s\S]*?)^\s*\]/m)?.[1];
	if (patterns === undefined) {
		throw new Error("bunfig.toml must define [test].pathIgnorePatterns");
	}
	return [...patterns.matchAll(/^\s*"([^"]+)"\s*,?\s*$/gm)].map((match) => match[1]);
}

export function parseNodeTestFiles(script) {
	return [...script.matchAll(/(?:^|\s)(extensions\/[^\s'"]+\.test\.ts)(?=\s|$)/g)].map((match) => match[1]);
}

function sortedDifference(left, right) {
	const rightSet = new Set(right);
	return [...new Set(left)].filter((value) => !rightSet.has(value)).sort();
}

export function validateTestSplit({ bunfigText, packageJsonText }) {
	const packageJson = JSON.parse(packageJsonText);
	const scripts = packageJson.scripts;
	if (scripts === null || typeof scripts !== "object") {
		return ["package.json must define scripts"];
	}

	const nodeTests = [];
	for (const scriptName of NODE_SQLITE_SCRIPTS) {
		const script = scripts[scriptName];
		if (typeof script !== "string") {
			return [`package.json must define ${scriptName}`];
		}
		nodeTests.push(...parseNodeTestFiles(script));
	}

	const bunIgnoredTests = parseBunTestIgnorePatterns(bunfigText).filter((path) => path.endsWith(".test.ts"));
	const errors = [];
	const missingFromBun = sortedDifference(nodeTests, bunIgnoredTests);
	if (missingFromBun.length > 0) {
		errors.push(`Bun must exclude every Node sqlite test: ${missingFromBun.join(", ")}`);
	}
	const missingFromNode = sortedDifference(bunIgnoredTests, nodeTests);
	if (missingFromNode.length > 0) {
		errors.push(`Node sqlite scripts must run every Bun-excluded test: ${missingFromNode.join(", ")}`);
	}
	return errors;
}

function main() {
	const errors = validateTestSplit({
		bunfigText: readFileSync("bunfig.toml", "utf8"),
		packageJsonText: readFileSync("package.json", "utf8"),
	});
	if (errors.length === 0) return;
	for (const error of errors) {
		console.error(error);
	}
	process.exitCode = 1;
}

if (import.meta.main) {
	main();
}
