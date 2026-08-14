/** Deterministic dispatch for each route. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requestPanelReview } from "../panel-review/api.ts";
import { requestPlanImplement } from "../plan-implement/api.ts";
import type { ChangeKind } from "../plan-implement/change-kind.ts";
import { getRoutePlaybook } from "./catalog.ts";
import type { DispatchToken, RouterLifecycle } from "./lifecycle.ts";
import { allowedReadToolsForRoute, type DeliveryRecommendation, type RouteId } from "./types.ts";

export type DispatchResult = { status: "dispatched" } | { status: "failed"; error: string } | { status: "aborted" };

/**
 * Dispatch the task to the appropriate handler based on the selected route.
 *
 * For `change` and `review`, this uses in-process event APIs to avoid
 * synthesizing slash-command strings. For other routes, the caller handles
 * active-session lifecycle (tool restriction, playbook attachment, etc.)
 * before calling this function; those routes return here immediately.
 */
export async function dispatchRoute(
	route: RouteId,
	task: string,
	delivery: DeliveryRecommendation,
	worktree: boolean,
	changeKind: ChangeKind,
	dispatchToken: DispatchToken,
	lifecycle: RouterLifecycle,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<DispatchResult> {
	if (!lifecycle.isCurrentDispatch(dispatchToken)) {
		return { status: "aborted" };
	}

	switch (route) {
		case "change": {
			const mode = delivery === "stack" ? "stack" : "single";
			try {
				const result = await requestPlanImplement(pi, task, mode, worktree ? "worktree" : "current", changeKind, ctx);
				if (!result.handled) {
					return {
						status: "failed",
						error:
							"plan-implement extension is not loaded or did not accept the request. " +
							"Make sure it is installed: pi list | grep plan-implement",
					};
				}
				return { status: "dispatched" };
			} catch (err) {
				return { status: "failed", error: `plan-implement dispatch failed: ${(err as Error).message}` };
			}
		}

		case "review": {
			try {
				const result = await requestPanelReview(pi, { intent: task }, ctx);
				if (!result.handled) {
					return {
						status: "failed",
						error:
							"panel-review extension is not loaded or did not accept the request. " +
							"Make sure it is installed: pi list | grep panel-review",
					};
				}
				return { status: "dispatched" };
			} catch (err) {
				return { status: "failed", error: `panel-review dispatch failed: ${(err as Error).message}` };
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
					"investigate (read-only research), change (plan → implement → review), " +
					"arena (parallel candidate comparison), swarm (parallel independent slices), " +
					"skill-authoring (create/test skills), session-pickup (recover context), " +
					"review (read-only panel review). Use --route to pick one explicitly.",
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
