#!/usr/bin/env node
/** Skill-facing CLI over the hosted-agent substrate.
 *
 * This file only parses arguments and dispatches. Domain behavior stays in
 * the TypeScript modules beside it, which Node loads through type stripping.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { resolveConfiguredModel } from "../resolve-model.ts";
import { isObject } from "../validation.ts";
import { attachHostedAgent } from "./agent-host.ts";
import { parseFanoutSpec, runFanout } from "./fanout.ts";
import { createNodeHerdrExec } from "./herdr-cli.ts";

const USAGE = `usage: cli.mjs <subcommand> [options]

subcommands:
  resolve-model --section NAME --key NAME [--model REF]
  fanout --spec FILE --out FILE [--label TEXT] [--max-concurrency N]
  ask --agent NAME --prompt FILE --out FILE   (FILE paths must be absolute)`;

const SUBCOMMANDS = new Set(["resolve-model", "fanout", "ask"]);

async function withCancellation(run) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		return await run(controller.signal);
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}

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

export function parseFanoutArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag !== "--spec" && flag !== "--out" && flag !== "--label" && flag !== "--max-concurrency") {
			return { ok: false, error: `unknown fanout option: ${flag ?? "(missing)"}` };
		}
		if (value === undefined || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` };
		if (values[flag] !== undefined) return { ok: false, error: `${flag} may be provided only once` };
		values[flag] = value;
	}
	if (values["--spec"] === undefined) return { ok: false, error: "--spec is required" };
	if (values["--out"] === undefined) return { ok: false, error: "--out is required" };
	let maxConcurrency;
	if (values["--max-concurrency"] !== undefined) {
		const parsed = Number(values["--max-concurrency"]);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
			return { ok: false, error: "--max-concurrency must be an integer from 1 to 8" };
		}
		maxConcurrency = parsed;
	}
	return {
		ok: true,
		spec: values["--spec"],
		out: values["--out"],
		label: values["--label"],
		maxConcurrency,
	};
}

export function parseAskArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag !== "--agent" && flag !== "--prompt" && flag !== "--out") {
			return { ok: false, error: `unknown ask option: ${flag ?? "(missing)"}` };
		}
		if (value === undefined || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` };
		if (values[flag] !== undefined) return { ok: false, error: `${flag} may be provided only once` };
		values[flag] = value;
	}
	for (const flag of ["--agent", "--prompt", "--out"]) {
		if (values[flag] === undefined) return { ok: false, error: `${flag} is required` };
	}
	// The hosted agent resolves the pointer path from its own cwd, so relative paths would silently miss.
	for (const flag of ["--prompt", "--out"]) {
		if (!isAbsolute(values[flag])) return { ok: false, error: `${flag} must be an absolute path` };
	}
	return { ok: true, agent: values["--agent"], prompt: values["--prompt"], out: values["--out"] };
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
	if (parsed.subcommand === "ask") {
		const options = parseAskArgs(argv.slice(1));
		if (!options.ok) {
			process.stderr.write(`${options.error}\n\n${USAGE}\n`);
			return 2;
		}
		return withCancellation(async (signal) => {
			const attached = await attachHostedAgent(options.agent, { exec: createNodeHerdrExec() });
			if (!attached.ok) {
				process.stderr.write(`${attached.error}\n`);
				return 1;
			}
			try {
				const result = await attached.agent.ask({
					promptFile: options.prompt,
					outputFile: options.out,
					timeoutMs: 900000,
					signal,
				});
				process.stdout.write(
					`${JSON.stringify({ status: result.status, outputFile: options.out, paneId: attached.agent.paneId, usage: result.usage, ...(result.status === "failed" ? { error: result.error } : undefined) })}\n`,
				);
				return result.status === "completed" ? 0 : 1;
			} finally {
				await attached.agent.dispose();
			}
		});
	}
	if (parsed.subcommand === "fanout") {
		const options = parseFanoutArgs(argv.slice(1));
		if (!options.ok) {
			process.stderr.write(`${options.error}\n\n${USAGE}\n`);
			return 2;
		}
		let rawSpec;
		try {
			const content = readFileSync(options.spec, "utf8");
			rawSpec = JSON.parse(content);
		} catch (error) {
			process.stderr.write(
				`Could not read spec file ${options.spec}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			return 1;
		}
		if (isObject(rawSpec)) {
			if (options.label !== undefined) rawSpec.label = options.label;
			if (options.maxConcurrency !== undefined) rawSpec.maxConcurrency = options.maxConcurrency;
		}
		const specParsed = parseFanoutSpec(rawSpec);
		if (!specParsed.ok) {
			process.stderr.write(`${specParsed.error}\n`);
			return 1;
		}
		const outcome = await withCancellation((signal) =>
			runFanout(specParsed.spec, { exec: createNodeHerdrExec() }, signal),
		);
		if (!outcome.ok) {
			process.stderr.write(`${outcome.error}\n`);
			return 1;
		}
		try {
			mkdirSync(dirname(options.out), { recursive: true });
			writeFileSync(options.out, JSON.stringify(outcome.outcome, null, 2), "utf8");
		} catch (error) {
			process.stderr.write(
				`Could not write output file ${options.out}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			return 1;
		}
		const allCompleted = outcome.outcome.results.every((result) => result.status === "completed");
		return allCompleted ? 0 : 1;
	}
	process.stderr.write(`unknown subcommand: ${parsed.subcommand}\n\n${USAGE}\n`);
	return 2;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
