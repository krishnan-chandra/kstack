/** Provider-neutral stack manifest parsing and immutable Git-fact verification. */

import { commandDiagnostic, type ExecFn, runCommand } from "../git-exec.ts";
import { isRecord } from "../narrow.ts";
import { type BoundaryValue, isString, type JsonObject } from "../validation.ts";

export const MAX_STACK_SLICES = 50;
const MAX_STACK_REF_CHARS = 240;
export const MAX_STACK_SUBJECT_CHARS = 240;
export const STACK_SHA_RE = /^[0-9a-f]{40}$/;
export const OWNED_STACK_REF_RE = /^kstack\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface StackManifestSlice {
	branch: string;
	baseBranch: string;
	headSha: string;
	subject: string;
}

export interface StackManifest {
	schemaVersion: 1;
	trunkRef: string;
	trunkSha: string;
	slices: readonly StackManifestSlice[];
}

type StackManifestParseResult = { ok: true; manifest: StackManifest } | { ok: false; error: string };

export interface VerifiedStackManifest {
	repositoryRoot: string;
	manifest: StackManifest;
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function isSafeStackRef(value: BoundaryValue, owned = false): value is string {
	if (!isString(value) || value.length === 0 || value.length > MAX_STACK_REF_CHARS) return false;
	if (!(owned ? OWNED_STACK_REF_RE : SAFE_REF_RE).test(value)) return false;
	return !value.includes("..") && !value.includes("//") && !value.endsWith(".") && !value.endsWith(".lock");
}

/** Parse bounded stack evidence. Providers still verify every field against local Git. */
export function parseStackManifest(raw: string): StackManifestParseResult {
	let value: BoundaryValue;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, error: "Stack manifest is not valid JSON." };
	}
	if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "trunkRef", "trunkSha", "slices"])) {
		return { ok: false, error: "Stack manifest must contain only schemaVersion, trunkRef, trunkSha, and slices." };
	}
	if (value.schemaVersion !== 1 || !isSafeStackRef(value.trunkRef) || !STACK_SHA_RE.test(String(value.trunkSha))) {
		return { ok: false, error: "Stack manifest has an unsupported schema or invalid trunk." };
	}
	if (!Array.isArray(value.slices) || value.slices.length === 0 || value.slices.length > MAX_STACK_SLICES) {
		return { ok: false, error: `Stack manifest must contain 1-${MAX_STACK_SLICES} slices.` };
	}
	const slices: StackManifestSlice[] = [];
	const seen = new Set<string>();
	for (const candidate of value.slices) {
		if (!isRecord(candidate) || !exactKeys(candidate, ["branch", "baseBranch", "headSha", "subject"])) {
			return { ok: false, error: "Every stack slice must contain only branch, baseBranch, headSha, and subject." };
		}
		if (
			!isSafeStackRef(candidate.branch, true) ||
			!isSafeStackRef(candidate.baseBranch) ||
			!STACK_SHA_RE.test(String(candidate.headSha)) ||
			!isString(candidate.subject) ||
			candidate.subject.trim().length === 0 ||
			candidate.subject.length > MAX_STACK_SUBJECT_CHARS ||
			/[\0\r\n]/.test(candidate.subject) ||
			seen.has(candidate.branch)
		) {
			return { ok: false, error: "Stack manifest has invalid or duplicate slice fields." };
		}
		seen.add(candidate.branch);
		slices.push({
			branch: candidate.branch,
			baseBranch: candidate.baseBranch,
			headSha: String(candidate.headSha),
			subject: candidate.subject,
		});
	}
	if (slices[0].baseBranch !== value.trunkRef) {
		return { ok: false, error: "The first stack slice must be based on trunk." };
	}
	for (let index = 1; index < slices.length; index++) {
		if (slices[index].baseBranch !== slices[index - 1].branch) {
			return { ok: false, error: "Stack manifest slices must form a linear base chain." };
		}
	}
	return {
		ok: true,
		manifest: { schemaVersion: 1, trunkRef: value.trunkRef, trunkSha: String(value.trunkSha), slices },
	};
}

/** Verify the immutable Git facts shared by manifest-based stack providers. */
export async function verifyStackManifestGitFacts(
	cwd: string,
	manifest: StackManifest,
	exec: ExecFn,
	providerLabel: string,
	signal?: AbortSignal,
): Promise<{ ok: true; stack: VerifiedStackManifest } | { ok: false; error: string }> {
	const root = await runCommand(exec, "git", ["rev-parse", "--show-toplevel"], cwd, signal);
	const repositoryRoot = root.stdout.trim();
	if (root.code !== 0 || !repositoryRoot) {
		return { ok: false, error: `Could not resolve the Git root: ${commandDiagnostic(root)}` };
	}
	const clean = await runCommand(
		exec,
		"git",
		["status", "--porcelain=v1", "--untracked-files=all"],
		repositoryRoot,
		signal,
	);
	if (clean.code !== 0 || clean.stdout.trim()) {
		return { ok: false, error: `${providerLabel} stack publication requires a clean working tree.` };
	}
	const top = manifest.slices.at(-1);
	if (!top) return { ok: false, error: "Stack manifest has no slices." };
	const current = await runCommand(exec, "git", ["branch", "--show-current"], repositoryRoot, signal);
	if (current.code !== 0 || current.stdout.trim() !== top.branch) {
		return { ok: false, error: `The manifest top ${top.branch} must be checked out before publication.` };
	}
	const trunkRef = manifest.trunkRef.startsWith("refs/") ? manifest.trunkRef : `refs/heads/${manifest.trunkRef}`;
	const trunk = await runCommand(
		exec,
		"git",
		["rev-parse", "--verify", `${trunkRef}^{commit}`],
		repositoryRoot,
		signal,
	);
	if (trunk.code !== 0 || trunk.stdout.trim() !== manifest.trunkSha) {
		return { ok: false, error: `${providerLabel} trunk ${manifest.trunkRef} moved after the stack was planned.` };
	}
	let baseSha = manifest.trunkSha;
	for (const slice of manifest.slices) {
		const format = await runCommand(
			exec,
			"git",
			["check-ref-format", "--branch", slice.branch],
			repositoryRoot,
			signal,
		);
		if (format.code !== 0) return { ok: false, error: `Invalid ${providerLabel} branch name: ${slice.branch}.` };
		const head = await runCommand(
			exec,
			"git",
			["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`],
			repositoryRoot,
			signal,
		);
		if (head.code !== 0 || head.stdout.trim() !== slice.headSha) {
			return {
				ok: false,
				error: `${providerLabel} branch ${slice.branch} no longer matches manifest head ${slice.headSha}.`,
			};
		}
		const ancestor = await runCommand(
			exec,
			"git",
			["merge-base", "--is-ancestor", baseSha, slice.headSha],
			repositoryRoot,
			signal,
		);
		if (ancestor.code !== 0) return { ok: false, error: `${slice.branch} is not based on ${slice.baseBranch}.` };
		const diff = await runCommand(
			exec,
			"git",
			["diff", "--quiet", baseSha, slice.headSha, "--"],
			repositoryRoot,
			signal,
		);
		if (diff.code === 0) return { ok: false, error: `${providerLabel} slice ${slice.branch} has an empty diff.` };
		if (diff.code !== 1) {
			return {
				ok: false,
				error: `Could not inspect ${providerLabel} slice ${slice.branch}: ${commandDiagnostic(diff)}`,
			};
		}
		baseSha = slice.headSha;
	}
	return { ok: true, stack: { repositoryRoot, manifest } };
}
