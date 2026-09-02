#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { generateContractReport } from "./contract.mjs";

async function main() {
	const ompCheckoutValue = process.env.OMP_CHECKOUT;
	const ompRuntimeValue = process.env.OMP_RUNTIME_ROOT;
	if (!ompCheckoutValue || !ompRuntimeValue) {
		throw new Error("Set OMP_CHECKOUT and OMP_RUNTIME_ROOT to absolute paths");
	}
	const ompCheckout = await realpath(ompCheckoutValue);
	const ompRuntimeRoot = await realpath(ompRuntimeValue);
	const outputDir = resolve("local/compatibility");
	const report = await generateContractReport({ kstackRoot: process.cwd(), ompCheckout, ompRuntimeRoot, outputDir });
	console.log(`Wrote OMP contract inventory to ${outputDir}`);
	console.log(`${report.imports.length} host imports; ${report.cliAssumptions.length} CLI/path assumptions`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
