/**
 * Bounded parallel fan-out over reviewer specs.
 *
 * Results are returned in deterministic panel order (by spec index),
 * independent of completion order. One reviewer's failure never cancels
 * its siblings.
 */

import type { ReviewerResult, ReviewerSpec } from "./types.ts";

export type RunOne = (spec: ReviewerSpec, index: number) => Promise<ReviewerResult>;

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		for (;;) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface PanelRun {
	results: ReviewerResult[];
	completed: number;
	failed: number;
	aborted: number;
}

export async function runPanel(
	specs: ReviewerSpec[],
	maxConcurrency: number,
	runOne: RunOne,
): Promise<PanelRun> {
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
