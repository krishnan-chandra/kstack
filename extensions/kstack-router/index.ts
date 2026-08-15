/** Kstack Router — the package's front door. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import { parseArgs } from "./args.ts";
import { checkDependencies, getRouteDescription, getRouteLabel, validateCatalog } from "./catalog.ts";
import { runClassifier } from "./classifier-runner.ts";
import { loadConfig, resolveClassifierModel } from "./config.ts";
import { dispatchRoute, getPlaybookForRoute, getRestrictedTools } from "./dispatch.ts";
import { type DispatchToken, RouterLifecycle } from "./lifecycle.ts";
import { resolvePostPrOptions } from "./post-pr-options.ts";
import { type RouteCardDetails, registerRouteCardRenderer } from "./route-card.ts";
import { resolveRoute } from "./route-resolution.ts";
import { allowedReadToolsForRoute, isActiveSessionRoute, type RouteId, type RouterConfig } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "playbooks");

/** One-shot correlation between a dispatched active-session route and the user turn it triggers. */
interface PendingDispatch {
	token: DispatchToken;
	route: RouteId;
}

export default function (pi: ExtensionAPI): void {
	const lifecycle = new RouterLifecycle();
	// Extensions normally load before session_start; eager activation also keeps
	// commands usable when an extension is loaded into an existing session.
	lifecycle.startSession();

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

	registerRouteCardRenderer(pi);

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

	pi.on("before_agent_start", (event) => {
		if (!pendingDispatch) return;
		const { token, route } = pendingDispatch;
		// One-shot: consume regardless so ordinary turns never receive stale
		// route instructions.
		pendingDispatch = undefined;

		if (!lifecycle.isCurrentDispatch(token) || !isActiveSessionRoute(route)) return;

		const parts: string[] = [];
		try {
			parts.push(readPromptAsset(PLAYBOOKS_DIR, "principles.md"));
		} catch {
			// Principles absent is not fatal.
		}
		const playbookFile = getPlaybookForRoute(route);
		if (playbookFile) {
			try {
				parts.push(readPromptAsset(PLAYBOOKS_DIR, playbookFile));
			} catch {
				// Playbook absent is not fatal.
			}
		}
		if (parts.length === 0) return;

		return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${parts.join("\n\n---\n\n")}` };
	});

	pi.on("agent_settled", (_event, ctx) => {
		const active = lifecycle.getActiveDispatch();
		if (!active || !isActiveSessionRoute(active.route)) return;
		endActiveDispatch(active.token);
		ctx.ui.setStatus("kstack-router", undefined);
	});

	pi.registerCommand("kstack", {
		description:
			"Route a task through the Kstack Router: /kstack [--route <id>] [--single|--stack] [--worktree] [--change-kind <kind>] " +
			"[--mode <mode>] [--pr <n>] [--method <method>] [--readiness <mode>] [--] <task>. " +
			"Prompts for classification when no --route is given.",
		handler: async (args, ctx) => {
			const notify = ctx.ui.notify.bind(ctx.ui);
			if (!ctx.hasUI) {
				notify("/kstack requires interactive (TUI/RPC) mode.", "error");
				return;
			}

			const sessionToken = lifecycle.sessionToken();
			if (!sessionToken) {
				notify("kstack-router has no active session; try again after the session starts.", "error");
				return;
			}

			// Validate the catalog (internal consistency check).
			const catalogErrors = validateCatalog();
			if (catalogErrors.length > 0) {
				notify(`Router catalog validation failed:\n${catalogErrors.join("\n")}`, "error");
				return;
			}

			// Parse arguments before waiting so an inline task can name the session
			// immediately when command execution begins.
			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) {
				notify(parsed.error, "warning");
				return;
			}

			// Explicit post-PR routes can run without a task. Every other path
			// still needs one for classification, session naming, or dispatch.
			const explicitPostPr = parsed.args.route === "pr-autopilot" || parsed.args.route === "land";
			let task = parsed.args.task;
			if (!task.trim() && !explicitPostPr) {
				await ctx.waitForIdle();
				if (!lifecycle.isSessionCurrent(sessionToken)) return;
				const edited = await ctx.ui.editor("Kstack Router task:", "");
				if (edited === undefined) return; // User cancelled.
				if (!lifecycle.isSessionCurrent(sessionToken)) return;
				task = edited.trim();
				if (!task) {
					notify("/kstack requires a non-empty task.", "warning");
					return;
				}
			}

			if (task.trim()) nameSessionIfUnnamed(pi, task);
			await ctx.waitForIdle();
			if (!lifecycle.isSessionCurrent(sessionToken)) return;

			// Resolve route and user overrides behind narrow, testable effects.
			let routerConfig: RouterConfig | null = null;
			let classifierResolution: ReturnType<typeof resolveClassifierModel> | undefined;
			if (!parsed.args.route) {
				const configLoad = loadConfig();
				if (configLoad.status === "invalid") {
					notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
					return;
				}
				routerConfig = configLoad.status === "loaded" ? configLoad.config : null;
				classifierResolution = resolveClassifierModel(routerConfig, {
					available: (provider, modelId) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
					activeModelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				});
			}
			const resolution = await resolveRoute(
				{ parsedArgs: parsed.args, task, routerConfig, classifierResolution },
				{
					notify,
					selectRoute: async (title, options) => {
						const routesByLabel = new Map(options.map((option) => [option.label, option.route]));
						const selected = await ctx.ui.select(title, [...routesByLabel.keys(), "Cancel"], {});
						return selected && selected !== "Cancel" ? routesByLabel.get(selected) : undefined;
					},
					selectOption: (title, options) => ctx.ui.select(title, options, {}),
					runClassifier,
					isSessionCurrent: () => lifecycle.isSessionCurrent(sessionToken),
					beginClassifier: () => lifecycle.beginClassifier(sessionToken),
					endClassifier: () => lifecycle.endClassifier(sessionToken),
					setStatus: (text) => ctx.ui.setStatus("kstack-router", text),
				},
			);
			if ("cancelled" in resolution) return;
			if ("failed" in resolution) {
				notify(resolution.failed, "warning");
				return;
			}
			const { route, delivery, changeKind, overrode, modelSource, confidence } = resolution.resolved;
			const worktree = parsed.args.worktree ?? false;

			const postPrResolution = await resolvePostPrOptions(route, parsed.args, {
				select: (title, options) => ctx.ui.select(title, options, {}),
				input: (title, placeholder) => ctx.ui.input(title, placeholder ?? ""),
				isSessionCurrent: () => lifecycle.isSessionCurrent(sessionToken),
			});
			if ("cancelled" in postPrResolution) return;
			if ("failed" in postPrResolution) {
				notify(postPrResolution.failed, "warning");
				return;
			}
			const postPr = postPrResolution.request;

			if (!task.trim()) {
				const fallbackName =
					postPr?.route === "pr-autopilot"
						? postPr.prNumber
							? `pr-autopilot-${postPr.prNumber}`
							: "pr-autopilot"
						: postPr?.route === "land"
							? `land-${postPr.prNumber}`
							: route;
				nameSessionIfUnnamed(pi, fallbackName);
			}

			const availableCommands = pi
				.getCommands()
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
				worktree,
				...(route === "change" || route === "fast-change" ? { changeKind } : {}),
				modelSource,
				confidence,
				overrode,
			};
			const routeDescription = getRouteDescription(route);
			const deliveryNote = delivery
				? `\nDelivery: ${delivery === "stack" ? "stacked PRs" : "single PR"}${worktree ? " in a managed Git worktree" : ""}`
				: "";

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

			const dispatchToken = lifecycle.beginDispatch(sessionToken, { route });
			if (!dispatchToken) {
				notify("A dispatch is already active.", "warning");
				return;
			}

			try {
				pi.sendMessage({
					customType: "kstack-route",
					content: `${routeDescription}${deliveryNote}`,
					display: true,
					details: routeCard,
				});

				const result = await dispatchRoute(
					route,
					task,
					delivery,
					worktree,
					changeKind,
					dispatchToken,
					lifecycle,
					pi,
					ctx,
					postPr,
				);
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
				} else if (route === "fast-change") {
					notify("Delegated to fast-implement. Use Ctrl+Shift+A to abort the implementation child.", "info");
				} else if (route === "review") {
					notify("Delegated to panel-review. Use Ctrl+Shift+X to abort the review.", "info");
				} else if (route === "pr-autopilot") {
					notify("Delegated to pr-autopilot. Use Ctrl+Shift+B to abort the run.", "info");
				} else if (route === "land") {
					notify("Delegated to land. Confirmation and exact-head checks still belong to /land.", "info");
				}
			} finally {
				lifecycle.endDispatch(dispatchToken);
			}
		},
	});
}
