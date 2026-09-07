/** End-to-end check for the hosted-agent substrate against a live Herdr.
 *
 * Not part of `npm test`. Run inside Herdr (`HERDR_ENV=1`) with the Pi
 * integration installed (`herdr integration install pi`):
 *
 *   node --experimental-strip-types extensions/shared/herdr/scripts/agent-host-e2e.ts
 *
 * The script starts one hosted Pi with `--no-tools`, asks it to echo a file
 * through the file-based protocol, prints the tab id for cleanup, and
 * disposes the host. It names the Pi session `kstack-e2e-agent-host` so it is
 * easy to find under `/resume` or archive afterwards.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAgentHost } from "../agent-host.ts";
import { createNodeHerdrExec } from "../herdr-cli.ts";

const SESSION_NAME = "kstack-e2e-agent-host";

const preflightEnv = process.env;
const opened = await openAgentHost(
	{ owner: "kstack-e2e", label: "agent-host", cwd: process.cwd(), maxAgents: 1 },
	{ exec: createNodeHerdrExec(), env: preflightEnv },
);
if (!opened.ok) {
	console.error(`preflight failed: ${opened.error}`);
	process.exit(1);
}
const host = opened.host;
console.log(`tab: ${host.tabId}`);
console.log(`exchange dir: ${host.exchangeDir}`);
try {
	const started = await host.start({
		role: "echo",
		model: process.argv[2] ?? process.env.KSTACK_E2E_MODEL ?? "anthropic/claude-haiku-4",
		cwd: process.cwd(),
		tools: [],
		noSkills: true,
		noContextFiles: true,
		sessionName: SESSION_NAME,
	});
	if (!started.ok) {
		console.error(`start failed: ${started.error}`);
		process.exit(1);
	}
	const agent = started.agent;
	console.log(`agent: ${agent.name} in pane ${agent.paneId}`);
	const instructions = join(host.exchangeDir, "instructions.md");
	const output = join(host.exchangeDir, "echo.md");
	writeFileSync(instructions, 'Write exactly "ECHO OK" (no quotes) to the output file.\n', { mode: 0o600 });
	const result = await agent.ask({ promptFile: instructions, outputFile: output, timeoutMs: 120_000 });
	console.log(JSON.stringify(result, null, 2));
} finally {
	// Panes are retained by default; the user closes the tab or keeps talking.
	await host.dispose();
}
