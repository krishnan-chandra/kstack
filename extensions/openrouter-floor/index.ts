/**
 * Route OpenRouter requests through configurable variants and record bounded, redacted
 * observations about rewrites and the service tier that served completions.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatFloorReport, parseStatsRange } from "./floor-report.ts";
import type { CurrentModel } from "./floor-rewrite.ts";
import { createDefaultFloorRuntime } from "./floor-runtime.ts";
import {
	BUILT_IN_ROUTING,
	loadRoutingConfig,
	type RoutingConfig,
	type RoutingVariant,
	resolveVariant,
} from "./routing-policy.ts";
import {
	formatRouteStatus,
	formatRouteSummary,
	overrideFromBranch,
	parseRouteCommand,
	ROUTE_ENTRY_TYPE,
} from "./session-route.ts";

export default function openrouterFloor(pi: ExtensionAPI): void {
	let config: RoutingConfig = BUILT_IN_ROUTING;
	let sessionOverride: RoutingVariant | undefined;
	let warnedConfigPath: string | undefined;
	let configError: string | undefined;
	const resolve = (model: CurrentModel | undefined) => resolveVariant({ model, config, sessionOverride });
	const runtime = createDefaultFloorRuntime(resolve);
	function refreshStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus("openrouter-floor", formatRouteStatus(resolve(ctx.model)));
	}
	function rebuildOverride(ctx: ExtensionContext): void {
		sessionOverride = overrideFromBranch(ctx.sessionManager.getBranch());
		refreshStatus(ctx);
	}
	pi.on("session_start", (_event, ctx) => {
		const load = loadRoutingConfig();
		config = load.status === "loaded" ? load.config : BUILT_IN_ROUTING;
		configError = load.status === "invalid" ? load.error : undefined;
		if (load.status === "invalid" && ctx.hasUI && warnedConfigPath !== load.path) {
			ctx.ui.notify(`openrouter-floor: ${load.error} (${load.path}); using :floor for every model`, "warning");
			warnedConfigPath = load.path;
		}
		rebuildOverride(ctx);
	});
	pi.on("session_tree", (_event, ctx) => rebuildOverride(ctx));
	pi.on("model_select", (_event, ctx) => refreshStatus(ctx));

	pi.registerCommand("openrouter-route", {
		description: "Show or override session-wide OpenRouter routing",
		getArgumentCompletions: (prefix) => {
			const matches = ["floor", "nitro", "none", "reset"]
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value }));
			return matches.length === 0 ? null : matches;
		},
		handler: async (args, ctx) => {
			const parsed = parseRouteCommand(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const command = parsed.command;
			if (command.kind !== "show") {
				const override = command.kind === "reset" ? null : command.variant;
				pi.appendEntry(ROUTE_ENTRY_TYPE, { version: 1, override });
				sessionOverride = override ?? undefined;
				refreshStatus(ctx);
			}
			ctx.ui.notify(formatRouteSummary(resolve(ctx.model), sessionOverride, configError), "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => runtime.rewrite(event.payload, ctx.model, ctx.cwd));

	pi.on("message_end", async (event, ctx) => {
		await runtime.observeCompletion(
			event.message,
			() => ctx.modelRegistry.getProviderAuth("openrouter"),
			ctx.cwd,
			ctx.model,
		);
	});

	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});

	pi.registerCommand("openrouter-floor-stats", {
		description: "Show variant routing rewrites and actual OpenRouter service tiers",
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
