/**
 * Bounded parallel fan-out over reviewer specs.
 *
 * Results are returned in deterministic panel order (by spec index),
 * independent of completion order. One reviewer's failure never cancels
 * its siblings.
 */

import { mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import type { ReviewerResult, ReviewerSpec } from "./types.ts";

export type RunOne = (spec: ReviewerSpec, index: number) => Promise<ReviewerResult>;

export interface PanelRun {
	results: ReviewerResult[];
	completed: number;
	failed: number;
	aborted: number;
}

export async function runPanel(specs: ReviewerSpec[], maxConcurrency: number, runOne: RunOne): Promise<PanelRun> {
	const results = await mapWithConcurrencyLimit(specs, maxConcurrency, async (spec, index) => {
		try {
			return await runOne(spec, index);
		} catch (err) {
			// A throwing runner must not take down siblings.
			const model = spec.thinking ? `${spec.model}:${spec.thinking}` : spec.model;
			return { status: "failed" as const, label: spec.label, model, error: (err as Error).message };
		}
	});
	return {
		results,
		completed: results.filter((r) => r.status === "completed").length,
		failed: results.filter((r) => r.status === "failed").length,
		aborted: results.filter((r) => r.status === "aborted").length,
	};
}
