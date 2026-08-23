import { join, resolve } from "node:path";

class BenchmarkUsageError extends Error {}

function filesystemTimestamp(date) {
	return date.toISOString().replace(/[:.]/g, "-");
}

function parseCount(value, option, minimum) {
	if (!/^\d+$/.test(value)) {
		throw new BenchmarkUsageError(`${option} requires a non-negative integer.`);
	}

	const count = Number(value);
	if (!Number.isSafeInteger(count) || count < minimum) {
		throw new BenchmarkUsageError(`${option} must be at least ${minimum}.`);
	}
	return count;
}

function readOptionValue(argv, index, option) {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new BenchmarkUsageError(`${option} requires a value.`);
	}
	return value;
}

export function benchmarkUsage() {
	return `Usage: node scripts/startup-benchmark/index.mjs [options]

Options:
  --runs <count>         Measured rounds (default: 10; minimum: 1)
  --warmups <count>      Warmup rounds (default: 2; minimum: 0)
  --timeout-ms <count>   Per-probe timeout in milliseconds (default: 15000; minimum: 1)
  --pi <path>            Pi executable (default: <repo>/node_modules/.bin/pi)
  --package-root <path>  Kstack package root (default: repository root)
  --output <base>        Artifact base path (default: local/benchmarks/startup/<UTC timestamp>)
  --help                 Show this help message`;
}

export function parseBenchmarkArgs(argv, repoRoot) {
	const resolvedRepoRoot = resolve(repoRoot);
	const options = {
		help: false,
		runs: 10,
		warmups: 2,
		timeoutMs: 15_000,
		piPath: join(resolvedRepoRoot, "node_modules", ".bin", "pi"),
		packageRoot: resolvedRepoRoot,
		output: join(resolvedRepoRoot, "local", "benchmarks", "startup", filesystemTimestamp(new Date())),
		repoRoot: resolvedRepoRoot,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const option = argv[index];
		if (option === "--help") {
			options.help = true;
			continue;
		}
		if (option === "--runs") {
			options.runs = parseCount(readOptionValue(argv, index, option), option, 1);
			index += 1;
			continue;
		}
		if (option === "--warmups") {
			options.warmups = parseCount(readOptionValue(argv, index, option), option, 0);
			index += 1;
			continue;
		}
		if (option === "--timeout-ms") {
			options.timeoutMs = parseCount(readOptionValue(argv, index, option), option, 1);
			index += 1;
			continue;
		}
		if (option === "--pi") {
			options.piPath = resolve(readOptionValue(argv, index, option));
			index += 1;
			continue;
		}
		if (option === "--package-root") {
			options.packageRoot = resolve(readOptionValue(argv, index, option));
			index += 1;
			continue;
		}
		if (option === "--output") {
			options.output = resolve(readOptionValue(argv, index, option));
			index += 1;
			continue;
		}

		throw new BenchmarkUsageError(`Unknown option: ${option}`);
	}

	return options;
}
