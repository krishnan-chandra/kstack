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
import { getRouteLabel, getRouteDescription, validateCatalog, checkDependencies } from "./catalog.ts";
import { formatRecommendation, buildRouteAlternatives } from "./classification.ts";
import { runClassifier } from "./classifier-runner.ts";
import { loadConfig, resolveClassifierModel } from "./config.ts";
import { isChildModelAvailable } from "../plan-implement/model-availability.ts";
import { changeKindLabel, type ChangeKind } from "../plan-implement/change-kind.ts";
import { dispatchRoute, getRestrictedTools, getPlaybookForRoute } from "./dispatch.ts";
import { RouterLifecycle, type DispatchToken } from "./lifecycle.ts";
import {
	allowedReadToolsForRoute,
	isActiveSessionRoute,
	type RouteId,
	type DeliveryRecommendation,
} from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "playbooks");

interface RouteCardDetails {
	schemaVersion: 1;
	route: RouteId;
	routeLabel: string;
	delivery: DeliveryRecommendation;
	changeKind?: ChangeKind;
	modelSource?: string;
	confidence?: string;
	overrode: boolean;
	dispatchStatus?: string;
}

/** One-shot correlation between a dispatched active-session route and the user turn it triggers. */
interface PendingDispatch {
	token: DispatchToken;
	route: RouteId;
}

export default function (pi: ExtensionAPI): void {
	const lifecycle = new RouterLifecycle();

	// Store a pending dispatch token so before_agent_start can access it.
	let pendingDispatch: PendingDispatch | undefined;

	/** Restore the exact pre-dispatch tool snapshot, best effort. */
	function restoreTools(tools: readonly string[]): void {
		try {
			pi.setActiveTools([...tools]);
		} catch {
			// Session may already be gone; the restricted set dies with it.
		}
	}

	function endActiveDispatch(token: DispatchToken): void {
		const snapshot = lifecycle.getToolSnapshot();
		lifecycle.endDispatch(token);
		pendingDispatch = undefined;
		if (snapshot) restoreTools(snapshot.tools);
	}

	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => {
		// Restore any restricted tools before the session goes away so a
		// replacement session never inherits the read-only gate.
		const snapshot = lifecycle.getToolSnapshot();
		lifecycle.shutdownSession();
		pendingDispatch = undefined;
		if (snapshot) restoreTools(snapshot.tools);
	});

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
			...(details?.changeKind ? [`Change kind: ${changeKindLabel(details.changeKind)}`] : []),
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

	// --- before_agent_start: inject principles + playbook for the one pending active-session dispatch ---
	pi.on("before_agent_start", (event) => {
		if (!pendingDispatch) return;
		const { token, route } = pendingDispatch;
		// One-shot: consume regardless so ordinary turns never receive stale
		// route instructions.
		pendingDispatch = undefined;

		if (!lifecycle.isCurrentDispatch(token) || !isActiveSessionRoute(route)) return;

		const parts: string[] = [];
		try {
			parts.push(readPlaybook("principles.md"));
		} catch {
			// Principles absent is not fatal.
		}
		const playbookFile = getPlaybookForRoute(route);
		if (playbookFile) {
			try {
				parts.push(readPlaybook(playbookFile));
			} catch {
				// Playbook absent is not fatal.
			}
		}
		if (parts.length === 0) return;

		return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${parts.join("\n\n---\n\n")}` };
	});

	// --- agent_settled: end the active-session dispatch and restore tools ---
	pi.on("agent_settled", (_event, ctx) => {
		const active = lifecycle.getActiveDispatch();
		if (!active || !isActiveSessionRoute(active.route)) return;
		endActiveDispatch(active.token);
		ctx.ui.setStatus("kstack-router", undefined);
	});

	// --- Command handler ---
	pi.registerCommand("kstack", {
		description:
			"Route a task through the Kstack Router: /kstack [--route <id>] [--single|--stack] [--change-kind <kind>] [--] <task>. " +
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
			let changeKind: ChangeKind = parsed.args.changeKind ?? "generic";
			let overrode = false;
			let modelSource = "explicit --route";
			let confidence: string | undefined;

			if (!route) {
				// Run the classifier.
				const configLoad = loadConfig();
				if (configLoad.status === "invalid") {
					notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
					return;
				}
				const routerConfig = configLoad.status === "loaded" ? configLoad.config : null;

				const classifierResolution = resolveClassifierModel(routerConfig, {
					available: (provider, modelId) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
					activeModelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				});

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
						thinking: classifierResolution.thinking,
						task,
						signal: classifierController.signal,
						timeoutSeconds: routerConfig?.timeoutSeconds,
					});
					lifecycle.endClassifier(sessionToken);
					ctx.ui.setStatus("kstack-router", undefined);

					if (classifierResult.status === "aborted") {
						notify("Classification aborted.", "info");
						return;
					}

					if (classifierResult.status === "completed") {
						confidence = classifierResult.envelope.confidence;
						const recommendation = {
							route: classifierResult.envelope.route,
							confidence: classifierResult.envelope.confidence,
							rationale: classifierResult.envelope.rationale,
							delivery: classifierResult.envelope.delivery,
							changeKind: classifierResult.envelope.changeKind,
						};

						// Show the recommendation.
						notify(formatRecommendation(recommendation, modelSource), "info");

						// User may override.
						const alternatives = buildRouteAlternatives(recommendation.route);
						const selected = await selectRoute(ctx, "Accept route or choose another?", [
							{ route: recommendation.route, label: `✓ Accept: ${getRouteLabel(recommendation.route)}` },
							...alternatives.map((alternative) => ({
								route: alternative.id,
								label: `${alternative.label}: ${alternative.description.slice(0, 60)}…`,
							})),
						]);
						if (!lifecycle.isSessionCurrent(sessionToken)) return;
						if (!selected) {
							notify("Routing cancelled.", "info");
							return;
						}
						route = selected;
						overrode = route !== recommendation.route;
						if (!overrode && recommendation.delivery && !delivery) {
							delivery = recommendation.delivery;
						}
						if (!overrode && recommendation.changeKind && !parsed.args.changeKind) {
							changeKind = recommendation.changeKind;
						}
					} else {
						// Classifier failed; offer manual selection.
						notify(`Classifier did not produce a valid route (${classifierResult.status === "failed" ? classifierResult.error : "unknown error"}). Please pick a route manually.`, "warning");
						const alternatives = buildRouteAlternatives();
						route = await selectRoute(
							ctx,
							"Select a route:",
							alternatives.map((alternative) => ({
								route: alternative.id,
								label: `${alternative.label}: ${alternative.description.slice(0, 60)}…`,
							})),
						);
						if (!lifecycle.isSessionCurrent(sessionToken) || !route) return;
						overrode = true;
					}
				}

				// If no classifier model and no manual selection resolved, fall back to manual.
				if (!route) {
					const alternatives = buildRouteAlternatives();
					route = await selectRoute(
						ctx,
						"No classifier available. Select a route:",
						alternatives.map((alternative) => ({
							route: alternative.id,
							label: `${alternative.label}: ${alternative.description.slice(0, 60)}…`,
						})),
					);
					if (!lifecycle.isSessionCurrent(sessionToken) || !route) return;
					overrode = true;
				}
			}

			if (!route) return; // User cancelled.

			if (parsed.args.changeKind && route !== "change") {
				notify("--change-kind is only valid with --route change.", "warning");
				return;
			}

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

			const routeCard: RouteCardDetails = {
				schemaVersion: 1,
				route,
				routeLabel: getRouteLabel(route),
				delivery,
				...(route === "change" ? { changeKind } : {}),
				modelSource,
				confidence,
				overrode,
			};
			const routeDescription = getRouteDescription(route);
			const deliveryNote = delivery
				? `\nDelivery: ${delivery === "stack" ? "stacked PRs" : "single PR"}`
				: "";

			// --- Active-session routes: restrict tools, inject playbook, trigger a turn ---
			if (isActiveSessionRoute(route)) {
				await ctx.waitForIdle();
				if (!lifecycle.isSessionCurrent(sessionToken)) return;

				const snapshot = pi.getActiveTools();
				const dispatchToken = lifecycle.beginDispatch(sessionToken, { route, toolSnapshot: snapshot });
				if (!dispatchToken) {
					notify("A dispatch is already active.", "warning");
					return;
				}

				const restricted = getRestrictedTools(route, snapshot);
				if (restricted.length === 0) {
					lifecycle.endDispatch(dispatchToken);
					notify(
						`Route "${getRouteLabel(route)}" needs at least one read-only tool active ` +
							`(${[...allowedReadToolsForRoute(route)].join(", ")}). Enable one and try again.`,
						"error",
					);
					return;
				}

				// Correlate the next agent turn to this dispatch so
				// before_agent_start attaches principles + the route playbook.
				pendingDispatch = { token: dispatchToken, route };

				routeCard.dispatchStatus = "dispatched";
				pi.sendMessage({
					customType: "kstack-route",
					content: `${routeDescription}${deliveryNote}\nRead-only gate: ${restricted.join(", ")}`,
					display: true,
					details: routeCard,
				});

				try {
					pi.setActiveTools(restricted);
					pi.sendUserMessage(task);
				} catch (error) {
					pendingDispatch = undefined;
					restoreTools(snapshot);
					lifecycle.endDispatch(dispatchToken);
					notify(`Failed to start the routed turn: ${(error as Error).message}`, "error");
					return;
				}

				ctx.ui.setStatus("kstack-router", `kstack-router: ${route} (read-only)`);
				notify(
					`Route "${getRouteLabel(route)}" dispatched with read-only tools until the turn settles. ` +
						"Press Esc to cancel the turn; the full tool set is restored automatically.",
					"info",
				);
				// The dispatch stays active; agent_settled restores tools and ends it.
				return;
			}

			// --- Delegated routes: change / review / unsupported ---
			const dispatchToken = lifecycle.beginDispatch(sessionToken, { route });
			if (!dispatchToken) {
				notify("A dispatch is already active.", "warning");
				return;
			}

			pi.sendMessage({
				customType: "kstack-route",
				content: `${routeDescription}${deliveryNote}`,
				display: true,
				details: routeCard,
			});

			const result = await dispatchRoute(route, task, delivery, changeKind, dispatchToken, lifecycle, pi, ctx);

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
				notify((result as { error?: string }).error ?? "Dispatch failed.", "error");
			} else if (route === "change") {
				notify("Delegated to plan-implement. Use Ctrl+Shift+I to abort the plan/implement child.", "info");
			} else if (route === "review") {
				notify("Delegated to panel-review. Use Ctrl+Shift+X to abort the review.", "info");
			}

			lifecycle.endDispatch(dispatchToken);
		},
	});
}

async function selectRoute(
	ctx: ExtensionCommandContext,
	title: string,
	options: Array<{ route: RouteId; label: string }>,
): Promise<RouteId | undefined> {
	const routesByLabel = new Map(options.map((option) => [option.label, option.route]));
	const selected = await ctx.ui.select(title, [...routesByLabel.keys(), "Cancel"], {});
	return selected && selected !== "Cancel" ? routesByLabel.get(selected) : undefined;
}

function readPlaybook(name: string): string {
	return readFileSync(join(PLAYBOOKS_DIR, name), "utf8");
}
