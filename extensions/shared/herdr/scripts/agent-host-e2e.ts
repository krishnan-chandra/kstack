/** Opt-in provider smoke. Requires explicit workspace/pane IDs from the isolated kstack-e2e Herdr session. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentHost } from "../agent-host.ts";
import { createNodeHerdrExec } from "../herdr-cli.ts";

const workspace = process.env.KSTACK_E2E_WORKSPACE_ID;
const pane = process.env.KSTACK_E2E_PANE_ID;
if (!workspace || !pane)
	throw new Error("Set KSTACK_E2E_WORKSPACE_ID and KSTACK_E2E_PANE_ID from the isolated kstack-e2e Herdr session.");
const model = process.argv[2] ?? process.env.KSTACK_E2E_MODEL;
if (!model) throw new Error("Pass an explicit provider/model[:thinking] for this billable smoke test.");
const cwd = mkdtempSync(join(tmpdir(), "kstack-host-smoke-"));
const execute = createNodeHerdrExec();
const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
	const opened = await openAgentHost(
		{ owner: "kstack-e2e", label: "agent-host", cwd, maxAgents: 1 },
		{
			exec: (args, options) => execute(["--session", "kstack-e2e", ...args], options),
			env: { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: workspace, HERDR_PANE_ID: pane },
		},
	);
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
			timeoutMs: 120000,
			signal: controller.signal,
		});
		assert.equal(result.status, "completed", JSON.stringify(result));
		if (result.status === "completed") assert.equal(result.output.trim(), "ECHO OK");
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} finally {
		await opened.host.dispose({ closeTab: true });
	}
} finally {
	process.off("SIGINT", cancel);
	process.off("SIGTERM", cancel);
	rmSync(cwd, { recursive: true, force: true });
}
