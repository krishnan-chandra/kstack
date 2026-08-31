import type { VcsBackend, VcsResult, WorkstreamSnapshot } from "./backend.ts";
import { vcsPolicy } from "./policy.ts";

export interface MutationTarget {
	prNumber: number;
	headRef: string;
	headSha: string;
}

/** Evidence that the checkout matches the target and the rewrite scope is proven. */
export interface MutationCheckout {
	readonly snapshot: WorkstreamSnapshot;
	readonly affectedRefs: readonly string[];
}

type FixPublication = { kind: "pushed"; headSha?: string } | { kind: "unchanged" } | { kind: "failed"; error: string };

type BaseUpdateOutcome =
	| { kind: "published"; headSha: string }
	| { kind: "already-current" }
	| { kind: "precondition-failed"; error: string }
	| { kind: "needs-human"; files: string[]; error: string }
	| { kind: "failed"; error: string };

export interface PrMutation {
	openCheckout(cwd: string, target: MutationTarget): Promise<VcsResult<{ checkout: MutationCheckout }>>;
	publishFix(
		cwd: string,
		checkout: MutationCheckout,
		fix: { message: string; isForbiddenPath(path: string): boolean },
	): Promise<FixPublication>;
	updateBaseAndPublish(cwd: string, target: MutationTarget & { baseRef: string }): Promise<BaseUpdateOutcome>;
}

export function createPrMutation(backend: VcsBackend): PrMutation {
	const policy = vcsPolicy(backend.id);

	async function guardRewriteScope(
		cwd: string,
		headRef: string,
	): Promise<VcsResult<{ affectedRefs: readonly string[] }>> {
		const guarded = await backend.rewriteScope?.assertSingleRef(cwd, headRef);
		if (guarded && !guarded.ok) return guarded;
		return { ok: true, affectedRefs: guarded?.affectedRefs ?? [headRef] };
	}

	async function openCheckout(cwd: string, target: MutationTarget): Promise<VcsResult<{ checkout: MutationCheckout }>> {
		let captured: VcsResult<{ snapshot: WorkstreamSnapshot }>;
		if (backend.mutationWorkstream) {
			captured = await backend.mutationWorkstream.open(cwd, target.headRef, target.headSha);
		} else {
			const [current, head, clean] = await Promise.all([
				backend.currentRef(cwd),
				backend.headSha(cwd),
				backend.isWorkingCopyEmpty(cwd),
			]);
			if (!current.ok) return current;
			const refName = current.ref.kind === "branch" || current.ref.kind === "bookmark" ? current.ref.name : undefined;
			if (refName !== target.headRef) {
				const actual =
					current.ref.kind === "no-bookmark"
						? `jj change ${current.ref.changeId.slice(0, 12)} with no bookmark`
						: (refName ?? "a detached HEAD");
				return {
					ok: false,
					error: `Selected PR #${target.prNumber} uses ${target.headRef}, but the current workstream is ${actual}. Open the matching ${policy.workstreamNoun} before retrying.`,
				};
			}
			if (!head.ok || head.sha !== target.headSha) {
				return {
					ok: false,
					error: `Local HEAD ${head.ok ? head.sha : "could not be read"} does not match PR #${target.prNumber} head ${target.headSha}. Synchronize the PR worktree first.`,
				};
			}
			if (!clean.ok) return clean;
			if (!clean.empty) {
				return {
					ok: false,
					error: `The ${policy.workstreamNoun} must be clean before pr-autopilot can mutate it.`,
				};
			}
			captured = await backend.captureWorkstream(cwd);
		}
		if (!captured.ok) return captured;
		if (captured.snapshot.ref !== target.headRef) {
			return { ok: false, error: `The current workstream identity no longer names ${target.headRef}.` };
		}
		const remoteHead = await backend.fetchRemoteHead(cwd, target.headRef);
		if (!remoteHead.ok) return remoteHead;
		if (remoteHead.sha !== target.headSha) {
			return {
				ok: false,
				error: `The remote PR head advanced to ${remoteHead.sha}; refresh GitHub state before editing.`,
			};
		}
		const guarded = await guardRewriteScope(cwd, target.headRef);
		if (!guarded.ok) return guarded;
		return {
			ok: true,
			checkout: { snapshot: captured.snapshot, affectedRefs: guarded.affectedRefs },
		};
	}

	async function publishFix(
		cwd: string,
		checkout: MutationCheckout,
		fix: { message: string; isForbiddenPath(path: string): boolean },
	): Promise<FixPublication> {
		const [unchanged, changed] = await Promise.all([
			backend.assertWorkstreamUnchanged(cwd, checkout.snapshot),
			backend.changedPaths(cwd),
		]);
		if (!unchanged.ok) {
			return { kind: "failed", error: `The fixer changed workstream identity: ${unchanged.error}` };
		}
		if (!changed.ok) return { kind: "failed", error: `Could not inspect fixer changes: ${changed.error}` };
		const paths = changed.paths;
		if (paths.length === 0) return { kind: "unchanged" };

		const forbidden = paths.filter(fix.isForbiddenPath);
		if (forbidden.length > 0) {
			const restored = await backend.restorePaths(cwd, forbidden);
			return {
				kind: "failed",
				error: `Fixer touched forbidden paths: ${forbidden.join(", ")}.${restored.ok ? " Those changes were restored." : ` Automatic restoration failed: ${restored.error}`}`,
			};
		}
		const guarded = await guardRewriteScope(cwd, checkout.snapshot.ref);
		if (!guarded.ok) return { kind: "failed", error: guarded.error };

		const recorded = await backend.recordPaths(cwd, paths, fix.message);
		if (!recorded.ok) return { kind: "failed", error: recorded.error };
		const published = await backend.publishRecordedChanges(cwd, checkout.snapshot.ref, { existingOnly: true });
		if (!published.ok) return { kind: "failed", error: published.error };
		const head = backend.mutationWorkstream
			? await backend.mutationWorkstream.publishedHeadSha(cwd, checkout.snapshot.ref)
			: await backend.headSha(cwd);
		return head.ok ? { kind: "pushed", headSha: head.sha } : { kind: "pushed" };
	}

	async function updateBaseAndPublish(
		cwd: string,
		target: MutationTarget & { baseRef: string },
	): Promise<BaseUpdateOutcome> {
		const opened = await openCheckout(cwd, target);
		if (!opened.ok) return { kind: "precondition-failed", error: opened.error };
		const updated = await backend.updateBase(cwd, target.baseRef);
		switch (updated.kind) {
			case "already-current":
				return { kind: "already-current" };
			case "needs-human":
				return updated;
			case "failed":
				return updated;
			case "clean": {
				const guarded = await guardRewriteScope(cwd, target.headRef);
				if (!guarded.ok) return { kind: "failed", error: guarded.error };
				const published = await backend.publishRecordedChanges(cwd, target.headRef, { existingOnly: true });
				if (!published.ok) {
					return { kind: "failed", error: `Could not publish the updated base: ${published.error}` };
				}
				return { kind: "published", headSha: updated.headSha };
			}
			default: {
				const _exhaustive: never = updated;
				return _exhaustive;
			}
		}
	}

	return { openCheckout, publishFix, updateBaseAndPublish };
}
