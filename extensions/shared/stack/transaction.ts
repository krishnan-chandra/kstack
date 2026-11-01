/** The stack transaction every publication and landing runs.
 *
 * Order: plan → authorize → lock → re-plan → compare plan IDs → apply → release.
 *
 * - Authorization happens before the repository lock, so a pending confirmation
 *   never blocks another publication or landing. The re-plan under the lock is
 *   what proves the user confirmed exactly what is applied: a different plan ID
 *   returns `stale` and nothing is applied.
 * - `plan()` must not publish, change refs, or take the repository lock. It runs
 *   twice, and the second run holds the lock. The lock is deliberately not
 *   reentrant, so a plan step that publishes (for example, a PR Autopilot fix on
 *   Graphite, whose backend takes the same lock) would fail against itself as
 *   `busy`, and any other mutation would run twice. Idempotent local bookkeeping
 *   is allowed: jj inspection snapshots the working copy, and the second
 *   snapshot is a no-op unless files changed (which the plan ID then reflects).
 *   Work that may publish, such as Graphite's readiness pass, runs before the
 *   transaction starts.
 * - Only `apply()` mutates. It owns its own progress accounting and any
 *   provider-specific freshness checks it needs after the transaction's check.
 */

import type { ExecFn } from "../git-exec.ts";
import { type acquirePublicationLock, acquireRepositoryPublicationLock } from "../publication-lock.ts";
import type { StackBlocker } from "./blocker.ts";
import type { StackPublishOutcome } from "./outcome.ts";

type StackAuthorization = "interactive-confirmation" | "model-tool";

export type StackTransactionPhase = "planning" | "confirming" | "locking" | "replanning" | "applying";

/** A plan whose ID hashes every fact apply depends on. The ID proves freshness, never authorization. */
interface StackTransactionPlan {
	readonly planId: string;
	/** Bounded confirmation body. An adapter that cannot bound it returns a `truncated` blocker instead. */
	readonly preview: string;
}

export type StackPlanResult<P extends StackTransactionPlan> =
	| { ok: true; plan: P }
	| { ok: false; blockers: readonly StackBlocker[] };

/** A stack provider's side of the transaction. */
export interface StackTransactionAdapter<P extends StackTransactionPlan, O> {
	/** Never publishes or takes the repository lock. Runs before authorization and again under the lock. */
	plan(signal?: AbortSignal): Promise<StackPlanResult<P>>;
	/** The only mutating step. Runs under the repository lock with the re-planned plan. */
	apply(plan: P, signal?: AbortSignal): Promise<O>;
}

export interface StackTransactionOptions {
	authorization: StackAuthorization;
	ui: { hasUI: boolean; confirm(title: string, body: string): Promise<boolean> };
	confirmTitle: string;
	lock: {
		exec: ExecFn;
		cwd: string;
		/** jj resolves the shared lock identity through `jj git root`. */
		backend?: "git" | "jj";
		acquireLock?: typeof acquirePublicationLock;
		realpath?: (path: string) => string;
	};
	onPhase?(phase: StackTransactionPhase): void;
	signal?: AbortSignal;
}

/** Every outcome the transaction itself decides; anything else came from `apply`. */
type StackTransactionSettlement =
	| { status: "blocked"; blockers: readonly StackBlocker[]; planId?: string }
	| { status: "declined"; planId: string }
	| { status: "busy"; message: string }
	| { status: "stale"; providedPlanId: string; recomputedPlanId: string }
	| { status: "cancelled" }
	| { status: "failed"; error: string };

type StackTransactionResult<O> =
	| { kind: "settled"; outcome: StackTransactionSettlement; warnings: readonly string[] }
	| { kind: "applied"; outcome: O; warnings: readonly string[] };

const BUSY_MESSAGE = "Another stack publication or landing is active for this repository";

function settled<O>(outcome: StackTransactionSettlement): StackTransactionResult<O> {
	return { kind: "settled", outcome, warnings: [] };
}

async function runStackTransaction<P extends StackTransactionPlan, O>(
	adapter: StackTransactionAdapter<P, O>,
	options: StackTransactionOptions,
	operation: string,
): Promise<StackTransactionResult<O>> {
	const { signal } = options;
	if (options.authorization === "interactive-confirmation" && !options.ui.hasUI) {
		return settled({
			status: "blocked",
			blockers: [{ code: "missing-ui", message: `${operation} requires interactive TUI/RPC mode.` }],
		});
	}
	if (signal?.aborted) return settled({ status: "cancelled" });
	options.onPhase?.("planning");
	const planned = await adapter.plan(signal);
	if (signal?.aborted) return settled({ status: "cancelled" });
	if (!planned.ok) return settled({ status: "blocked", blockers: planned.blockers });

	if (options.authorization === "interactive-confirmation") {
		options.onPhase?.("confirming");
		const confirmed = await options.ui.confirm(options.confirmTitle, planned.plan.preview);
		if (signal?.aborted) return settled({ status: "cancelled" });
		if (!confirmed) return settled({ status: "declined", planId: planned.plan.planId });
	}

	options.onPhase?.("locking");
	const lock = await acquireRepositoryPublicationLock(options.lock.exec, options.lock.cwd, {
		backend: options.lock.backend,
		acquireLock: options.lock.acquireLock,
		realpath: options.lock.realpath,
		signal,
	});
	if (!lock.ok) {
		// Identity resolution can fail because the caller aborted; nothing was mutated either way.
		if (signal?.aborted) return settled({ status: "cancelled" });
		if (lock.kind === "failed") {
			return settled({ status: "failed", error: `Unable to acquire the repository lock: ${lock.error}` });
		}
		const holder = lock.holder ? ` (pid ${lock.holder.pid}, since ${lock.holder.startedAt})` : "";
		return settled({ status: "busy", message: `${BUSY_MESSAGE}${holder}. Retry after it finishes.` });
	}

	let result: StackTransactionResult<O>;
	try {
		result = await replanAndApply(adapter, options, planned.plan.planId);
	} catch (error) {
		const released = lock.lock.release();
		if (!released.ok && error instanceof Error) appendDiagnostic(error, releaseFailure(released.error));
		throw error;
	}
	const released = lock.lock.release();
	if (released.ok) return result;
	return { ...result, warnings: [...result.warnings, releaseFailure(released.error)] };
}

/** Best-effort: the original error, with its class and any indeterminate classification, always wins. */
function appendDiagnostic(error: Error, diagnostic: string): void {
	try {
		error.message = `${error.message} ${diagnostic}`;
	} catch {
		// A frozen error or read-only message (for example a DOMException) keeps its original text.
	}
}

function releaseFailure(error: string): string {
	return `Repository lock cleanup failed: ${error}. Remove the lock file manually if later publications or landings report busy.`;
}

/** The locked half of the transaction: prove the confirmed plan is still current, then apply it. */
async function replanAndApply<P extends StackTransactionPlan, O>(
	adapter: StackTransactionAdapter<P, O>,
	options: StackTransactionOptions,
	planId: string,
): Promise<StackTransactionResult<O>> {
	const { signal } = options;
	if (signal?.aborted) return settled({ status: "cancelled" });
	options.onPhase?.("replanning");
	const fresh = await adapter.plan(signal);
	if (signal?.aborted) return settled({ status: "cancelled" });
	if (!fresh.ok) return settled({ status: "blocked", blockers: fresh.blockers, planId });
	if (fresh.plan.planId !== planId) {
		return settled({ status: "stale", providedPlanId: planId, recomputedPlanId: fresh.plan.planId });
	}
	options.onPhase?.("applying");
	return { kind: "applied", outcome: await adapter.apply(fresh.plan, signal), warnings: [] };
}

function withWarnings(outcome: StackPublishOutcome, warnings: readonly string[]): StackPublishOutcome {
	if (warnings.length === 0) return outcome;
	return { ...outcome, warnings: [...(outcome.warnings ?? []), ...warnings] };
}

/** Run a stack publication through the shared transaction. */
export async function runPublication<P extends StackTransactionPlan>(
	adapter: StackTransactionAdapter<P, StackPublishOutcome>,
	options: StackTransactionOptions,
): Promise<StackPublishOutcome> {
	const result = await runStackTransaction(adapter, options, "Publication");
	return withWarnings(result.outcome, result.warnings);
}
