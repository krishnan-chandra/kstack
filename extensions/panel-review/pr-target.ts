/** Resolve a pinned GitHub PR target and materialize pinned commit snapshots. */

import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { getPullRequestReviewTarget, type PullRequestReviewTarget } from "../shared/github.ts";
import { isPathInside } from "./review-scope.ts";
import { materializeSnapshotFiles, planSnapshotFiles } from "./snapshot-files.ts";
import {
	openSnapshotObjectReader,
	readSnapshotTree,
	resolveSnapshotGitDir,
	type SnapshotObjectReader,
	type SnapshotProcessOptions,
} from "./snapshot-objects.ts";
import { LIMITS } from "./types.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;
const GIT_TIMEOUT_MS = 60_000;
const DIAGNOSTIC_BYTES = 8 * 1024;

export interface PrTarget {
	number: number;
	url: string;
	title: string;
	state: PullRequestReviewTarget["state"];
	headSha: string;
	baseRefName: string;
	mergeBaseSha: string;
}

export interface PrSnapshot {
	/** Directory exposed to read-only reviewer tools. */
	directory: string;
	/** Private temporary root removed after the review. */
	root: string;
}

interface MaterializePrSnapshotOptions {
	tmpDir?: string;
	signal?: AbortSignal;
	maxBlobBytes?: number;
	maxTrackedEntries?: number;
	maxTreeMetadataBytes?: number;
	objectProcess?: SnapshotProcessOptions;
}

function diagnostic(result: ExecFnResult): string {
	return (result.stderr || result.stdout).slice(0, DIAGNOSTIC_BYTES).trim();
}

/**
 * Refuse any extracted symlink that does not resolve to a path inside the
 * snapshot. The filesystem resolves chains, `..` through directory links, and
 * cycles with the same semantics reviewer reads will use. Dangling links are
 * refused too: without a real target there is no way to prove containment.
 */
async function assertSymlinksContained(directory: string, symlinkPaths: string[]): Promise<void> {
	if (symlinkPaths.length === 0) return;
	const root = await realpath(directory);
	for (const path of symlinkPaths) {
		let resolved: string;
		try {
			resolved = await realpath(join(directory, path));
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code === "ELOOP") throw new Error(`Commit snapshot symlink ${JSON.stringify(path)} contains a cycle.`);
			throw new Error(`Commit snapshot symlink ${JSON.stringify(path)} does not resolve to a snapshot file.`);
		}
		if (!isPathInside(root, resolved)) {
			throw new Error(`Commit snapshot symlink ${JSON.stringify(path)} escapes the snapshot root.`);
		}
	}
}

function git(
	exec: ExecFn,
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	timeout = GIT_TIMEOUT_MS,
): Promise<ExecFnResult> {
	return exec("git", args, { cwd, timeout, signal });
}

/**
 * Resolve a PR through `gh` and fetch its commits into the object store `exec`
 * addresses. `githubRepository` (`owner/name`) lets `gh` work from a jj
 * workspace whose directory has no Git remotes of its own.
 */
export async function resolvePrTarget(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	signal?: AbortSignal,
	githubRepository?: string,
): Promise<PrTarget> {
	if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
		throw new Error(`Invalid PR number: ${prNumber}`);
	}

	const pr = await getPullRequestReviewTarget(exec, cwd, prNumber, signal, {}, githubRepository);
	const validBase = await git(exec, cwd, ["check-ref-format", "--branch", pr.baseRef], signal, 10_000);
	if (validBase.code !== 0) {
		throw new Error(`PR base ref ${JSON.stringify(pr.baseRef)} is not a valid Git branch name.`);
	}

	// Empty refmap plus source-only refspecs fetches objects without updating
	// local or remote-tracking refs.
	const fetched = await git(
		exec,
		cwd,
		[
			"fetch",
			"--no-tags",
			"--no-write-fetch-head",
			"--refmap=",
			"origin",
			`refs/pull/${pr.number}/head`,
			`refs/heads/${pr.baseRef}`,
		],
		signal,
	);
	if (fetched.code !== 0) {
		throw new Error(`Could not fetch PR #${pr.number}: ${diagnostic(fetched)}`);
	}

	const headExists = await git(exec, cwd, ["cat-file", "-e", `${pr.headOid}^{commit}`], signal, 10_000);
	if (headExists.code !== 0) {
		throw new Error(
			`PR #${pr.number} head commit ${pr.headOid} was not found after fetch. The PR may have been force-pushed.`,
		);
	}
	const baseExists = await git(exec, cwd, ["cat-file", "-e", `${pr.baseOid}^{commit}`], signal, 10_000);
	if (baseExists.code !== 0) {
		throw new Error(`PR #${pr.number} base commit ${pr.baseOid} was not found after fetch.`);
	}

	const mergeBase = await git(exec, cwd, ["merge-base", pr.baseOid, pr.headOid], signal, 10_000);
	const mergeBaseSha = mergeBase.stdout.trim().toLowerCase();
	if (mergeBase.code !== 0 || !SHA_RE.test(mergeBaseSha)) {
		throw new Error(`Could not calculate merge base between ${pr.baseOid} and ${pr.headOid}: ${diagnostic(mergeBase)}`);
	}

	return {
		number: pr.number,
		url: pr.url,
		title: pr.title,
		state: pr.state,
		headSha: pr.headOid.toLowerCase(),
		baseRefName: pr.baseRef,
		mergeBaseSha,
	};
}

/** Materialize a pinned commit tree without creating a branch, worktree, or jj workspace. */
export async function materializePrSnapshot(
	exec: ExecFn,
	cwd: string,
	headSha: string,
	options: MaterializePrSnapshotOptions = {},
): Promise<PrSnapshot> {
	if (!SHA_RE.test(headSha)) throw new Error(`Invalid PR head SHA: ${headSha}`);

	const gitDir = await resolveSnapshotGitDir(exec, cwd, options.signal);
	const maxBlobBytes = options.maxBlobBytes ?? LIMITS.prSnapshotBytes;
	const maxTrackedEntries = options.maxTrackedEntries ?? LIMITS.prSnapshotFiles;
	const tree = await readSnapshotTree({
		gitDir,
		cwd,
		headSha,
		signal: options.signal,
		maxMetadataBytes: options.maxTreeMetadataBytes,
		maxBlobBytes,
		maxTrackedEntries,
		process: options.objectProcess,
	});
	const filePlan = planSnapshotFiles(tree.entries);

	const root = await mkdtemp(join(options.tmpDir ?? tmpdir(), "pi-panel-pr-"));
	const directory = join(root, "snapshot");
	let objects: SnapshotObjectReader | undefined;
	try {
		await mkdir(directory, { mode: 0o700 });
		await chmod(directory, 0o700);
		if (tree.entries.some((entry) => entry.objectType === "blob")) {
			objects = openSnapshotObjectReader({
				gitDir,
				cwd,
				signal: options.signal,
				process: options.objectProcess,
			});
		}
		const materialized = await materializeSnapshotFiles({ directory, plan: filePlan, objects });
		await objects?.finish();
		await assertSymlinksContained(directory, materialized.symlinkPaths);
		return { directory, root };
	} catch (error) {
		await objects?.abort();
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
