/** Opt-in live provider smoke for the Herdr and Rex hosted-agent backends.
 *
 * Usage:
 *   # Inside Rex (uses $REX_SESSION and $REX_BLOCK):
 *   node extensions/shared/hosted-agents/scripts/agent-host-e2e.ts --backend rex <provider/model[:thinking]>
 *
 *   # Against the isolated kstack-e2e Herdr session:
 *   KSTACK_E2E_WORKSPACE_ID=<w> KSTACK_E2E_PANE_ID=<p> \
 *     node extensions/shared/hosted-agents/scripts/agent-host-e2e.ts --backend herdr <provider/model[:thinking]>
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostDeps, openAgentHost } from "../agent-host.ts";
import { createNodeHerdrExec } from "../herdr/herdr-cli.ts";
import { type BackendKind, selectTerminalBackend } from "../terminal-backend.ts";

interface ParsedSmokeArgs {
	backend: BackendKind;
	model: string;
}

function parseArgs(argv: readonly string[]): ParsedSmokeArgs {
	let backend: BackendKind | undefined;
	let model: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--backend") {
			const value = argv[++index];
			if (value !== "herdr" && value !== "rex") {
				throw new Error(`--backend must be herdr or rex (got ${value ?? "(missing)"}).`);
			}
			backend = value;
			continue;
		}
		if (token?.startsWith("--")) throw new Error(`Unknown flag: ${token}`);
		if (model !== undefined) throw new Error(`Unexpected positional argument: ${token}`);
		model = token;
	}
	if (!backend) {
		if (process.env.KSTACK_E2E_WORKSPACE_ID && process.env.KSTACK_E2E_PANE_ID) {
			backend = "herdr";
		} else {
			const detected = selectTerminalBackend(process.env);
			if (!detected.ok) throw new Error(detected.error);
			backend = detected.kind;
		}
	}
	const resolvedModel = model ?? process.env.KSTACK_E2E_MODEL;
	if (!resolvedModel) throw new Error("Pass an explicit provider/model[:thinking] for this billable smoke test.");
	return { backend, model: resolvedModel };
}

const { backend, model } = parseArgs(process.argv.slice(2));
const cwd = mkdtempSync(join(tmpdir(), "kstack-host-smoke-"));

let deps: HostDeps;
if (backend === "herdr") {
	const workspace = process.env.KSTACK_E2E_WORKSPACE_ID;
	const pane = process.env.KSTACK_E2E_PANE_ID;
	if (!workspace || !pane) {
		throw new Error("Set KSTACK_E2E_WORKSPACE_ID and KSTACK_E2E_PANE_ID from the isolated kstack-e2e Herdr session.");
	}
	const execute = createNodeHerdrExec();
	const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
	delete cleanEnv.REX_SESSION;
	delete cleanEnv.REX_BLOCK;
	delete cleanEnv.REX_SERVER;
	deps = {
		exec: (args, options) => execute(["--session", "kstack-e2e", ...args], options),
		env: { ...cleanEnv, HERDR_ENV: "1", HERDR_WORKSPACE_ID: workspace, HERDR_PANE_ID: pane },
	};
} else {
	const session = process.env.KSTACK_E2E_REX_SESSION ?? process.env.REX_SESSION;
	const block = process.env.KSTACK_E2E_REX_BLOCK ?? process.env.REX_BLOCK;
	if (!session || !block) {
		throw new Error("Set REX_SESSION and REX_BLOCK (or KSTACK_E2E_REX_SESSION and KSTACK_E2E_REX_BLOCK) for Rex e2e.");
	}
	const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
	delete cleanEnv.HERDR_ENV;
	delete cleanEnv.HERDR_WORKSPACE_ID;
	delete cleanEnv.HERDR_PANE_ID;
	deps = {
		env: { ...cleanEnv, REX_SESSION: session, REX_BLOCK: block },
		allowShellCaller: true,
	};
}

const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
	const opened = await openAgentHost({ owner: "kstack-e2e", label: "agent-host", cwd, maxAgents: 1 }, deps);
	assert.ok(opened.ok, opened.ok ? "" : opened.error);
	try {
		const started = await opened.host.start({
			role: "echo",
			model,
			cwd,
			tools: ["read"],
			noSkills: true,
			noContextFiles: true,
			sessionName: "kstack-e2e-agent-host",
		});
		assert.ok(started.ok, started.ok ? "" : started.error);
		const instructions = join(opened.host.exchangeDir, "instructions.md");
		const output = join(opened.host.exchangeDir, "echo.md");
		writeFileSync(instructions, 'Return exactly "ECHO OK" after the host-required acknowledgement line.\n', {
			mode: 0o600,
		});
		const result = await started.agent.ask({
			promptFile: instructions,
			outputFile: output,
			timeoutMs: 120_000,
			signal: controller.signal,
		});
		assert.equal(result.status, "completed", JSON.stringify(result));
		if (result.status === "completed") assert.equal(result.output.trim(), "ECHO OK");
		process.stdout.write(`${JSON.stringify({ backend, ...result })}\n`);
	} finally {
		await opened.host.dispose({ closeTab: true });
	}
} finally {
	process.off("SIGINT", cancel);
	process.off("SIGTERM", cancel);
	rmSync(cwd, { recursive: true, force: true });
}
