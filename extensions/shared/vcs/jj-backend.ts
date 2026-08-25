import type { BoundaryValue } from "../validation.ts";
/** Jujutsu implementation of K-Stack's repository-mutation contract. */

import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import { extractSlug, MAX_SLUG_LENGTH } from "../slug.ts";
import type {
	CurrentRef,
	MergeBaseResult,
	VcsBackend,
	VcsResult,
	WorkstreamCheckpoint,
	WorkstreamSnapshot,
} from "./backend.ts";
import { preflightVcs } from "./preflight.ts";

const MAX_COLLISION_ATTEMPTS = 100;
const SHA_RE = /^[0-9a-f]{40}$/;
const COMMIT_ID_TEMPLATE = 'commit_id ++ "\\n"';
const CHANGE_ID_TEMPLATE = 'change_id ++ "\\n"';
const LOCAL_BOOKMARK_TEMPLATE = 'if(self.remote(), "", self.name() ++ "\\n")';
const BOOKMARK_TARGET_TEMPLATE =
	'if(self.remote(), "", self.name() ++ "\\t" ++ self.normal_target().commit_id() ++ "\\n")';

function failure(error: BoundaryValue): ExecFnResult {
	return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

function output(result: ExecFnResult): string {
	return result.stdout.trim();
}

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function diagnostic(result: ExecFnResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

/** Quote a literal cwd-relative path as an exact jj fileset expression. */
export function filesetPath(path: string): string {
	return `cwd:"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export class JjBackend implements VcsBackend {
	readonly id = "jj" as const;
	private readonly exec: ExecFn;

	constructor(exec: ExecFn) {
		this.exec = exec;
	}

	private async jj(cwd: string, args: string[], timeout = 10_000): Promise<ExecFnResult> {
		try {
			return await this.exec("jj", ["--no-pager", ...args], { cwd, timeout });
		} catch (error) {
			return failure(error);
		}
	}

	preflight(cwd: string): Promise<VcsResult<{ workspaceRoot: string }>> {
		return preflightVcs(cwd, this.id, this.exec);
	}

	async headSha(cwd: string): Promise<VcsResult<{ sha: string }>> {
		const result = await this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", COMMIT_ID_TEMPLATE], 5_000);
		const sha = output(result);
		return result.code === 0 && SHA_RE.test(sha)
			? { ok: true, sha }
			: { ok: false, error: `Could not resolve the current jj commit: ${diagnostic(result)}` };
	}

	async currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>> {
		const bookmarks = await this.localBookmarksAt(cwd, "@");
		if (!bookmarks.ok) return bookmarks;
		if (bookmarks.names.length === 1) return { ok: true, ref: { kind: "bookmark", name: bookmarks.names[0] } };
		if (bookmarks.names.length > 1) {
			return {
				ok: false,
				error: `The current jj commit has multiple bookmarks (${bookmarks.names.join(", ")}); K-Stack requires exactly one task bookmark.`,
			};
		}
		const change = await this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE], 5_000);
		const changeId = output(change);
		return change.code === 0 && changeId
			? { ok: true, ref: { kind: "no-bookmark", changeId } }
			: { ok: false, error: `Could not resolve the current jj change: ${diagnostic(change)}` };
	}

	async captureWorkstream(cwd: string): Promise<VcsResult<{ snapshot: WorkstreamSnapshot }>> {
		const [current, change, parents] = await Promise.all([
			this.currentRef(cwd),
			this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE], 5_000),
			this.jj(cwd, ["log", "-r", "parents(@)", "--no-graph", "-T", COMMIT_ID_TEMPLATE], 5_000),
		]);
		if (!current.ok) return current;
		if (current.ref.kind !== "bookmark") {
			return { ok: false, error: "The jj workstream has no unique bookmark on its current change." };
		}
		const changeId = output(change);
		if (change.code !== 0 || !changeId) {
			return { ok: false, error: `Could not resolve the current jj change identity: ${diagnostic(change)}` };
		}
		const parentCommitIds = lines(parents.stdout).sort();
		if (parents.code !== 0 || parentCommitIds.length === 0 || parentCommitIds.some((sha) => !SHA_RE.test(sha))) {
			return { ok: false, error: `Could not resolve the current jj parent commits: ${diagnostic(parents)}` };
		}
		return {
			ok: true,
			snapshot: {
				ref: current.ref.name,
				token: `${current.ref.name}@${changeId}/parents:${parentCommitIds.join(",")}`,
			},
		};
	}

	async assertWorkstreamUnchanged(cwd: string, expected: WorkstreamSnapshot): Promise<VcsResult> {
		const actual = await this.captureWorkstream(cwd);
		if (!actual.ok) return actual;
		return actual.snapshot.token === expected.token
			? { ok: true }
			: { ok: false, error: `The current workstream changed (expected ${expected.ref}). Refusing to publish.` };
	}

	async changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>> {
		const result = await this.jj(cwd, ["diff", "-r", "@", "--name-only"], 5_000);
		return result.code === 0
			? { ok: true, paths: lines(result.stdout) }
			: { ok: false, error: `Could not inspect jj working-copy changes: ${diagnostic(result)}` };
	}

	async isWorkingCopyEmpty(cwd: string): Promise<VcsResult<{ empty: boolean; details?: string }>> {
		const result = await this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", 'if(empty, "true", "false")'], 5_000);
		if (result.code !== 0) return { ok: false, error: `Could not inspect the jj working copy: ${diagnostic(result)}` };
		if (output(result) === "true") return { ok: true, empty: true };
		const summary = await this.jj(cwd, ["diff", "-r", "@", "--summary"], 5_000);
		return { ok: true, empty: false, ...(output(summary) ? { details: output(summary) } : undefined) };
	}

	async createWorkstream(cwd: string, task: string): Promise<VcsResult<WorkstreamCheckpoint>> {
		const trunk = await this.resolveOne(cwd, "trunk()");
		if (!trunk.ok) return { ok: false, error: `Could not create a jj workstream: ${trunk.error}` };
		const slug = extractSlug(task);
		for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
			const suffix = attempt === 1 ? "" : `-${attempt}`;
			const ref = `kstack/${slug.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
			const lookup = await this.jj(cwd, ["bookmark", "list", "--all-remotes", `exact:${ref}`, "-T", 'name ++ "\\n"']);
			if (lookup.code !== 0) return { ok: false, error: `Could not inspect jj bookmarks: ${diagnostic(lookup)}` };
			if (lines(lookup.stdout).length > 0) continue;
			const created = await this.jj(cwd, ["new", "trunk()", "-m", task]);
			if (created.code !== 0) return { ok: false, error: `jj new failed: ${diagnostic(created)}` };
			const bookmarked = await this.jj(cwd, ["bookmark", "create", ref, "-r", "@"]);
			if (bookmarked.code !== 0) {
				return {
					ok: false,
					error: `Created the jj change but could not create bookmark ${ref}: ${diagnostic(bookmarked)}. Inspect the current change before retrying.`,
				};
			}
			return { ok: true, ref, baseSha: trunk.sha };
		}
		return { ok: false, error: `Could not allocate a unique task bookmark after ${MAX_COLLISION_ATTEMPTS} attempts.` };
	}

	async verifyRecordedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>> {
		const target = await this.bookmarkTarget(cwd, expected.ref);
		if (!target.ok) return { ok: false, error: `Workstream postcondition failed: ${target.error}` };
		const ancestry = await this.jj(cwd, ["log", "-r", `${target.sha} & ::@`, "--no-graph", "-T", COMMIT_ID_TEMPLATE]);
		if (ancestry.code !== 0 || lines(ancestry.stdout).length !== 1) {
			return {
				ok: false,
				error: `Workstream postcondition failed: bookmark ${expected.ref} does not target an ancestor of the current change.`,
			};
		}
		if (expected.requireNewCommit) {
			const nonempty = await this.jj(cwd, [
				"log",
				"-r",
				`${expected.baseSha}..@ & ~empty()`,
				"--no-graph",
				"-T",
				COMMIT_ID_TEMPLATE,
			]);
			if (nonempty.code !== 0 || lines(nonempty.stdout).length === 0) {
				return { ok: false, error: "Workstream postcondition failed: implementation created no non-empty jj commit." };
			}
		}
		const clean = await this.isWorkingCopyEmpty(cwd);
		if (!clean.ok) return clean;
		if (!clean.empty) {
			return {
				ok: false,
				error: `Workstream postcondition failed: the jj working-copy commit is not empty.\n${clean.details ?? ""}`,
			};
		}
		const head = await this.headSha(cwd);
		return head.ok
			? { ok: true, headSha: head.sha }
			: { ok: false, error: `Workstream postcondition failed: ${head.error}` };
	}

	async recordPaths(cwd: string, paths: string[], message: string): Promise<VcsResult> {
		const result = await this.jj(cwd, ["commit", ...paths.map(filesetPath), "-m", message], 30_000);
		return result.code === 0 ? { ok: true } : { ok: false, error: `jj commit failed: ${diagnostic(result)}` };
	}

	async restorePaths(cwd: string, paths: string[]): Promise<VcsResult> {
		const result = await this.jj(cwd, ["restore", ...paths.map(filesetPath)]);
		return result.code === 0 ? { ok: true } : { ok: false, error: `jj restore failed: ${diagnostic(result)}` };
	}

	async publishRecordedChanges(cwd: string, ref: string, _options?: { existingOnly?: boolean }): Promise<VcsResult> {
		const description = await this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", 'description.first_line() ++ "\\n"']);
		if (description.code !== 0) {
			return { ok: false, error: `Could not inspect the current jj description: ${diagnostic(description)}` };
		}
		if (!output(description)) {
			const empty = await this.isWorkingCopyEmpty(cwd);
			if (!empty.ok) return empty;
			if (!empty.empty) {
				return {
					ok: false,
					error: "The current jj change is non-empty and has no description. Record or describe it before pushing.",
				};
			}
			const described = await this.jj(cwd, ["describe", "-m", `Automation checkpoint for ${ref}`]);
			if (described.code !== 0) {
				return { ok: false, error: `Could not describe the jj push checkpoint: ${diagnostic(described)}` };
			}
		}
		const moved = await this.jj(cwd, ["bookmark", "set", ref, "-r", "@"]);
		if (moved.code !== 0) {
			return { ok: false, error: `Could not move jj bookmark ${ref} to the current change: ${diagnostic(moved)}` };
		}
		const result = await this.jj(cwd, ["git", "push", "--remote", "origin", "--bookmark", ref], 60_000);
		return result.code === 0 ? { ok: true } : { ok: false, error: `jj git push failed: ${diagnostic(result)}` };
	}

	private async fetch(cwd: string, _ref?: string): Promise<VcsResult> {
		const result = await this.jj(cwd, ["git", "fetch", "--remote", "origin"], 60_000);
		return result.code === 0 ? { ok: true } : { ok: false, error: `jj git fetch failed: ${diagnostic(result)}` };
	}

	async fetchRemoteHead(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>> {
		const fetched = await this.fetch(cwd, ref);
		if (!fetched.ok) return fetched;
		const remote = await this.resolveOne(cwd, `${ref}@origin`);
		return remote.ok ? remote : { ok: false, error: `Could not resolve ${ref}@origin after fetch: ${remote.error}` };
	}

	async updateBase(cwd: string, baseRef: string): Promise<MergeBaseResult> {
		const fetched = await this.fetch(cwd, baseRef);
		if (!fetched.ok) return { kind: "failed", error: fetched.error };
		const remote = await this.resolveOne(cwd, `${baseRef}@origin`);
		if (!remote.ok) return { kind: "failed", error: `Could not resolve ${baseRef}@origin: ${remote.error}` };
		if (await this.isAncestorOfCurrent(cwd, remote.sha)) return { kind: "already-current" };
		const current = await this.currentRef(cwd);
		if (!current.ok || current.ref.kind !== "bookmark") {
			return { kind: "failed", error: "Cannot merge the base because the current jj change has no unique bookmark." };
		}
		const merged = await this.createMerge(cwd, `${baseRef}@origin`, `Merge ${baseRef}@origin`);
		if (!merged.ok) {
			return "files" in merged
				? { kind: "needs-human", files: merged.files, error: merged.error }
				: { kind: "failed", error: merged.error };
		}
		const moved = await this.jj(cwd, ["bookmark", "set", current.ref.name, "-r", "@"]);
		if (moved.code !== 0) {
			return {
				kind: "failed",
				error: `Merge succeeded but bookmark ${current.ref.name} could not be moved: ${diagnostic(moved)}`,
			};
		}
		const head = await this.headSha(cwd);
		return head.ok ? { kind: "clean", headSha: head.sha } : { kind: "failed", error: head.error };
	}

	private async localBookmarksAt(cwd: string, rev: string): Promise<VcsResult<{ names: string[] }>> {
		const result = await this.jj(cwd, ["bookmark", "list", "-r", rev, "-T", LOCAL_BOOKMARK_TEMPLATE], 5_000);
		return result.code === 0
			? { ok: true, names: lines(result.stdout) }
			: { ok: false, error: `Could not inspect jj bookmarks: ${diagnostic(result)}` };
	}

	private async bookmarkTarget(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>> {
		const result = await this.jj(cwd, ["bookmark", "list", `exact:${ref}`, "-T", BOOKMARK_TARGET_TEMPLATE], 5_000);
		if (result.code !== 0) return { ok: false, error: `Could not inspect bookmark ${ref}: ${diagnostic(result)}` };
		const match = lines(result.stdout)
			.map((line) => line.split("\t"))
			.find(([name]) => name === ref);
		const sha = match?.[1];
		return sha && SHA_RE.test(sha)
			? { ok: true, sha }
			: { ok: false, error: `bookmark ${ref} does not exist or has no single Git-backed target.` };
	}

	private async resolveOne(cwd: string, rev: string): Promise<VcsResult<{ sha: string }>> {
		const result = await this.jj(cwd, ["log", "-r", rev, "--no-graph", "-T", COMMIT_ID_TEMPLATE], 8_000);
		const ids = lines(result.stdout);
		return result.code === 0 && ids.length === 1 && SHA_RE.test(ids[0])
			? { ok: true, sha: ids[0] }
			: { ok: false, error: diagnostic(result) };
	}

	private async isAncestorOfCurrent(cwd: string, sha: string): Promise<boolean> {
		const result = await this.jj(cwd, ["log", "-r", `${sha} & ::@`, "--no-graph", "-T", COMMIT_ID_TEMPLATE], 8_000);
		return result.code === 0 && lines(result.stdout).length === 1;
	}

	private async createMerge(
		cwd: string,
		other: string,
		message: string,
	): Promise<VcsResult | { ok: false; error: string; files: string[] }> {
		const preMerge = await this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE]);
		const preMergeIds = lines(preMerge.stdout);
		if (preMerge.code !== 0 || preMergeIds.length !== 1) {
			return { ok: false, error: `Could not capture the pre-merge jj change: ${diagnostic(preMerge)}` };
		}

		const result = await this.jj(cwd, ["new", "@", other, "-m", message], 30_000);
		if (result.code !== 0) return { ok: false, error: `jj new merge failed: ${diagnostic(result)}` };
		const merge = await this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE]);
		const mergeIds = lines(merge.stdout);
		if (merge.code !== 0 || mergeIds.length !== 1) {
			return {
				ok: false,
				error: `Could not capture the jj merge change: ${diagnostic(merge)}. Run jj op log and jj op restore to recover.`,
			};
		}

		const conflict = await this.jj(cwd, ["log", "-r", "@", "--no-graph", "-T", 'if(conflict, "true", "false")']);
		if (conflict.code === 0 && output(conflict) === "false") return { ok: true };
		const listed = await this.jj(cwd, ["resolve", "--list"]);
		const files = lines(listed.stdout);
		const edited = await this.jj(cwd, ["edit", preMergeIds[0]]);
		if (edited.code !== 0) {
			return {
				ok: false,
				files,
				error: `Automatic jj merge recovery failed: ${diagnostic(edited)}. Run jj op log and jj op restore to recover.`,
			};
		}
		const abandoned = await this.jj(cwd, ["abandon", mergeIds[0]]);
		if (abandoned.code !== 0) {
			return {
				ok: false,
				files,
				error: `Automatic jj merge recovery failed: ${diagnostic(abandoned)}. Run jj op log and jj op restore to recover.`,
			};
		}
		return {
			ok: false,
			files,
			error:
				files.length > 0
					? `Merge conflicted in ${files.join(", ")}. Competing intents need a human.`
					: "The jj merge produced conflicts.",
		};
	}
}
