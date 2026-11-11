/** Herdr implementation of the {@link TerminalBackend} port.
 *
 * Wraps {@link createHerdrCli} one-to-one so existing Herdr behavior, ratios,
 * error semantics, and CLI call sequences remain unchanged.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../kstack-config.ts";
import type { AgentSnapshot, BackendExec, ExecOptions, Outcome, TerminalBackend } from "../terminal-backend.ts";
import { createHerdrCli, createNodeHerdrExec, type HerdrAgentInfo } from "./herdr-cli.ts";

const HERDR_INTEGRATION_FILE = "extensions/herdr-agent-state.ts";
const CONTROL_TIMEOUT_MS = 15_000;
const CONTROL: ExecOptions = { timeoutMs: CONTROL_TIMEOUT_MS };

export function herdrIntegrationFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), HERDR_INTEGRATION_FILE);
}

function toSnapshot(info: HerdrAgentInfo): AgentSnapshot {
	return {
		name: info.name,
		paneId: info.paneId,
		tabId: info.tabId,
		status: info.agentStatus,
		...(info.cwd ? { cwd: info.cwd } : undefined),
		...(info.sessionFile ? { sessionFile: info.sessionFile } : undefined),
	};
}

function snapshotOf(outcome: Outcome<HerdrAgentInfo>): Outcome<AgentSnapshot> {
	return outcome.ok ? { ok: true, value: toSnapshot(outcome.value) } : outcome;
}

/** A long-running Herdr wait gets the CLI's own timeout plus a grace period for process overhead. */
function waitOptions(timeoutMs: number, graceMs: number, signal: AbortSignal | undefined): ExecOptions {
	return { timeoutMs: timeoutMs + graceMs, ...(signal ? { signal } : undefined) };
}

export function createHerdrBackend(options: { exec?: BackendExec; env?: NodeJS.ProcessEnv } = {}): TerminalBackend {
	const env = options.env ?? process.env;
	const cli = createHerdrCli(options.exec ?? createNodeHerdrExec());

	return {
		kind: "herdr",
		extraPiArgs(): string[] {
			return ["-e", herdrIntegrationFilePath(env)];
		},
		async preflight() {
			if (env.HERDR_ENV !== "1") {
				return { ok: false, error: "Herdr is required (HERDR_ENV is not 1). Start the session inside Herdr." };
			}
			const workspaceId = env.HERDR_WORKSPACE_ID ?? "";
			const callerPane = env.HERDR_PANE_ID ?? "";
			if (!workspaceId || !callerPane) {
				return { ok: false, error: "Herdr environment variables HERDR_WORKSPACE_ID and HERDR_PANE_ID are missing." };
			}
			const integrationPath = herdrIntegrationFilePath(env);
			if (!existsSync(integrationPath)) {
				return {
					ok: false,
					error: `The Herdr Pi integration is missing at ${integrationPath}. Run \`herdr integration install pi\`.`,
				};
			}
			const status = await cli.runText(["status", "server"], { timeoutMs: 5_000 });
			if (!status.ok) return { ok: false, error: `Herdr is not reachable: ${status.message}` };
			// HERDR_TAB_ID goes stale after `herdr pane move`; resolve the caller's live tab instead.
			const layout = await cli.paneLayout({ paneId: callerPane }, CONTROL);
			if (!layout.ok) return { ok: false, error: `Could not read the caller's Herdr tab: ${layout.message}` };
			if (!layout.value.tabId) return { ok: false, error: "Herdr did not report the caller's tab." };
			return { ok: true, caller: { paneId: callerPane, tabId: layout.value.tabId } };
		},
		createTab: (tabOptions) =>
			cli.tabCreate(
				{ workspaceId: env.HERDR_WORKSPACE_ID ?? "", cwd: tabOptions.cwd, label: tabOptions.label },
				CONTROL,
			),
		async splitPane(splitOptions) {
			const split = await cli.paneSplit(
				{
					paneId: splitOptions.paneId,
					direction: splitOptions.direction,
					ratio: splitOptions.keepFraction,
					...(splitOptions.cwd ? { cwd: splitOptions.cwd } : undefined),
				},
				CONTROL,
			);
			if (!split.ok) return split;
			return { ok: true, value: { paneId: split.value.paneId, tabId: split.value.tabId } };
		},
		paneGeometry: (paneId) => cli.paneLayout({ paneId }, CONTROL),
		closePane: (paneId) => cli.paneClose({ paneId }, CONTROL),
		closeTab: (tabId) => cli.tabClose({ tabId }, CONTROL),
		async launchAgent(launchOptions) {
			return snapshotOf(
				await cli.agentStart(
					{
						name: launchOptions.name,
						paneId: launchOptions.paneId,
						timeoutMs: launchOptions.timeoutMs,
						args: launchOptions.piArgs,
					},
					waitOptions(launchOptions.timeoutMs, 30_000, launchOptions.signal),
				),
			);
		},
		// Herdr resolves agents by its global name registry; the recorded pane is checked by callers.
		getAgent: async (ref) => snapshotOf(await cli.agentGet({ name: ref.name }, CONTROL)),
		async findAgentsNamed(name) {
			const found = await cli.agentGet({ name }, CONTROL);
			if (found.ok) return { ok: true, value: [toSnapshot(found.value)] };
			if (found.code === "not_found") return { ok: true, value: [] };
			return found;
		},
		async prompt(ref, text, promptOptions) {
			return snapshotOf(
				await cli.agentPrompt(
					{ name: ref.name, text, timeoutMs: promptOptions.timeoutMs },
					waitOptions(promptOptions.timeoutMs, 30_000, promptOptions.signal),
				),
			);
		},
		async waitSettled(ref, settleOptions) {
			const graceMs = settleOptions.timeoutMs <= 5_000 ? 5_000 : 30_000;
			return snapshotOf(
				await cli.agentWait(
					{ name: ref.name, timeoutMs: settleOptions.timeoutMs, until: ["idle", "done"] },
					waitOptions(settleOptions.timeoutMs, graceMs, settleOptions.signal),
				),
			);
		},
		sendKeys: (ref, keys) => cli.agentSendKeys({ name: ref.name, keys }, CONTROL),
	};
}
