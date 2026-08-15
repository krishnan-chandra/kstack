import type { FrontierResult, LandResult } from "./types.ts";

function prPhrase(numbers: readonly number[]): string {
	const labels = numbers.map((number) => `#${number}`);
	if (labels.length === 1) return `PR ${labels[0]}`;
	if (labels.length === 2) return `PRs ${labels[0]} and ${labels[1]}`;
	return `PRs ${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function outcomePhrase(item: FrontierResult): string {
	switch (item.state) {
		case "landed":
			return `#${item.prNumber} merged`;
		case "queued":
			return `#${item.prNumber} accepted, waiting for GitHub`;
		case "blocked":
			return `#${item.prNumber} blocked`;
		case "not-attempted":
			return `#${item.prNumber} not attempted`;
		default: {
			const _exhaustive: never = item.state;
			return _exhaustive;
		}
	}
}

/**
 * Collapsed Land card: name the pull requests and what happened to them.
 * Do not say "frontier".
 */
export function summarizeLandResult(result: LandResult): string {
	const items = result.frontiers;
	const numbers = items.map((item) => item.prNumber);
	const mixed = items.length > 1 && items.some((item) => item.state !== items[0].state);
	if (mixed) return `${items.map(outcomePhrase).join(". ")}.`;

	switch (result.status) {
		case "landed":
			return items.length === 0 ? "Landed." : `Landed ${prPhrase(numbers)}.`;
		case "partially-landed":
			if (items.length === 0) return "GitHub accepted the merge, but it is not verified yet.";
			if (items.every((item) => item.state === "queued")) {
				return `GitHub accepted ${prPhrase(numbers)}. Waiting to verify the merge.`;
			}
			return `${items.map(outcomePhrase).join(". ")}.`;
		case "declined":
			return items.length === 0 ? "Declined landing." : `Declined landing ${prPhrase(numbers)}.`;
		case "aborted":
			return items.length === 0 ? "Aborted landing." : `Aborted landing ${prPhrase(numbers)}.`;
		case "failed":
			return items.length === 0 ? "Failed to land." : `Failed to land ${prPhrase(numbers)}.`;
		case "blocked":
			return items.length === 0 ? "Did not land a pull request." : `Did not land ${prPhrase(numbers)}.`;
		default: {
			const _exhaustive: never = result.status;
			return _exhaustive;
		}
	}
}
