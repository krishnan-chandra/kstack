/**
 * Resolve the PR number a `/land` invocation should target.
 *
 * When the caller passes `--pr`, the number is used as-is. Otherwise the
 * current VCS ref (branch or jj bookmark) is looked up against GitHub's open
 * PR list by head ref. This module keeps the branching out of the thin
 * `index.ts` adapter so the error strings and fallback order are testable.
 */

import type { CurrentRef, VcsResult } from "../shared/vcs/backend.ts";

/* exported: implicit-PR resolution result contract */
export type PrResolution = { ok: true; prNumber: number } | { ok: false; message: string };

export async function resolveImplicitPr(deps: {
	explicitPr?: number;
	currentRef(): Promise<VcsResult<{ ref: CurrentRef }>>;
	findByHead(ref: string): Promise<number>;
}): Promise<PrResolution> {
	if (deps.explicitPr !== undefined) {
		return { ok: true, prNumber: deps.explicitPr };
	}
	const current = await deps.currentRef();
	if (!current.ok) {
		return { ok: false, message: current.error };
	}
	const ref = current.ref.kind === "branch" || current.ref.kind === "bookmark" ? current.ref.name : undefined;
	if (!ref) {
		const message =
			current.ref.kind === "no-bookmark"
				? `Current jj change ${current.ref.changeId.slice(0, 12)} has no bookmark. Create one with jj bookmark create <name> -r @, or pass --pr explicitly.`
				: "The current VCS state has no branch or bookmark; pass --pr explicitly.";
		return { ok: false, message };
	}
	try {
		const prNumber = await deps.findByHead(ref);
		return { ok: true, prNumber };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
