/**
 * Kstack Router — the package's front door.
 *
 * /kstack [--route <id>] [--single|--stack] [--] <task>
 *
 * Routes tasks through a classifier or explicit --route selection, then
 * dispatches to the appropriate workflow (plan-implement, panel-review,
 * active session with restricted tools, etc.). The classifier is advisory;
 * the user always confirms or overrides.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseArgs } from "./args.ts";
import { getRouteLabel, getRouteDescription, validateCatalog, checkDependencies, getRouteMetadata } from "./catalog.ts";
import { parseClassifierOutput, formatRecommendation, buildRouteAlternatives } from "./classification.ts";
import { runClassifier } from "./classifier-runner.ts";
import { loadConfig, resolveClassifierModel } from "./config.ts";
import { isChildModelAvailable } from "../../plan-implement/model-availability.ts";
import { dispatchRoute, getRestrictedTools, getPlaybookForRoute } from "./dispatch.ts";
import { RouterLifecycle, type DispatchToken } from "./lifecycle.ts";
import {
	ALL_ROUTES,
	ALLOWED_READ_TOOLS,
	type RouteId,
	type DeliveryRecommendation,
} from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "playbooks");
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");

interface RouteCardDetails {
	schemaVersion: 1;
	route: RouteId;
	routeLabel: string;
	delivery: DeliveryRecommendation;
	modelSource?: string;
	confidence?: string;
	overrode: boolean;
	dispatchStatus?: string;
}

export default function (pi: ExtensionAPI): void {
	const lifecycle = new RouterLifecycle();

	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());

	// Store a pending dispatch token so before_agent_start can access it.
	let pendingDispatch: { token: DispatchToken; route: RouteId; task: string } | undefined;

	// --- Message renderer for route cards ---
	pi.registerMessageRenderer("kstack-route", (message, { expanded, outputPad }, theme) => {
		const details = message.details as RouteCardDetails | undefined;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));

		if (!expanded) {
			const header =
				theme.fg("accent", "◆ Kstack Router") +
				theme.fg("muted", ` — ${details?.routeLabel ?? "unknown route"}`) +
				(details?.overrode ? theme.fg("warning", " — overridden") : "") +
				(details?.dispatchStatus === "failed"
					? theme.fg("error", " — dispatch failed")
					: details?.dispatchStatus === "dispatched"
						? theme.fg("success", " — dispatched")
						: "") +
				theme.fg("dim", " (Ctrl+O to expand)");
			box.addChild(new Text(header, 0, 0));
			return box;
		}

		const lines: string[] = [
			theme.fg("accent", "◆ Kstack Router"),
			"",
			`Route: ${details?.routeLabel ?? "unknown"} (${details?.route ?? "?"})`,
			...(details?.delivery ? [`Delivery: ${details.delivery === "stack" ? "stacked PRs" : "single PR"}`] : []),
			...(details?.modelSource ? [`Classifier: ${details.modelSource}`] : []),
			...(details?.confidence ? [`Confidence: ${details.confidence}`] : []),
			...(details?.overrode ? [theme.fg("warning", "User overrode recommendation")] : []),
			...(details?.dispatchStatus ? [`Status: ${details.dispatchStatus}`] : []),
			"",
			message.content,
		];
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	// --- Shortcut: abort classifier ---
	pi.registerShortcut("ctrl+shift+k", {
		description: "Abort the running kstack router classifier",
		handler: async (ctx) => {
			if (lifecycle.abortClassifier()) {
				ctx.ui.setStatus("kstack-router", "kstack-router: aborting classifier…");
			} else {
				ctx.ui.notify("No classifier is running.", "info");
			}
		},
	});

	// --- before_agent_start: inject playbook for active-session routes ---
	pi.on("before_agent_start", (correlation, ctx) => {
		if (!pendingDispatch) return;
		const { token, route, task } = pendingDispatch;

		if (!lifecycle.isCurrentDispatch(token)) {
			pendingDispatch = undefined;
			return;
		}

		// Only active-session routes use before_agent_start.
		const activeSessionRoutes: RouteId[] = ["investigate", "arena", "swarm", "skill-authoring", "session-pickup"];
		if (!activeSessionRoutes.includes(route)) return;

		// Restrict tools to read-only.
		const currentTools = pi.getTools()?.map((t) => t.name) ?? [];
		const restricted = getRestrictedTools(currentTools);
		correlation.restrictTools(restricted.length > 0 ? restricted : []);

		// Read and attach principles and playbook.
		const playbookFile = getPlaybookForRoute(route);
		const parts: string[] = [readPlaybook("principles.md")];

		if (playbookFile) {
			try {
				parts.push(readPlaybook(playbookFile));
			} catch {
				// Playbook absent is not fatal.
			}
		}

		parts.push(`# User task\n\n${task}`);
		correlation.addSystemPrompt(parts.join("\n\n---\n\n"));

		// Clear the pending dispatch so ordinary turns don't get stale route data.
		pendingDispatch = undefined;
	});

	// --- agent_settled: restore tool snapshot ---
	pi.on("agent_settled", () => {
		const snapshot = lifecycle.getToolSnapshot();
		if (snapshot) {
			// Tools are restored by the lifecycle when the dispatch ends.
			// We don't restore here to avoid interfering with normal tool state.
		}
	});

	// --- Command handler ---
	pi.registerCommand("kstack", {
		description:
			"Route a task through the Kstack Router: /kstack [--route <id>] [--single|--stack] [--] <task>. " +
			"Prompts for classification when no --route is given.",
		handler: async (args, ctx) => {
			const notify = ctx.ui.notify.bind(ctx.ui);
			if (!ctx.hasUI) {
				notify("/kstack requires interactive (TUI/RPC) mode.", "error");
				return;
			}

			const sessionToken = lifecycle.sessionToken();
			if (!sessionToken) return;
			await ctx.waitForIdle();
			if (!lifecycle.isSessionCurrent(sessionToken)) return;

			// Validate the catalog (internal consistency check).
			const catalogErrors = validateCatalog();
			if (catalogErrors.length > 0) {
				notify(`Router catalog validation failed:\n${catalogErrors.join("\n")}`, "error");
				return;
			}

			// Parse arguments.
			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) {
				notify(parsed.error, "warning");
				return;
			}

			// Collect task via editor if empty.
			let task = parsed.args.task;
			if (!task.trim()) {
				const edited = await ctx.ui.editor("Kstack Router task:", "");
				if (edited === undefined) return; // User cancelled.
				if (!lifecycle.isSessionCurrent(sessionToken)) return;
				task = edited.trim();
				if (!task) {
					notify("/kstack requires a non-empty task.", "warning");
					return;
				}
			}

			// Resolve route.
			let route: RouteId | undefined = parsed.args.route;
			let delivery: DeliveryRecommendation = parsed.args.delivery;
			let overrode = false;
			let modelSource = "explicit --route";

			if (!route) {
				// Run the classifier.
				const configLoad = loadConfig();
				if (configLoad.status === "invalid") {
					notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
					return;
				}

				const classifierResolution = resolveClassifierModel(
					configLoad.status === "loaded" ? configLoad.config : null,
					{
						available: (provider, modelId) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
						activeModelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					},
				);

				if ("error" in classifierResolution) {
					notify(classifierResolution.error, "warning");
					// Fall through to manual selection.
				} else {
					modelSource = classifierResolution.source === "config"
						? "configured"
						: classifierResolution.source === "default"
							? "built-in default"
							: "active model (not ideal)";

					if (classifierResolution.warning) {
						notify(classifierResolution.warning, "warning");
					}

					notify(`Running classifier (${modelSource})…`, "info");

					const classifierController = lifecycle.beginClassifier(sessionToken);
					if (!classifierController) {
						notify("A classifier or dispatch is already running.", "warning");
						return;
					}

					ctx.ui.setStatus("kstack-router", "kstack-router: classifying…");
					const classifierResult = await runClassifier({
						model: classifierResolution.modelId,
						task,
						signal: classifierController.signal,
						timeoutSeconds: configLoad.status === "loaded" && configLoad.config.timeoutSeconds
							? configLoad.config.timeoutSeconds
							: undefined,
					});
					lifecycle.endClassifier(sessionToken);
					ctx.ui.setStatus("kstack-router", undefined);

					if (classifierResult.status === "aborted") {
						notify("Classification aborted.", "info");
						return;
					}

					if (classifierResult.status === "completed") {
						const recommendation = {
							route: classifierResult.envelope.route,
							confidence: classifierResult.envelope.confidence,
							rationale: classifierResult.envelope.rationale,
							delivery: classifierResult.envelope.delivery,
						};

						// Show the recommendation.
						notify(formatRecommendation(recommendation, modelSource), "info");

						// User may override.
						const alternatives = buildRouteAlternatives(recommendation.route);
						const choiceLabels = [
							`✓ Accept: ${getRouteLabel(recommendation.route)}`,
							...alternatives.map((a) => `${a.label}: ${a.description.slice(0, 60)}…`),
							"Cancel",
						];

						const choice = await ctx.ui.select(
							"Accept route or choose another?",
							choiceLabels,
							{},
						);
						if (!lifecycle.isSessionCurrent(sessionToken)) return;
						if (!choice || choice === "Cancel") {
							notify("Routing cancelled.", "info");
							return;
						}

						if (choice === choiceLabels[0]) {
							route = recommendation.route;
							if (recommendation.delivery && !delivery) {
								delivery = recommendation.delivery;
							}
						} else {
							const idx = choiceLabels.indexOf(choice) - 1;
							if (idx >= 0 && idx < alternatives.length) {
								route = alternatives[idx].id;
								overrode = true;
							} else {
								notify("Invalid selection.", "warning");
								return;
							}
						}
					} else {
						// Classifier failed; offer manual selection.
						notify(`Classifier did not produce a valid route (${classifierResult.status === "failed" ? classifierResult.error : "unknown error"}). Please pick a route manually.`, "warning");
						const alternatives = buildRouteAlternatives();
						const choiceLabels = [
							...alternatives.map((a) => `${a.label}: ${a.description.slice(0, 60)}…`),
							"Cancel",
						];
						const choice = await ctx.ui.select(
							"Select a route:",
							choiceLabels,
							{},
						);
						if (!lifecycle.isSessionCurrent(sessionToken)) return;
						if (!choice || choice === "Cancel") return;
						const idx = choiceLabels.indexOf(choice);
						if (idx >= 0 && idx < alternatives.length) {
							route = alternatives[idx].id;
							overrode = true;
						}
					}
				}

				// If no classifier model and no manual selection resolved, fall back to manual.
				if (!route) {
					const alternatives = buildRouteAlternatives();
					const choiceLabels = [
						...alternatives.map((a) => `${a.label}: ${a.description.slice(0, 60)}…`),
						"Cancel",
					];
					const choice = await ctx.ui.select(
						"No classifier available. Select a route:",
						choiceLabels,
						{},
					);
					if (!lifecycle.isSessionCurrent(sessionToken)) return;
					if (!choice || choice === "Cancel") return;
					const idx = choiceLabels.indexOf(choice);
					if (idx >= 0 && idx < alternatives.length) {
						route = alternatives[idx].id;
						overrode = true;
					} else {
						return;
					}
				}
			}

			if (!route) return; // User cancelled.

			// For "change" route without explicit delivery: use classifier recommendation
			// or default to single.
			if (route === "change" && !delivery) {
				if (!overrode) {
					// The classifier may have recommended a delivery; if not, ask.
					const choice = await ctx.ui.select(
						"Delivery mode for change?",
						["single (default)", "stack", "Cancel"],
						{},
					);
					if (!lifecycle.isSessionCurrent(sessionToken)) return;
					if (!choice || choice === "Cancel") return;
					delivery = choice === "stack" ? "stack" : "single";
				} else {
					delivery = "single";
				}
			}

			// Check dependencies before dispatching.
			const availableCommands = pi.getCommands()
				.filter((c) => c.source === "extension")
				.map((c) => c.name);
			const availableSkills = (ctx.getSystemPromptOptions().skills ?? []).map((s) => s.name);
			const missingDeps = checkDependencies(route, availableCommands, availableSkills);
			if (missingDeps.length > 0) {
				notify(
					`Route "${getRouteLabel(route)}" requires: ${missingDeps.join(", ")}.\n` +
						"Install the required extension or skill and try again.",
					"error",
				);
				return;
			}

			// Begin dispatch.
			const dispatchToken = lifecycle.beginDispatch(sessionToken, pi);
			if (!dispatchToken) {
				notify("A dispatch is already active.", "warning");
				return;
			}

			// Set up pending dispatch for before_agent_start hook.
			pendingDispatch = { token: dispatchToken, route, task };

			// Send the route card.
			const routeCard: RouteCardDetails = {
				schemaVersion: 1,
				route,
				routeLabel: getRouteLabel(route),
				delivery,
				modelSource,
				confidence: undefined,
				overrode,
			};

			const routeDescription = getRouteDescription(route);
			const deliveryNote = delivery
				? `\nDelivery: ${delivery === "stack" ? "stacked PRs" : "single PR"}`
				: "";
			pi.sendMessage({
				customType: "kstack-route",
				content: `${routeDescription}${deliveryNote}`,
				display: true,
				details: routeCard,
			});

			// Dispatch.
			const result = await dispatchRoute(route, task, delivery, dispatchToken, lifecycle, pi, ctx);

			// Update the route card with dispatch status.
			routeCard.dispatchStatus = result.status;
			pi.sendMessage({
				customType: "kstack-route",
				content:
					result.status === "dispatched"
						? `Dispatched to ${getRouteLabel(route)}.`
						: `Dispatch failed: ${(result as { error?: string }).error ?? result.status}`,
				display: true,
				details: routeCard,
			});

			if (result.status === "failed") {
				notify(result.error, "error");
			}

			// For active-session routes (investigate, arena, swarm, skill-authoring, session-pickup),
			// we don't explicitly send a message — the before_agent_start hook and the user's
			// normal agent turn handle it. The dispatch token keeps the lifecycle active.
			const activeSessionRoutes: RouteId[] = ["investigate", "arena", "swarm", "skill-authoring", "session-pickup"];
			if (activeSessionRoutes.includes(route)) {
				// The before_agent_start hook will attach playbooks and restrict tools.
				// No explicit message needed; the user's next turn picks up the pending dispatch.
				if (result.status === "dispatched") {
					notify(
						`Route "investigate" selected. The next agent turn will use read-only tools. ` +
							`Use Ctrl+Shift+I for plan/implement, Ctrl+Shift+X for panel review, or Ctrl+Shift+K to abort classification.`,
						"info",
					);
				}
			}

			lifecycle.endDispatch(dispatchToken);
			pendingDispatch = undefined;
		},
	});
}

function readPlaybook(name: string): string {
	return readFileSync(join(PLAYBOOKS_DIR, name), "utf8");
}