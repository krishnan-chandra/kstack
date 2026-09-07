#!/usr/bin/env node
/** Skill-facing CLI over the hosted-agent substrate.
 *
 * This file only parses arguments and dispatches. Domain behavior stays in
 * the TypeScript modules beside it, which Node loads through type stripping.
 */

import { resolveConfiguredModel } from "./resolve-model.ts";

const USAGE = `usage: cli.mjs <subcommand> [options]

subcommands:
  resolve-model --section NAME --key NAME [--model REF]
  fanout --spec FILE --out FILE [--label TEXT] [--max-concurrency N]`;

const SUBCOMMANDS = new Set(["resolve-model", "fanout"]);

export function parseSubcommand(argv) {
	const [subcommand] = argv;
	if (subcommand === undefined) return { ok: false, error: "missing subcommand" };
	if (!SUBCOMMANDS.has(subcommand)) return { ok: false, error: `unknown subcommand: ${subcommand}` };
	return { ok: true, subcommand };
}

export function parseResolveModelArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag !== "--section" && flag !== "--key" && flag !== "--model") {
			return { ok: false, error: `unknown resolve-model option: ${flag ?? "(missing)"}` };
		}
		if (value === undefined || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` };
		if (values[flag] !== undefined) return { ok: false, error: `${flag} may be provided only once` };
		values[flag] = value;
	}
	if (values["--section"] === undefined) return { ok: false, error: "--section is required" };
	if (values["--key"] === undefined) return { ok: false, error: "--key is required" };
	return {
		ok: true,
		section: values["--section"],
		key: values["--key"],
		model: values["--model"],
	};
}

async function main(argv) {
	const parsed = parseSubcommand(argv);
	if (!parsed.ok) {
		process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
		return 2;
	}
	if (parsed.subcommand === "resolve-model") {
		const options = parseResolveModelArgs(argv.slice(1));
		if (!options.ok) {
			process.stderr.write(`${options.error}\n\n${USAGE}\n`);
			return 2;
		}
		const result = resolveConfiguredModel({
			argument: options.model,
			section: options.section,
			key: options.key,
			env: process.env,
		});
		if (!result.ok) {
			process.stderr.write(`${result.error}\n`);
			return 1;
		}
		process.stdout.write(`${result.ref}\n`);
		return 0;
	}
	process.stderr.write(`fanout is not implemented yet.\n${USAGE}\n`);
	return 2;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
