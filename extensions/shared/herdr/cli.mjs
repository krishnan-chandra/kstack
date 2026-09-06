#!/usr/bin/env node
/** Skill-facing CLI over the hosted-agent substrate.
 *
 * Skills invoke this file by absolute path resolved from the kstack package
 * root (the same way they locate `kstack.ts`). It is a thin argument parser
 * and dispatcher: the domain behavior lives in the TypeScript modules next to
 * it, which Node loads through type stripping. Subcommands:
 *
 *   resolve-model  Resolve a model reference for a kstack.json section (slice 2)
 *   fanout         Run N hosted agents in one Herdr tab (slice 4)
 *
 * Unknown subcommands print usage and exit 2.
 */

const USAGE = `usage: cli.mjs <subcommand> [options]

subcommands:
  resolve-model  Resolve a model reference for a kstack.json section.
  fanout         Run N hosted agents in one Herdr tab.`;

const SUBCOMMANDS = new Set(["resolve-model", "fanout"]);

export function parseSubcommand(argv) {
	const [subcommand] = argv;
	if (subcommand === undefined) return { ok: false, error: "missing subcommand" };
	if (!SUBCOMMANDS.has(subcommand)) return { ok: false, error: `unknown subcommand: ${subcommand}` };
	return { ok: true, subcommand };
}

async function main(argv) {
	const parsed = parseSubcommand(argv);
	if (!parsed.ok) {
		process.stdout.write(`${USAGE}\n\nerror: ${parsed.error}\n`);
		return 2;
	}
	// resolve-model and fanout bodies arrive in slices 2 and 4; the file exists
	// now so skills can reference a stable path.
	process.stdout.write(`${parsed.subcommand} is not implemented yet.\n${USAGE}\n`);
	return 2;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
