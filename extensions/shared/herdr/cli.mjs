#!/usr/bin/env node
/** Skill-facing CLI over the hosted-agent substrate.
 *
 * This file only parses arguments and dispatches. Domain behavior stays in
 * the TypeScript modules beside it, which Node loads through type stripping.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { resolveCouncilRoster } from "../council/roster.ts";
import { overrideCouncilFinding, runCouncilRound } from "../council/round.ts";
import { readManifest } from "../council/store.ts";
import { resolveConfiguredModel } from "../resolve-model.ts";
import { isObject } from "../validation.ts";
import { attachHostedAgent } from "./agent-host.ts";
import { closeCouncilSeats, councilRecordInfo, createSeatAsker, openCouncilSeats } from "./council-host.ts";
import { parseFanoutSpec, runFanout } from "./fanout.ts";
import { createNodeHerdrExec } from "./herdr-cli.ts";

const USAGE = `usage: cli.mjs <subcommand> [options]

subcommands:
  resolve-model --section NAME --key NAME [--model REF]
  fanout --spec FILE --out FILE [--label TEXT] [--max-concurrency N]
  ask --agent NAME --prompt FILE --out FILE   (FILE paths must be absolute)
  council open --dir DIR --slug SLUG --planner-model REF [--seats REF,REF,...]
  council round --dir DIR --plan FILE [--task FILE] [--response FILE] [--verify]
  council override --dir DIR --finding ID --reason TEXT [--plan FILE]
  council close --dir DIR
    (council DIR and FILE paths must be absolute; results print as JSON)`;

const SUBCOMMANDS = new Set(["resolve-model", "fanout", "ask", "council"]);

const COUNCIL_FLAGS = {
	open: {
		values: ["--dir", "--slug", "--planner-model", "--seats"],
		booleans: [],
		required: ["--dir", "--slug", "--planner-model"],
	},
	round: { values: ["--dir", "--plan", "--task", "--response"], booleans: ["--verify"], required: ["--dir", "--plan"] },
	override: {
		values: ["--dir", "--finding", "--reason", "--plan"],
		booleans: [],
		required: ["--dir", "--finding", "--reason"],
	},
	close: { values: ["--dir"], booleans: [], required: ["--dir"] },
};
const COUNCIL_PATH_FLAGS = ["--dir", "--plan", "--task", "--response"];

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

export function parseCouncilArgs(argv) {
	const [action, ...rest] = argv;
	const spec = action === undefined ? undefined : COUNCIL_FLAGS[action];
	if (!spec) return { ok: false, error: `unknown council action: ${action ?? "(missing)"}` };
	const values = {};
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		if (spec.booleans.includes(flag)) {
			if (values[flag] !== undefined) return { ok: false, error: `${flag} may be provided only once` };
			values[flag] = true;
			continue;
		}
		if (!spec.values.includes(flag)) return { ok: false, error: `unknown council ${action} option: ${flag}` };
		const value = rest[index + 1];
		if (value === undefined || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` };
		if (values[flag] !== undefined) return { ok: false, error: `${flag} may be provided only once` };
		values[flag] = value;
		index++;
	}
	for (const flag of spec.required) {
		if (values[flag] === undefined) return { ok: false, error: `${flag} is required` };
	}
	for (const flag of COUNCIL_PATH_FLAGS) {
		if (values[flag] !== undefined && !isAbsolute(values[flag])) {
			return { ok: false, error: `${flag} must be an absolute path` };
		}
	}
	let seats;
	if (values["--seats"] !== undefined) {
		seats = values["--seats"]
			.split(",")
			.map((seat) => seat.trim())
			.filter(Boolean);
		if (seats.length === 0) return { ok: false, error: "--seats needs at least one model or alias" };
	}
	return {
		ok: true,
		action,
		dir: values["--dir"],
		slug: values["--slug"],
		plannerModel: values["--planner-model"],
		seats,
		plan: values["--plan"],
		task: values["--task"],
		response: values["--response"],
		verify: values["--verify"] === true,
		finding: values["--finding"],
		reason: values["--reason"],
	};
}

function printJson(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runCouncil(options) {
	const deps = { exec: createNodeHerdrExec() };
	if (options.action === "open") {
		const roster = resolveCouncilRoster({
			env: process.env,
			plannerModel: options.plannerModel,
			whenMissing: "error",
			...(options.seats ? { seatsOverride: options.seats } : undefined),
		});
		if (!roster.ok || !roster.roster) {
			printJson({ status: "failed", error: roster.ok ? "No council roster resolved." : roster.error });
			return 1;
		}
		const resolved = roster.roster;
		const opened = await withCancellation((signal) =>
			openCouncilSeats(
				{
					dir: options.dir,
					slug: options.slug,
					cwd: process.cwd(),
					roster: resolved,
					plannerModel: options.plannerModel,
					signal,
				},
				deps,
			),
		);
		const common = { dir: options.dir, excluded: resolved.excluded, maxRounds: resolved.maxRounds };
		if (!opened.ok) {
			printJson({ status: "failed", ...common, error: opened.error, ...(opened.seats ? { seats: opened.seats } : undefined) });
			return 1;
		}
		printJson({ status: opened.status, ...common, tabId: opened.tabId, seats: opened.seats });
		return opened.status === "ready" ? 0 : 1;
	}
	if (options.action === "round") {
		return withCancellation(async (signal) => {
			const asker = await createSeatAsker(options.dir, deps);
			if (!asker.ok) {
				printJson({ status: "failed", error: asker.error });
				return 1;
			}
			const result = await runCouncilRound(
				{
					dir: options.dir,
					planFile: options.plan,
					...(options.task ? { taskFile: options.task } : undefined),
					...(options.response ? { responseFile: options.response } : undefined),
					verify: options.verify,
					timeoutMs: asker.manifest.timeoutMinutes * 60_000,
					info: councilRecordInfo(asker.manifest),
					signal,
				},
				{ askSeat: asker.askSeat },
			);
			const { exitCode, ...json } = result;
			printJson(json);
			return exitCode;
		});
	}
	if (options.action === "override") {
		let manifest;
		try {
			manifest = readManifest(options.dir);
		} catch (error) {
			printJson({
				status: "failed",
				error: `Could not read the council manifest: ${error instanceof Error ? error.message : String(error)}`,
			});
			return 1;
		}
		const result = await overrideCouncilFinding({
			dir: options.dir,
			id: options.finding,
			reason: options.reason,
			...(options.plan ? { planFile: options.plan } : undefined),
			info: councilRecordInfo(manifest),
		});
		const { exitCode, ...json } = result;
		printJson(json);
		return exitCode;
	}
	const closed = await closeCouncilSeats(options.dir, deps);
	printJson(
		closed.ok
			? { status: "closed", closed: closed.closed, skipped: closed.skipped }
			: { status: "failed", error: closed.error },
	);
	return closed.ok ? 0 : 1;
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
	if (parsed.subcommand === "council") {
		const options = parseCouncilArgs(argv.slice(1));
		if (!options.ok) {
			process.stderr.write(`${options.error}\n\n${USAGE}\n`);
			return 2;
		}
		return runCouncil(options);
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
