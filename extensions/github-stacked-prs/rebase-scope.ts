/** Inspect and verify the local refs that Git may rewrite during stack landing. */

import { realpathSync } from "node:fs";
import { commandDiagnostic, type ExecFn, runCommand } from "../shared/git-exec.ts";
import { isSafeStackRef, STACK_SHA_RE } from "../shared/stack/manifest.ts";
import type { BoundaryValue } from "../shared/validation.ts";

const LOCAL_REF_PREFIX = "refs/heads/";
const LOCAL_REF_ROOT = "refs/heads";
const REF_FORMAT = "%(refname)%09%(objectname)";

/** A selected stack branch pinned to its local tip before a rebase. */
export interface RebaseScopeBranch {
	branch: string;
	sha: string;
}

export interface WorktreeRecord {
	path: string;
	head: string | undefined;
	branch: string | undefined;
}

interface RepositoryInventory {
	refs: ReadonlyMap<string, string>;
	worktrees: readonly WorktreeRecord[];
}

/** A validated snapshot of the refs and range that one landing rebase may update. */
export interface RebaseScopeSnapshot {
	frontierSha: string;
	remainder: readonly RebaseScopeBranch[];
	range: readonly string[];
	refs: ReadonlyMap<string, string>;
	initiatingWorktree: string;
}

type ScopeResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface RebaseScopeDeps {
	exec: ExecFn;
	signal?: AbortSignal;
	realpath?: (path: string) => string;
}

/**
 * Validate the exact local branch range that `git rebase --update-refs` may
 * rewrite. The caller skips this check when there is no remainder.
 */
export async function inspectRebaseScope(input: {
	cwd: string;
	frontierSha: string;
	remainder: readonly RebaseScopeBranch[];
	deps: RebaseScopeDeps;
}): Promise<ScopeResult<RebaseScopeSnapshot>> {
	if (!STACK_SHA_RE.test(input.frontierSha)) return { ok: false, error: "The landing frontier SHA is invalid." };
	if (input.remainder.length === 0) return { ok: false, error: "The landing rebase scope has no remainder." };
	const branchNames = new Set<string>();
	for (const item of input.remainder) {
		if (!isSafeStackRef(item.branch, true) || branchNames.has(item.branch) || !STACK_SHA_RE.test(item.sha)) {
			return { ok: false, error: "The landing remainder contains an invalid or duplicate branch pin." };
		}
		branchNames.add(item.branch);
	}

	const inventory = await readRepositoryInventory(input.cwd, input.deps);
	if (!inventory.ok) return inventory;
	for (const item of input.remainder) {
		const actual = inventory.value.refs.get(item.branch);
		if (actual !== item.sha) {
			return {
				ok: false,
				error: `Local branch ${item.branch} moved from pinned head ${item.sha} to ${actual ?? "missing"}.`,
			};
		}
	}

	const top = input.remainder.at(-1);
	if (!top) return { ok: false, error: "The landing rebase scope has no top branch." };
	const rangeName = `${input.frontierSha}..${top.sha}`;
	const ancestor = await runCommand(
		input.deps.exec,
		"git",
		["merge-base", "--is-ancestor", input.frontierSha, top.sha],
		input.cwd,
		input.deps.signal,
	);
	if (ancestor.code !== 0) {
		return {
			ok: false,
			error:
				ancestor.code === 1
					? `Top branch ${top.branch} does not descend from the pinned landing frontier.`
					: `Could not inspect landing rebase ancestry: ${commandDiagnostic(ancestor)}`,
		};
	}
	const commits = await runCommand(
		input.deps.exec,
		"git",
		["rev-list", "--reverse", rangeName],
		input.cwd,
		input.deps.signal,
	);
	if (commits.code !== 0) {
		return { ok: false, error: `Could not inspect the landing rebase range: ${commandDiagnostic(commits)}` };
	}
	const parsedRange = parseShaLines(commits.stdout);
	if (!parsedRange.ok || parsedRange.value.length === 0 || parsedRange.value.at(-1) !== top.sha) {
		return { ok: false, error: "Git returned an invalid or incomplete landing rebase range." };
	}
	const merges = await runCommand(
		input.deps.exec,
		"git",
		["rev-list", "--min-parents=2", rangeName],
		input.cwd,
		input.deps.signal,
	);
	if (merges.code !== 0) {
		return {
			ok: false,
			error: `Could not inspect merge commits in the landing rebase range: ${commandDiagnostic(merges)}`,
		};
	}
	if (merges.stdout.trim()) return { ok: false, error: "The landing rebase range contains a merge commit." };

	const positions = new Map(parsedRange.value.map((sha, index) => [sha, index]));
	let previousPosition = -1;
	for (const item of input.remainder) {
		const position = positions.get(item.sha);
		if (position === undefined) {
			return { ok: false, error: `Remaining stack branch ${item.branch} is outside the landing rewrite range.` };
		}
		if (position < previousPosition) {
			return { ok: false, error: `Remaining stack branch ${item.branch} is out of ancestry order.` };
		}
		previousPosition = position;
	}
	for (const [branch, sha] of inventory.value.refs) {
		if (positions.has(sha) && !branchNames.has(branch)) {
			return { ok: false, error: `Local branch ${branch} points inside the landing rewrite range.` };
		}
	}

	const worktree = validateRemainderWorktrees({
		cwd: input.cwd,
		remainder: input.remainder,
		worktrees: inventory.value.worktrees,
		realpath: input.deps.realpath,
	});
	if (!worktree.ok) return worktree;
	return {
		ok: true,
		value: {
			frontierSha: input.frontierSha,
			remainder: input.remainder.map((item) => ({ ...item })),
			range: parsedRange.value,
			refs: inventory.value.refs,
			initiatingWorktree: worktree.value,
		},
	};
}

/** Compare the confirmed semantic rewrite scope while allowing unrelated refs outside its range. */
export function matchesConfirmedRebaseScope(confirmed: RebaseScopeSnapshot, fresh: RebaseScopeSnapshot): boolean {
	if (confirmed.frontierSha !== fresh.frontierSha || confirmed.initiatingWorktree !== fresh.initiatingWorktree) {
		return false;
	}
	if (confirmed.range.length !== fresh.range.length || confirmed.remainder.length !== fresh.remainder.length)
		return false;
	return (
		confirmed.range.every((sha, index) => fresh.range[index] === sha) &&
		confirmed.remainder.every(
			(item, index) => fresh.remainder[index]?.branch === item.branch && fresh.remainder[index]?.sha === item.sha,
		)
	);
}

/** Verify ref stability and ordered ancestry after a successful local rebase. */
export async function verifyRebasedScope(input: {
	cwd: string;
	refreshedTrunkSha: string;
	before: RebaseScopeSnapshot;
	deps: RebaseScopeDeps;
}): Promise<ScopeResult<ReadonlyMap<string, string>>> {
	if (!STACK_SHA_RE.test(input.refreshedTrunkSha)) {
		return { ok: false, error: "The refreshed trunk SHA is invalid after rebase." };
	}
	const inventory = await readRepositoryInventory(input.cwd, input.deps);
	if (!inventory.ok) return inventory;
	const remainderNames = new Set(input.before.remainder.map((item) => item.branch));

	for (const [branch, oldSha] of input.before.refs) {
		const newSha = inventory.value.refs.get(branch);
		if (remainderNames.has(branch)) {
			if (!newSha) return { ok: false, error: `Rebased branch ${branch} is missing.` };
		} else if (!newSha) {
			return { ok: false, error: `Local branch ${branch} disappeared during rebase.` };
		} else if (newSha !== oldSha) {
			return { ok: false, error: `Local branch ${branch} moved from ${oldSha} to ${newSha} during rebase.` };
		}
	}
	for (const branch of inventory.value.refs.keys()) {
		if (!input.before.refs.has(branch)) {
			return { ok: false, error: `Unexpected local branch ${branch} appeared during rebase.` };
		}
	}

	const worktree = validateRemainderWorktrees({
		cwd: input.cwd,
		remainder: input.before.remainder,
		worktrees: inventory.value.worktrees,
		realpath: input.deps.realpath,
	});
	if (!worktree.ok) return worktree;
	if (worktree.value !== input.before.initiatingWorktree) {
		return { ok: false, error: "The initiating worktree changed identity during rebase." };
	}

	const top = input.before.remainder.at(-1);
	if (!top) return { ok: false, error: "The rebased remainder has no top branch." };
	const topSha = inventory.value.refs.get(top.branch);
	if (!topSha) return { ok: false, error: `Rebased branch ${top.branch} is missing.` };
	const ancestor = await runCommand(
		input.deps.exec,
		"git",
		["merge-base", "--is-ancestor", input.refreshedTrunkSha, topSha],
		input.cwd,
		input.deps.signal,
	);
	if (ancestor.code !== 0) {
		return {
			ok: false,
			error:
				ancestor.code === 1
					? `Rebased top branch ${top.branch} does not descend from refreshed trunk.`
					: `Could not verify rebased ancestry for ${top.branch}: ${commandDiagnostic(ancestor)}`,
		};
	}
	const commits = await runCommand(
		input.deps.exec,
		"git",
		["rev-list", "--reverse", `${input.refreshedTrunkSha}..${topSha}`],
		input.cwd,
		input.deps.signal,
	);
	if (commits.code !== 0) {
		return { ok: false, error: `Could not inspect rebased branch order: ${commandDiagnostic(commits)}` };
	}
	const parsedRange = parseShaLines(commits.stdout);
	if (!parsedRange.ok || parsedRange.value.at(-1) !== topSha) {
		return { ok: false, error: "Git returned an invalid rebased commit range." };
	}
	const positions = new Map(parsedRange.value.map((sha, index) => [sha, index]));
	const heads = new Map<string, string>();
	let previousPosition = -1;
	let previousName = "refreshed trunk";
	for (const item of input.before.remainder) {
		const sha = inventory.value.refs.get(item.branch);
		if (!sha) return { ok: false, error: `Rebased branch ${item.branch} is missing.` };
		const position = positions.get(sha);
		if (position === undefined || position < previousPosition) {
			return { ok: false, error: `Rebased branch ${item.branch} does not descend from ${previousName}.` };
		}
		heads.set(item.branch, sha);
		previousPosition = position;
		previousName = item.branch;
	}
	return { ok: true, value: heads };
}

async function readRepositoryInventory(cwd: string, deps: RebaseScopeDeps): Promise<ScopeResult<RepositoryInventory>> {
	const refsResult = await runCommand(
		deps.exec,
		"git",
		["for-each-ref", `--format=${REF_FORMAT}`, LOCAL_REF_ROOT],
		cwd,
		deps.signal,
	);
	if (refsResult.code !== 0) {
		return { ok: false, error: `Could not inventory local branches: ${commandDiagnostic(refsResult)}` };
	}
	const refs = parseRefs(refsResult.stdout);
	if (!refs.ok) return refs;

	const worktreesResult = await runCommand(
		deps.exec,
		"git",
		["worktree", "list", "--porcelain", "-z"],
		cwd,
		deps.signal,
	);
	if (worktreesResult.code !== 0) {
		return { ok: false, error: `Could not inventory Git worktrees: ${commandDiagnostic(worktreesResult)}` };
	}
	const worktrees = parseWorktrees(worktreesResult.stdout);
	if (!worktrees.ok) return worktrees;
	for (const worktree of worktrees.value) {
		if (!worktree.branch) continue;
		const tip = refs.value.get(worktree.branch);
		if (!tip || worktree.head !== tip) {
			return {
				ok: false,
				error: `Git returned inconsistent branch data for worktree ${JSON.stringify(worktree.path)}.`,
			};
		}
	}
	return { ok: true, value: { refs: refs.value, worktrees: worktrees.value } };
}

function parseRefs(stdout: string): ScopeResult<ReadonlyMap<string, string>> {
	if (!stdout) return { ok: false, error: "Git returned an empty local-branch inventory." };
	const lines = stdout.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0 || lines.some((line) => line.length === 0)) {
		return { ok: false, error: "Git returned an invalid local-branch inventory." };
	}
	const refs = new Map<string, string>();
	for (const line of lines) {
		const tab = line.indexOf("\t");
		if (tab <= LOCAL_REF_PREFIX.length || tab !== line.lastIndexOf("\t")) {
			return { ok: false, error: "Git returned an invalid local-branch record." };
		}
		const ref = line.slice(0, tab);
		const sha = line.slice(tab + 1);
		if (!ref.startsWith(LOCAL_REF_PREFIX) || !STACK_SHA_RE.test(sha)) {
			return { ok: false, error: "Git returned an invalid local-branch record." };
		}
		const branch = ref.slice(LOCAL_REF_PREFIX.length);
		if (!branch || refs.has(branch)) return { ok: false, error: "Git returned a duplicate local-branch record." };
		refs.set(branch, sha);
	}
	return { ok: true, value: refs };
}

export function parseWorktrees(stdout: string): ScopeResult<readonly WorktreeRecord[]> {
	if (!stdout?.endsWith("\0\0")) {
		return { ok: false, error: "Git returned an empty or unterminated worktree inventory." };
	}
	const chunks = stdout.slice(0, -2).split("\0\0");
	const records: WorktreeRecord[] = [];
	const paths = new Set<string>();
	for (const chunk of chunks) {
		const fields = chunk.split("\0");
		const first = fields.shift();
		if (!first?.startsWith("worktree ") || first.length === "worktree ".length) {
			return { ok: false, error: "Git returned an invalid worktree record." };
		}
		const path = first.slice("worktree ".length);
		if (paths.has(path)) return { ok: false, error: "Git returned duplicate worktree records." };
		paths.add(path);
		let head: string | undefined;
		let branch: string | undefined;
		let bare = false;
		let detached = false;
		for (const field of fields) {
			if (field.startsWith("HEAD ") && head === undefined) {
				head = field.slice("HEAD ".length);
			} else if (field.startsWith("branch ") && branch === undefined) {
				const ref = field.slice("branch ".length);
				if (!ref.startsWith(LOCAL_REF_PREFIX) || ref.length === LOCAL_REF_PREFIX.length) {
					return { ok: false, error: "Git returned an invalid worktree branch record." };
				}
				branch = ref.slice(LOCAL_REF_PREFIX.length);
			} else if (field === "bare" && !bare) {
				bare = true;
			} else if (field === "detached" && !detached) {
				detached = true;
			} else {
				const optionalAttribute =
					field === "locked" || field.startsWith("locked ") || field === "prunable" || field.startsWith("prunable ");
				if (!optionalAttribute) return { ok: false, error: "Git returned an invalid worktree record." };
			}
		}
		const stateCount = Number(branch !== undefined) + Number(bare) + Number(detached);
		if (stateCount !== 1 || (bare ? head !== undefined : !head || !STACK_SHA_RE.test(head))) {
			return { ok: false, error: "Git returned an incomplete worktree record." };
		}
		records.push({ path, head, branch });
	}
	if (records.length === 0) return { ok: false, error: "Git returned an empty worktree inventory." };
	return { ok: true, value: records };
}

function validateRemainderWorktrees(input: {
	cwd: string;
	remainder: readonly RebaseScopeBranch[];
	worktrees: readonly WorktreeRecord[];
	realpath?: (path: string) => string;
}): ScopeResult<string> {
	const top = input.remainder.at(-1);
	if (!top) return { ok: false, error: "The landing rebase scope has no top branch." };
	const middle = new Set(input.remainder.slice(0, -1).map((item) => item.branch));
	for (const worktree of input.worktrees) {
		if (worktree.branch && middle.has(worktree.branch)) {
			return {
				ok: false,
				error: `Remaining stack branch ${worktree.branch} is checked out in worktree ${JSON.stringify(worktree.path)}. Check out another branch there before landing.`,
			};
		}
	}

	const canonicalize = input.realpath ?? realpathSync;
	let canonicalCwd: string;
	try {
		canonicalCwd = canonicalize(input.cwd);
	} catch (error) {
		return { ok: false, error: `Could not canonicalize the initiating worktree: ${errorMessage(error)}` };
	}
	const topWorktrees = input.worktrees.filter((worktree) => worktree.branch === top.branch);
	if (topWorktrees.length === 0) {
		return { ok: false, error: `Top branch ${top.branch} must be checked out in the initiating worktree.` };
	}
	for (const worktree of topWorktrees) {
		let canonicalPath: string;
		try {
			canonicalPath = canonicalize(worktree.path);
		} catch (error) {
			return {
				ok: false,
				error: `Could not canonicalize worktree ${JSON.stringify(worktree.path)}: ${errorMessage(error)}`,
			};
		}
		if (canonicalPath !== canonicalCwd) {
			return {
				ok: false,
				error: `Top branch ${top.branch} is checked out in another worktree ${JSON.stringify(worktree.path)}. Run landing from that worktree.`,
			};
		}
	}
	return { ok: true, value: canonicalCwd };
}

function parseShaLines(stdout: string): ScopeResult<readonly string[]> {
	const lines = stdout.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	if (lines.some((line) => line.length === 0)) return { ok: false, error: "Git returned an invalid commit range." };
	const seen = new Set<string>();
	for (const sha of lines) {
		if (!STACK_SHA_RE.test(sha) || seen.has(sha)) {
			return { ok: false, error: "Git returned an invalid commit range." };
		}
		seen.add(sha);
	}
	return { ok: true, value: lines };
}

function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}
