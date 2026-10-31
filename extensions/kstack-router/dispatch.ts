/** Deterministic dispatch for each route. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requestLand } from "../land/api.ts";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import { getRoutePlaybook } from "./catalog.ts";
import type { DispatchToken, RouterLifecycle } from "./lifecycle.ts";
import type { PostPrRequest } from "./post-pr-options.ts";
import { runReviewRoute } from "./review-runner.ts";
import { allowedReadToolsForRoute, type RouteId } from "./types.ts";

type DispatchResult = { status: "dispatched" } | { status: "failed"; error: string } | { status: "aborted" };

/**
 * Dispatch the task to the appropriate handler based on the selected route.
 *
 * For `review`, `pr-autopilot`, and `land`, this uses in-process event APIs to avoid synthesizing slash-command strings. For other routes,
 * the caller handles active-session lifecycle (tool restriction, playbook
 * attachment, etc.) before calling this function; those routes return here
 * immediately.
 */
export async function dispatchRoute(
	route: RouteId,
	task: string,
	dispatchToken: DispatchToken,
	lifecycle: RouterLifecycle,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	postPr?: PostPrRequest,
): Promise<DispatchResult> {
	if (!lifecycle.isCurrentDispatch(dispatchToken)) {
		return { status: "aborted" };
	}

	switch (route) {
		case "review": {
			const result = await runReviewRoute(pi, ctx, task, lifecycle.signal());
			if (result.status === "failed") return { status: "failed", error: result.error };
			if (result.status === "aborted") return { status: "aborted" };
			return { status: "dispatched" };
		}

		case "pr-autopilot": {
			if (postPr?.route !== "pr-autopilot") {
				return { status: "failed", error: "Internal error: pr-autopilot dispatch is missing a typed request." };
			}
			try {
				const result = await requestPrAutopilot(pi, postPr.mode, postPr.prNumber, ctx, ctx.cwd);
				return result.handled
					? { status: "dispatched" }
					: {
							status: "failed",
							error:
								"pr-autopilot extension is not loaded or did not accept the request. " +
								"Make sure it is installed: pi list | grep pr-autopilot",
						};
			} catch (err) {
				return {
					status: "failed",
					error: `pr-autopilot dispatch failed: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (err as Error).message}`,
				};
			}
		}

		case "land": {
			if (postPr?.route !== "land") {
				return { status: "failed", error: "Internal error: land dispatch is missing a typed request." };
			}
			try {
				const result = await requestLand(
					pi,
					{
						target: { kind: "single", prNumber: postPr.prNumber },
						readiness: postPr.readiness,
						method: postPr.method,
						cwd: ctx.cwd,
					},
					ctx,
				);
				return result.handled
					? { status: "dispatched" }
					: {
							status: "failed",
							error:
								"land extension is not loaded or did not accept the request. " +
								"Make sure it is installed: pi list | grep land",
						};
			} catch (err) {
				return {
					status: "failed",
					error: `land dispatch failed: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (err as Error).message}`,
				};
			}
		}

		case "investigate":
		case "arena":
		case "swarm":
		case "skill-authoring":
		case "session-pickup":
			// Active-session routes are dispatched by the command handler in
			// index.ts (tool gate + playbook injection + sendUserMessage).
			// Reaching this function with one of them is a programming error;
			// fail closed rather than silently doing nothing.
			return {
				status: "failed",
				error: `Route "${route}" is an active-session route and must be dispatched by the /kstack command handler.`,
			};

		case "unsupported":
			return {
				status: "failed",
				error:
					"This task does not fit a supported route. Kstack Router supports: " +
					"investigate (read-only research), arena (parallel candidate comparison), swarm (parallel independent slices), " +
					"skill-authoring (create/test skills), session-pickup (recover context), " +
					"review (strict code-quality review on a frontier model), pr-autopilot (drive an existing PR to merge-ready), " +
					"land (confirm and merge one PR). Plan + implement workflows run through /skill:adversarial-planning. Use --route to pick one explicitly.",
			};

		default: {
			const _exhaustive: never = route;
			return { status: "failed", error: `Unknown route: ${_exhaustive}` };
		}
	}
}

/**
 * Get the read-only tool intersection for a route: the intersection of the
 * route's read-only allowlist and the currently active tools. This never
 * enables a tool the user had disabled.
 */
export function getRestrictedTools(route: RouteId, currentTools: string[]): string[] {
	const allowed = allowedReadToolsForRoute(route);
	return currentTools.filter((t) => allowed.has(t));
}

/**
 * Get the playbook content for a route. Returns undefined when no playbook exists.
 */
export function getPlaybookForRoute(route: RouteId): string | undefined {
	return getRoutePlaybook(route);
}
