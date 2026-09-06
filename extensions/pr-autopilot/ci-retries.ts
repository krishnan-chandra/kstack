import type { CheckRun, FlakeRunRetry } from "./types.ts";

interface FlakeRunGroup extends FlakeRunRetry {
	jobNames: string[];
}

function retryIdentity(retry: FlakeRunRetry): string {
	return JSON.stringify([retry.runId, retry.headSha]);
}

export function deduplicateFlakeRunRetries(retries: readonly FlakeRunRetry[]): FlakeRunRetry[] {
	const seen = new Set<string>();
	const deduplicated: FlakeRunRetry[] = [];
	for (const retry of retries) {
		const identity = retryIdentity(retry);
		if (seen.has(identity)) continue;
		seen.add(identity);
		deduplicated.push({ runId: retry.runId, headSha: retry.headSha });
	}
	return deduplicated;
}

/** Group selected flake checks by the Actions run mutation they would trigger. */
export function groupFlakeRuns(checks: readonly CheckRun[], headSha: string): FlakeRunGroup[] {
	const groups = new Map<string, FlakeRunGroup>();
	for (const check of checks) {
		if (!check.runId) continue;
		let group = groups.get(check.runId);
		if (!group) {
			group = { runId: check.runId, headSha, jobNames: [] };
			groups.set(check.runId, group);
		}
		if (!group.jobNames.includes(check.name)) group.jobNames.push(check.name);
	}
	return [...groups.values()];
}

/**
 * Convert legacy name-and-head evidence into conservative run-and-head records.
 * One ambiguous legacy name consumes every matching run in the snapshot.
 */
export function reconcileLegacyFlakeRetries(options: {
	checks: readonly CheckRun[];
	headSha: string;
	legacyRetryKeys: readonly string[];
	runRetries: readonly FlakeRunRetry[];
}) {
	const legacyRetryKeys = new Set(options.legacyRetryKeys);
	const matchedLegacyKeys = new Set<string>();
	const matchedRunRetries: FlakeRunRetry[] = [];
	for (const group of groupFlakeRuns(options.checks, options.headSha)) {
		let matched = false;
		for (const name of group.jobNames) {
			const key = `${name}@${options.headSha}`;
			if (!legacyRetryKeys.has(key)) continue;
			matchedLegacyKeys.add(key);
			matched = true;
		}
		if (matched) matchedRunRetries.push({ runId: group.runId, headSha: group.headSha });
	}
	const runRetries = deduplicateFlakeRunRetries([...options.runRetries, ...matchedRunRetries]);
	const remainingLegacyRetryKeys = [...legacyRetryKeys].filter((key) => !matchedLegacyKeys.has(key));
	const runRetriesChanged = !sameFlakeRunRetries(options.runRetries, runRetries);
	const legacyKeysChanged =
		options.legacyRetryKeys.length !== remainingLegacyRetryKeys.length ||
		options.legacyRetryKeys.some((key, index) => key !== remainingLegacyRetryKeys[index]);
	return {
		runRetries,
		legacyRetryKeys: remainingLegacyRetryKeys,
		changed: runRetriesChanged || legacyKeysChanged,
	};
}

function sameFlakeRunRetries(left: readonly FlakeRunRetry[], right: readonly FlakeRunRetry[]): boolean {
	return (
		left.length === right.length &&
		left.every((retry, index) => retry.runId === right[index]?.runId && retry.headSha === right[index]?.headSha)
	);
}

export function pendingFlakeRunGroups(
	groups: readonly FlakeRunGroup[],
	runRetries: readonly FlakeRunRetry[],
): FlakeRunGroup[] {
	const retried = new Set(runRetries.map(retryIdentity));
	return groups.filter((group) => !retried.has(retryIdentity(group)));
}

export function appendFlakeRunRetry(runRetries: readonly FlakeRunRetry[], retry: FlakeRunRetry): FlakeRunRetry[] {
	return deduplicateFlakeRunRetries([...runRetries, retry]);
}
