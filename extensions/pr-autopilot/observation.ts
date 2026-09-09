/**
 * PR observation and readiness: fetch handling, head verification,
 * reconciliation, and the run-wide settling budget.
 *
 * The driver owns durable Autopilot state and renders user messages.
 * Observation computes reconciliation, emits typed facts, and owns only
 * temporary head-verification state and the settling budget.
 */
import { isString } from "../shared/validation.ts";
import { reconcileLegacyFlakeRetries } from "./ci-retries.ts";
import {
	describeBlockers,
	isMergeabilityPending,
	isMergeReady,
	isMergeReadyIgnoringHeadVerification,
	terminalPrReason,
} from "./pr-state.ts";
import { reconcileLegacyPendingReplyIds } from "./review-handling.ts";
import type { AutopilotPersistedState, PRState } from "./types.ts";

const MERGEABILITY_POLL_LIMIT = 5;
const MERGEABILITY_POLL_DELAY_MS = 1000;

type HeadMovePhase = "verification" | "readiness" | "mergeability";
type ReadyPhase = "check" | "fresh-status" | "mergeability";

interface PersistedStateOwner {
	current: () => AutopilotPersistedState;
	apply: (state: AutopilotPersistedState) => Promise<void>;
}

type ObservationEvent =
	| {
			kind: "error" | "readiness-regressed" | "mergeability-regressed" | "not-ready";
			reason: string;
	  }
	| { kind: "head-moved"; previousHeadSha: string; nextHeadSha: string; phase: HeadMovePhase }
	| { kind: "merge-ready"; phase: ReadyPhase };

interface PrObservationOptions {
	read: (verifiedHeadSha: string | null) => Promise<PRState | string>;
	sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
	persistedState: PersistedStateOwner;
	report: (event: ObservationEvent) => void;
	signal: AbortSignal;
	persistWritesBlocked: boolean;
}

interface PrObservation extends PrObservationOptions {
	mergeabilityPolls: number;
}

type Observed = { kind: "aborted" } | { kind: "failed"; reason: string } | { kind: "ok"; snapshot: PRState };

type CheckResult =
	| { kind: "aborted"; snapshot: PRState | null }
	| { kind: "failed"; reason: string; snapshot: PRState | null }
	| { kind: "incomplete"; snapshot: PRState; reason: string }
	| { kind: "merge-ready"; snapshot: PRState };

type SettleResult =
	| { kind: "aborted"; snapshot: PRState }
	| { kind: "failed"; reason: string; snapshot: PRState }
	| { kind: "incomplete"; reason: string; snapshot: PRState }
	| { kind: "merge-ready"; snapshot: PRState }
	| { kind: "continue"; snapshot: PRState };

interface PrObservationSession {
	check: () => Promise<CheckResult>;
	refresh: () => Promise<Observed>;
	settle: (snapshot: PRState, poll: boolean) => Promise<SettleResult>;
}

function onlyHeadVerificationPending(snapshot: PRState): boolean {
	return snapshot.verifiedHeadSha !== snapshot.headSha && isMergeReadyIgnoringHeadVerification(snapshot);
}

async function reconcileSnapshot(
	observation: PrObservation,
	snapshot: PRState,
	reconcilePendingReplies: boolean,
): Promise<void> {
	let persisted = observation.persistedState.current();
	const retries = reconcileLegacyFlakeRetries({
		checks: snapshot.checks,
		headSha: snapshot.headSha,
		legacyRetryKeys: persisted.flakeRetried,
		runRetries: persisted.flakeRunRetries,
	});
	if (retries.changed) {
		persisted = {
			...persisted,
			flakeRetried: retries.legacyRetryKeys,
			flakeRunRetries: retries.runRetries,
		};
		await observation.persistedState.apply(persisted);
	}
	if (observation.persistWritesBlocked || !reconcilePendingReplies) return;
	const reconciled = reconcileLegacyPendingReplyIds(persisted.legacyPendingReplyIds, snapshot.threads);
	if (reconciled.length === persisted.legacyPendingReplyIds.length) return;
	await observation.persistedState.apply({ ...persisted, legacyPendingReplyIds: reconciled });
}

async function observe(
	observation: PrObservation,
	verifiedHeadSha: string | null,
	reconcilePendingReplies: boolean,
): Promise<Observed> {
	const fetched = await observation.read(verifiedHeadSha);
	if (observation.signal.aborted) return { kind: "aborted" };
	if (isString(fetched)) return { kind: "failed", reason: fetched };
	await reconcileSnapshot(observation, fetched, reconcilePendingReplies);
	return { kind: "ok", snapshot: fetched };
}

async function checkObservation(observation: PrObservation): Promise<CheckResult> {
	const first = await observe(observation, null, true);
	if (first.kind === "aborted") return { kind: "aborted", snapshot: null };
	if (first.kind === "failed") {
		observation.report({ kind: "error", reason: first.reason });
		return { kind: "failed", reason: first.reason, snapshot: null };
	}
	if (observation.signal.aborted) return { kind: "aborted", snapshot: first.snapshot };
	const firstTerminalReason = terminalPrReason(first.snapshot);
	const second = await observe(observation, first.snapshot.headSha, false);
	if (second.kind === "aborted") return { kind: "aborted", snapshot: first.snapshot };
	if (second.kind === "failed") return { kind: "failed", reason: second.reason, snapshot: first.snapshot };
	const terminalReason = firstTerminalReason ?? terminalPrReason(second.snapshot);
	if (terminalReason) {
		observation.report({ kind: "not-ready", reason: terminalReason });
		return { kind: "incomplete", snapshot: second.snapshot, reason: terminalReason };
	}
	if (isMergeReady(second.snapshot)) {
		observation.report({ kind: "merge-ready", phase: "check" });
		return { kind: "merge-ready", snapshot: second.snapshot };
	}
	const reason = describeBlockers(second.snapshot);
	observation.report({ kind: "not-ready", reason });
	return { kind: "incomplete", snapshot: second.snapshot, reason };
}

async function settleObservation(observation: PrObservation, snapshot: PRState, poll: boolean): Promise<SettleResult> {
	const settled = await observe(observation, snapshot.headSha, false);
	if (settled.kind === "aborted") return { kind: "aborted", snapshot };
	if (settled.kind === "failed") {
		observation.report({ kind: "error", reason: settled.reason });
		return { kind: "failed", reason: settled.reason, snapshot };
	}
	if (observation.signal.aborted) return { kind: "aborted", snapshot: settled.snapshot };
	const settledTerminalReason = terminalPrReason(settled.snapshot);
	if (settledTerminalReason) {
		return { kind: "incomplete", snapshot: settled.snapshot, reason: settledTerminalReason };
	}
	const headMoved = settled.snapshot.headSha !== snapshot.headSha;
	if (!headMoved && isMergeReady(settled.snapshot)) {
		observation.report({ kind: "merge-ready", phase: "fresh-status" });
		return { kind: "merge-ready", snapshot: settled.snapshot };
	}
	if (!isMergeabilityPending(settled.snapshot) && !onlyHeadVerificationPending(settled.snapshot)) {
		if (headMoved) {
			observation.report({
				kind: "head-moved",
				previousHeadSha: snapshot.headSha,
				nextHeadSha: settled.snapshot.headSha,
				phase: "verification",
			});
		} else {
			observation.report({ kind: "readiness-regressed", reason: describeBlockers(settled.snapshot) });
		}
		return { kind: "continue", snapshot: settled.snapshot };
	}
	if (headMoved) {
		observation.report({
			kind: "head-moved",
			previousHeadSha: snapshot.headSha,
			nextHeadSha: settled.snapshot.headSha,
			phase: "readiness",
		});
	}
	if (!poll) {
		const reason = describeBlockers(settled.snapshot);
		observation.report({ kind: "not-ready", reason });
		return { kind: "incomplete", snapshot: settled.snapshot, reason };
	}

	let previousHeadSha = settled.snapshot.headSha;
	let latest = settled.snapshot;
	while (observation.mergeabilityPolls < MERGEABILITY_POLL_LIMIT) {
		try {
			await observation.sleep(MERGEABILITY_POLL_DELAY_MS, observation.signal);
		} catch (error) {
			if (observation.signal.aborted) return { kind: "aborted", snapshot: latest };
			const reason = `Could not wait for mergeability: ${error instanceof Error ? error.message : String(error)}`;
			observation.report({ kind: "error", reason });
			return { kind: "failed", reason, snapshot: latest };
		}
		if (observation.signal.aborted) return { kind: "aborted", snapshot: latest };
		observation.mergeabilityPolls++;
		const next = await observe(observation, previousHeadSha, false);
		if (next.kind === "aborted") return { kind: "aborted", snapshot: latest };
		if (next.kind === "failed") {
			observation.report({ kind: "error", reason: next.reason });
			return { kind: "failed", reason: next.reason, snapshot: latest };
		}
		if (observation.signal.aborted) return { kind: "aborted", snapshot: next.snapshot };
		const polledTerminalReason = terminalPrReason(next.snapshot);
		if (polledTerminalReason) {
			observation.report({ kind: "not-ready", reason: polledTerminalReason });
			return { kind: "incomplete", snapshot: next.snapshot, reason: polledTerminalReason };
		}
		if (next.snapshot.headSha !== previousHeadSha) {
			observation.report({
				kind: "head-moved",
				previousHeadSha,
				nextHeadSha: next.snapshot.headSha,
				phase: "mergeability",
			});
		}
		if (isMergeReady(next.snapshot)) {
			observation.report({ kind: "merge-ready", phase: "mergeability" });
			return { kind: "merge-ready", snapshot: next.snapshot };
		}
		if (!isMergeabilityPending(next.snapshot) && !onlyHeadVerificationPending(next.snapshot)) {
			observation.report({ kind: "mergeability-regressed", reason: describeBlockers(next.snapshot) });
			return { kind: "continue", snapshot: next.snapshot };
		}
		previousHeadSha = next.snapshot.headSha;
		latest = next.snapshot;
	}

	const reason = `mergeability pending after ${MERGEABILITY_POLL_LIMIT} additional observations`;
	observation.report({ kind: "not-ready", reason });
	return { kind: "incomplete", snapshot: latest, reason };
}

export function createPrObservation(options: PrObservationOptions): PrObservationSession {
	const observation: PrObservation = { ...options, mergeabilityPolls: 0 };
	return {
		check: () => checkObservation(observation),
		refresh: () => observe(observation, null, true),
		settle: (snapshot, poll) => settleObservation(observation, snapshot, poll),
	};
}
