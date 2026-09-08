/**
 * Route OpenRouter requests through `:floor` and record bounded, redacted
 * observations about rewrites and the service tier that served completions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatFloorReport, parseStatsRange } from "./floor-report.ts";
import { createDefaultFloorRuntime } from "./floor-runtime.ts";

export default function openrouterFloor(pi: ExtensionAPI): void {
	const runtime = createDefaultFloorRuntime();

	pi.on("before_provider_request", (event, ctx) => runtime.rewrite(event.payload, ctx.model, ctx.cwd));

	pi.on("message_end", async (event, ctx) => {
		await runtime.observeCompletion(
			event.message,
			() => ctx.modelRegistry.getProviderAuth("openrouter"),
			ctx.cwd,
			ctx.signal,
		);
	});

	pi.on("session_shutdown", async () => {
		await runtime.flush();
	});

	pi.registerCommand("openrouter-floor-stats", {
		description: "Show observed :floor rewrites and actual OpenRouter service tiers",
		getArgumentCompletions: (prefix) => {
			const ranges = ["process", "today", "7d", "30d"];
			const matches = ranges
				.filter((range) => range.startsWith(prefix.trim()))
				.map((range) => ({ value: range, label: range }));
			return matches.length === 0 ? null : matches;
		},
		handler: async (args, ctx) => {
			const range = parseStatsRange(args);
			if (!range.ok) {
				ctx.ui.notify(range.error, "error");
				return;
			}
			const report = await runtime.report({ range: range.value, scope: ctx.cwd });
			ctx.ui.notify(formatFloorReport(report), "info");
		},
	});
}
