/**
 * PR observation and readiness: fetch handling, head verification,
 * reconciliation, and the run-wide settling budget.
 *
 * The driver remains the durable Autopilot-state owner. It applies returned
 * persisted state and supplies the save/notify/sleep ports. This module does
 * not own publication results, CI rerun attempts, or reply mutations.
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

type ReadPrSnapshot = (verifiedHeadSha: string | null, persisted: AutopilotPersistedState) => Promise<PRState | string>;

interface PrObservation {
	read: ReadPrSnapshot;
	sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
	save: (state: AutopilotPersistedState) => Promise<void>;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	signal: AbortSignal;
	persistWritesBlocked: boolean;
	prNumber: number;
	mergeabilityPolls: number;
}

type Observed =
	| { kind: "aborted"; persisted: AutopilotPersistedState }
	| { kind: "failed"; reason: string; persisted: AutopilotPersistedState }
	| { kind: "ok"; snapshot: PRState; persisted: AutopilotPersistedState };

type CheckResult =
	| { kind: "aborted"; snapshot?: PRState; persisted: AutopilotPersistedState }
	| {
			kind: "failed";
			reason: string;
			snapshot?: PRState;
			persisted: AutopilotPersistedState;
			announce: boolean;
	  }
	| { kind: "incomplete"; snapshot: PRState; reason: string; persisted: AutopilotPersistedState }
	| { kind: "merge-ready"; snapshot: PRState; persisted: AutopilotPersistedState };

type SettleResult =
	| { kind: "aborted"; snapshot?: PRState; persisted: AutopilotPersistedState }
	| { kind: "failed"; reason: string; snapshot?: PRState; persisted: AutopilotPersistedState }
	| { kind: "incomplete"; snapshot: PRState; reason: string; persisted: AutopilotPersistedState }
	| { kind: "merge-ready"; snapshot: PRState; persisted: AutopilotPersistedState }
	| { kind: "continue"; snapshot: PRState; persisted: AutopilotPersistedState };

type HeadMovePhase = "verification" | "readiness" | "mergeability";

function failedObserved(reason: string, persisted: AutopilotPersistedState): Observed {
	return { kind: "failed", reason, persisted };
}

function abortedObserved(persisted: AutopilotPersistedState): Observed {
	return { kind: "aborted", persisted };
}

function onlyHeadVerificationPending(snapshot: PRState): boolean {
	return snapshot.verifiedHeadSha !== snapshot.headSha && isMergeReadyIgnoringHeadVerification(snapshot);
}

function headMovedNotice(prNumber: number, previousHeadSha: string, nextHeadSha: string, phase: HeadMovePhase): string {
	const from = previousHeadSha.slice(0, 8);
	const to = nextHeadSha.slice(0, 8);
	switch (phase) {
		case "verification":
			return `PR #${prNumber} advanced from ${from} to ${to} during verification; rechecking.`;
		case "readiness":
			return `PR #${prNumber} advanced from ${from} to ${to} while readiness was settling; verifying the new head.`;
		case "mergeability":
			return `PR #${prNumber} advanced from ${from} to ${to} while mergeability was settling; verifying the new head.`;
		default: {
			const _exhaustive: never = phase;
			return _exhaustive;
		}
	}
}

async function reconcileSnapshot(
	observation: PrObservation,
	input: {
		snapshot: PRState;
		persisted: AutopilotPersistedState;
		reconcilePendingReplies: boolean;
	},
): Promise<AutopilotPersistedState> {
	const retries = reconcileLegacyFlakeRetries({
		checks: input.snapshot.checks,
		headSha: input.snapshot.headSha,
		legacyRetryKeys: input.persisted.flakeRetried,
		runRetries: input.persisted.flakeRunRetries,
	});
	let persisted = input.persisted;
	if (retries.changed) {
		persisted = {
			...persisted,
			flakeRetried: retries.legacyRetryKeys,
			flakeRunRetries: retries.runRetries,
		};
		if (!observation.persistWritesBlocked) await observation.save(persisted);
	}
	if (observation.persistWritesBlocked || !input.reconcilePendingReplies) return persisted;
	const reconciled = reconcileLegacyPendingReplyIds(persisted.legacyPendingReplyIds, input.snapshot.threads);
	if (reconciled.length === persisted.legacyPendingReplyIds.length) return persisted;
	persisted = { ...persisted, legacyPendingReplyIds: reconciled };
	await observation.save(persisted);
	return persisted;
}

async function observe(
	observation: PrObservation,
	input: {
		verifiedHeadSha: string | null;
		persisted: AutopilotPersistedState;
		reconcilePendingReplies: boolean;
	},
): Promise<Observed> {
	const fetched = await observation.read(input.verifiedHeadSha, input.persisted);
	if (observation.signal.aborted) return abortedObserved(input.persisted);
	if (isString(fetched)) return failedObserved(fetched, input.persisted);
	return {
		kind: "ok",
		snapshot: fetched,
		persisted: await reconcileSnapshot(observation, {
			snapshot: fetched,
			persisted: input.persisted,
			reconcilePendingReplies: input.reconcilePendingReplies,
		}),
	};
}

export function createPrObservation(options: Omit<PrObservation, "mergeabilityPolls">): PrObservation {
	return { ...options, mergeabilityPolls: 0 };
}

export async function checkObservation(
	observation: PrObservation,
	persisted: AutopilotPersistedState,
): Promise<CheckResult> {
	const first = await observe(observation, {
		verifiedHeadSha: null,
		persisted,
		reconcilePendingReplies: true,
	});
	if (first.kind === "aborted") return { kind: "aborted", persisted: first.persisted };
	if (first.kind === "failed") {
		return { kind: "failed", reason: first.reason, persisted: first.persisted, announce: true };
	}
	if (observation.signal.aborted) {
		return { kind: "aborted", snapshot: first.snapshot, persisted: first.persisted };
	}
	const firstTerminalReason = terminalPrReason(first.snapshot);
	const second = await observe(observation, {
		verifiedHeadSha: first.snapshot.headSha,
		persisted: first.persisted,
		reconcilePendingReplies: false,
	});
	if (second.kind === "aborted") {
		return { kind: "aborted", snapshot: first.snapshot, persisted: second.persisted };
	}
	if (second.kind === "failed") {
		return {
			kind: "failed",
			reason: second.reason,
			snapshot: first.snapshot,
			persisted: second.persisted,
			announce: false,
		};
	}
	const snapshot = second.snapshot;
	const terminalReason = firstTerminalReason ?? terminalPrReason(snapshot);
	if (terminalReason) {
		return { kind: "incomplete", snapshot, reason: terminalReason, persisted: second.persisted };
	}
	if (isMergeReady(snapshot)) {
		return { kind: "merge-ready", snapshot, persisted: second.persisted };
	}
	return {
		kind: "incomplete",
		snapshot,
		reason: describeBlockers(snapshot),
		persisted: second.persisted,
	};
}

export function refreshObservation(observation: PrObservation, persisted: AutopilotPersistedState): Promise<Observed> {
	return observe(observation, {
		verifiedHeadSha: null,
		persisted,
		reconcilePendingReplies: true,
	});
}

export async function settleObservation(
	observation: PrObservation,
	snapshot: PRState,
	persisted: AutopilotPersistedState,
	settleOptions: { poll: boolean },
): Promise<SettleResult> {
	const settled = await observe(observation, {
		verifiedHeadSha: snapshot.headSha,
		persisted,
		reconcilePendingReplies: false,
	});
	if (settled.kind === "aborted") return { kind: "aborted", persisted: settled.persisted };
	if (settled.kind === "failed") {
		observation.notify(settled.reason, "error");
		return { kind: "failed", reason: settled.reason, persisted: settled.persisted };
	}
	if (observation.signal.aborted) {
		return { kind: "aborted", snapshot: settled.snapshot, persisted: settled.persisted };
	}
	const settledTerminalReason = terminalPrReason(settled.snapshot);
	if (settledTerminalReason) {
		return {
			kind: "incomplete",
			snapshot: settled.snapshot,
			reason: settledTerminalReason,
			persisted: settled.persisted,
		};
	}
	const headMoved = settled.snapshot.headSha !== snapshot.headSha;
	if (!headMoved && isMergeReady(settled.snapshot)) {
		observation.notify(`PR #${observation.prNumber} looks merge-ready after a fresh status read. Not merging.`, "info");
		return { kind: "merge-ready", snapshot: settled.snapshot, persisted: settled.persisted };
	}
	if (!isMergeabilityPending(settled.snapshot) && !onlyHeadVerificationPending(settled.snapshot)) {
		if (headMoved) {
			observation.notify(
				headMovedNotice(observation.prNumber, snapshot.headSha, settled.snapshot.headSha, "verification"),
				"warning",
			);
		} else {
			observation.notify(
				`PR #${observation.prNumber} looked ready, then the settle re-read showed: ${describeBlockers(settled.snapshot)}.`,
				"warning",
			);
		}
		return { kind: "continue", snapshot: settled.snapshot, persisted: settled.persisted };
	}
	if (headMoved) {
		observation.notify(
			headMovedNotice(observation.prNumber, snapshot.headSha, settled.snapshot.headSha, "readiness"),
			"warning",
		);
	}
	if (!settleOptions.poll) {
		const reason = describeBlockers(settled.snapshot);
		observation.notify(`PR #${observation.prNumber} is not ready: ${reason}.`, "warning");
		return { kind: "incomplete", snapshot: settled.snapshot, reason, persisted: settled.persisted };
	}

	let previousHeadSha = settled.snapshot.headSha;
	let latest = settled;
	while (observation.mergeabilityPolls < MERGEABILITY_POLL_LIMIT) {
		try {
			await observation.sleep(MERGEABILITY_POLL_DELAY_MS, observation.signal);
		} catch (error) {
			if (observation.signal.aborted) {
				return { kind: "aborted", snapshot: latest.snapshot, persisted: latest.persisted };
			}
			const reason = `Could not wait for mergeability: ${error instanceof Error ? error.message : String(error)}`;
			observation.notify(reason, "error");
			return { kind: "failed", reason, snapshot: latest.snapshot, persisted: latest.persisted };
		}
		if (observation.signal.aborted) {
			return { kind: "aborted", snapshot: latest.snapshot, persisted: latest.persisted };
		}
		observation.mergeabilityPolls++;
		const next = await observe(observation, {
			verifiedHeadSha: previousHeadSha,
			persisted: latest.persisted,
			reconcilePendingReplies: false,
		});
		if (next.kind === "aborted") {
			return { kind: "aborted", snapshot: latest.snapshot, persisted: next.persisted };
		}
		if (next.kind === "failed") {
			observation.notify(next.reason, "error");
			return { kind: "failed", reason: next.reason, snapshot: latest.snapshot, persisted: next.persisted };
		}
		if (observation.signal.aborted) {
			return { kind: "aborted", snapshot: next.snapshot, persisted: next.persisted };
		}
		const polledTerminalReason = terminalPrReason(next.snapshot);
		if (polledTerminalReason) {
			observation.notify(`PR #${observation.prNumber} is not ready: ${polledTerminalReason}.`, "warning");
			return {
				kind: "incomplete",
				snapshot: next.snapshot,
				reason: polledTerminalReason,
				persisted: next.persisted,
			};
		}
		if (next.snapshot.headSha !== previousHeadSha) {
			observation.notify(
				headMovedNotice(observation.prNumber, previousHeadSha, next.snapshot.headSha, "mergeability"),
				"warning",
			);
		}
		if (isMergeReady(next.snapshot)) {
			observation.notify(
				`PR #${observation.prNumber} looks merge-ready after mergeability settled. Not merging.`,
				"info",
			);
			return { kind: "merge-ready", snapshot: next.snapshot, persisted: next.persisted };
		}
		if (!isMergeabilityPending(next.snapshot) && !onlyHeadVerificationPending(next.snapshot)) {
			observation.notify(
				`PR #${observation.prNumber} changed while mergeability was settling: ${describeBlockers(next.snapshot)}.`,
				"warning",
			);
			return { kind: "continue", snapshot: next.snapshot, persisted: next.persisted };
		}
		previousHeadSha = next.snapshot.headSha;
		latest = next;
	}

	const reason = `mergeability pending after ${MERGEABILITY_POLL_LIMIT} additional observations`;
	observation.notify(`PR #${observation.prNumber} is not ready: ${reason}.`, "warning");
	return { kind: "incomplete", snapshot: latest.snapshot, reason, persisted: latest.persisted };
}
