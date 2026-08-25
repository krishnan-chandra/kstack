/** Resolve a pinned GitHub PR target and materialize a temporary source snapshot. */

import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { getPullRequestReviewTarget, type PullRequestReviewTarget } from "../shared/github.ts";
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
	maxArchiveBytes?: number;
}

function diagnostic(result: ExecFnResult): string {
	return (result.stderr || result.stdout).slice(0, DIAGNOSTIC_BYTES).trim();
}

function inspectTree(stdout: string) {
	let blobBytes = 0;
	let trackedEntries = 0;
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const match = /^(\d{6}) ([a-z]+) (\d+|-)$/.exec(line);
		if (!match) throw new Error("Git returned invalid PR tree metadata.");
		const [, mode, objectType, rawSize] = match;
		if (mode === "120000") {
			throw new Error("PR snapshot contains symbolic links; review refused because they can escape the snapshot root.");
		}
		trackedEntries++;
		if (objectType !== "blob") continue;
		if (rawSize === "-") throw new Error("Git returned an invalid PR blob size.");
		const size = Number(rawSize);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git returned an invalid PR tree size.");
		blobBytes += size;
		if (!Number.isSafeInteger(blobBytes)) throw new Error("The PR tree is too large to measure safely.");
	}
	return { blobBytes, trackedEntries };
}

function assertLimit(name: string, actual: number, maximum: number): void {
	if (actual > maximum) throw new Error(`PR snapshot ${name} (${actual}) exceeds the limit (${maximum}).`);
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

export async function resolvePrTarget(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<PrTarget> {
	if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
		throw new Error(`Invalid PR number: ${prNumber}`);
	}

	const pr = await getPullRequestReviewTarget(exec, cwd, prNumber, signal);
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

/** Extract the pinned PR tree without creating a branch, worktree, or jj workspace. */
export async function materializePrSnapshot(
	exec: ExecFn,
	cwd: string,
	headSha: string,
	options: MaterializePrSnapshotOptions = {},
): Promise<PrSnapshot> {
	if (!SHA_RE.test(headSha)) throw new Error(`Invalid PR head SHA: ${headSha}`);

	const tree = await git(
		exec,
		cwd,
		["ls-tree", "-r", "--format=%(objectmode) %(objecttype) %(objectsize)", headSha],
		options.signal,
	);
	if (tree.code !== 0) throw new Error(`Could not inspect PR head ${headSha}: ${diagnostic(tree)}`);
	const size = inspectTree(tree.stdout);
	assertLimit("tracked blob bytes", size.blobBytes, options.maxBlobBytes ?? LIMITS.prSnapshotBytes);
	// This counts every recursive tracked entry, including gitlinks, not only blobs.
	assertLimit("tracked entries", size.trackedEntries, options.maxTrackedEntries ?? LIMITS.prSnapshotFiles);

	const root = await mkdtemp(join(options.tmpDir ?? tmpdir(), "pi-panel-pr-"));
	const directory = join(root, "snapshot");
	const archivePath = join(root, "tree.tar");
	await mkdir(directory, { mode: 0o700 });
	try {
		const archived = await git(
			exec,
			cwd,
			["archive", "--format=tar", `--output=${archivePath}`, headSha],
			options.signal,
		);
		if (archived.code !== 0) throw new Error(`Could not archive PR head ${headSha}: ${diagnostic(archived)}`);
		const archiveBytes = (await stat(archivePath)).size;
		const maxArchiveBytes = options.maxArchiveBytes ?? LIMITS.prSnapshotBytes;
		assertLimit("archive bytes", archiveBytes, maxArchiveBytes);

		const extracted = await exec("tar", ["-xf", archivePath, "-C", directory], {
			cwd: directory,
			timeout: GIT_TIMEOUT_MS,
			signal: options.signal,
		});
		if (extracted.code !== 0) throw new Error(`Could not extract PR head ${headSha}: ${diagnostic(extracted)}`);
		await rm(archivePath, { force: true });
		return { directory, root };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
