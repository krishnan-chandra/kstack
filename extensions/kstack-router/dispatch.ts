/** Deterministic dispatch for each route. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requestFastImplement } from "../fast-implement/api.ts";
import { requestLand } from "../land/api.ts";
import { requestPanelReview } from "../panel-review/api.ts";
import { requestPlanImplement } from "../plan-implement/api.ts";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import type { ChangeKind } from "../shared/change-kind.ts";
import { getRoutePlaybook } from "./catalog.ts";
import type { DispatchToken, RouterLifecycle } from "./lifecycle.ts";
import type { PostPrRequest } from "./post-pr-options.ts";
import { allowedReadToolsForRoute, type DeliveryRecommendation, type RouteId } from "./types.ts";

type DispatchResult =
	| { status: "dispatched" }
	| { status: "takeover" }
	| { status: "failed"; error: string }
	| { status: "aborted" };

/**
 * Dispatch the task to the appropriate handler based on the selected route.
 *
 * For `change`, `review`, `pr-autopilot`, and `land`, this uses in-process
 * event APIs to avoid synthesizing slash-command strings. For other routes,
 * the caller handles active-session lifecycle (tool restriction, playbook
 * attachment, etc.) before calling this function; those routes return here
 * immediately.
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
	postPr?: PostPrRequest,
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

		case "fast-change": {
			if (delivery === "stack")
				return {
					status: "failed",
					error: "fast-change supports only single-PR workstreams. Use the change route for stacks.",
				};
			try {
				const result = await requestFastImplement(pi, task, worktree ? "worktree" : "current", changeKind, ctx);
				if (!result.handled) {
					return { status: "failed", error: "fast-implement extension is not loaded or did not accept the request." };
				}
				return { status: worktree ? "dispatched" : "takeover" };
			} catch (err) {
				// A current-checkout handler may throw only after newSession has
				// invalidated the router's parent-session handles. Returning takeover
				// keeps the caller from touching stale pi/ctx objects.
				return worktree
					? { status: "failed", error: `fast-implement dispatch failed: ${(err as Error).message}` }
					: { status: "takeover" };
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
				return { status: "failed", error: `pr-autopilot dispatch failed: ${(err as Error).message}` };
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
				return { status: "failed", error: `land dispatch failed: ${(err as Error).message}` };
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
					"investigate (read-only research), change (plan → implement → review), fast-change (one-shot bounded implementation), " +
					"arena (parallel candidate comparison), swarm (parallel independent slices), " +
					"skill-authoring (create/test skills), session-pickup (recover context), " +
					"review (read-only panel review), pr-autopilot (drive an existing PR to merge-ready), " +
					"land (confirm and merge one PR). Use --route to pick one explicitly.",
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
