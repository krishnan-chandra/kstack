#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { benchmarkUsage, parseBenchmarkArgs } from "./cli.mjs";
import { formatSummaryDelta, formatSummaryMilliseconds } from "./report.mjs";
import { runStartupBenchmark } from "./runner.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function printSummary(result) {
	console.log("Pi startup benchmark");
	for (const scenario of result.scenarios) {
		console.log(
			`  ${scenario.id}: median ${formatSummaryMilliseconds(scenario.summary.medianMs)}, p90 ${formatSummaryMilliseconds(scenario.summary.p90Ms)}, MAD ${formatSummaryMilliseconds(scenario.summary.madMs)}`,
		);
	}
	console.log(`Primary full - empty median: ${formatSummaryDelta(result.primaryMetric.valueMs)}`);
	const noisy = result.scenarios.filter((scenario) => scenario.summary.noise.noisy).map((scenario) => scenario.id);
	if (noisy.length > 0) console.log(`Noise warning: ${noisy.join(", ")}`);
	console.log(`JSON: ${result.artifacts.json}`);
	console.log(`Markdown: ${result.artifacts.markdown}`);
}

async function main() {
	let options;
	try {
		options = parseBenchmarkArgs(process.argv.slice(2), REPO_ROOT);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`${message}\n\n${benchmarkUsage()}`);
		process.exitCode = 1;
		return;
	}

	if (options.help) {
		console.log(benchmarkUsage());
		return;
	}

	try {
		printSummary(await runStartupBenchmark(options));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main();
}
