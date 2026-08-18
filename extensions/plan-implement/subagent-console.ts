import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ConsoleCopy,
	type OpenSubagentConsoleOptions,
	type OpenSubagentConsoleResult,
	openSubagentConsole as openSharedConsole,
} from "../shared/subagent-console.ts";
import type { PlanImplementDashboardStore } from "./live-dashboard.ts";
import type { PlanImplementTranscriptStore } from "./transcript-store.ts";

const COPY: ConsoleCopy = {
	title: "Plan & implement",
	emptyMessage: "No plan/implement phases active",
	helpSuffix: " · ^⇧I abort",
};

export type { OpenSubagentConsoleResult };

type OpenConsoleOptions = Omit<OpenSubagentConsoleOptions, "copy">;

export function openSubagentConsole(
	ctx: ExtensionContext,
	dashboard: PlanImplementDashboardStore,
	transcripts: PlanImplementTranscriptStore,
	options: OpenConsoleOptions = {},
): OpenSubagentConsoleResult {
	return openSharedConsole(ctx, dashboard, transcripts, { ...options, copy: COPY });
}
