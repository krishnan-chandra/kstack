/** Decode Git's NUL-delimited `worktree list --porcelain -z` inventory. */

const OBJECT_ID_RE = /^[0-9a-f]{40}$/;
const LOCAL_REF_PREFIX = "refs/heads/";
const WORKTREE_PREFIX = "worktree ";
const HEAD_PREFIX = "HEAD ";
const BRANCH_PREFIX = "branch ";

type WorktreeInventoryResult = { ok: true; value: readonly WorktreeRecord[] } | { ok: false; error: string };
type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

type WorktreeFlag = boolean | string;

export interface WorktreeRecord {
	path: string;
	head: string | undefined;
	branch: string | undefined;
	bare: boolean;
	detached: boolean;
	locked: WorktreeFlag;
	prunable: WorktreeFlag;
}

type WorktreeField =
	| { kind: "head"; value: string }
	| { kind: "branch"; value: string }
	| { kind: "bare" }
	| { kind: "detached" }
	| { kind: "locked"; value: WorktreeFlag }
	| { kind: "prunable"; value: WorktreeFlag };

interface RecordDraft {
	path: string;
	head?: string;
	branch?: string;
	bare?: true;
	detached?: true;
	locked?: WorktreeFlag;
	prunable?: WorktreeFlag;
}

function fail(error: string) {
	return { ok: false as const, error };
}

function optionalAttribute(field: string, name: "locked" | "prunable"): WorktreeFlag | undefined {
	if (field === name) return true;
	const prefix = `${name} `;
	if (!field.startsWith(prefix)) return undefined;
	return field.slice(prefix.length) || true;
}

function parseField(field: string): ParseResult<WorktreeField> {
	if (field.startsWith(HEAD_PREFIX)) {
		return { ok: true, value: { kind: "head", value: field.slice(HEAD_PREFIX.length) } };
	}
	if (field.startsWith(BRANCH_PREFIX)) {
		const ref = field.slice(BRANCH_PREFIX.length);
		if (!ref.startsWith(LOCAL_REF_PREFIX) || ref.length === LOCAL_REF_PREFIX.length) {
			return fail("Git returned an invalid worktree branch record.");
		}
		return { ok: true, value: { kind: "branch", value: ref.slice(LOCAL_REF_PREFIX.length) } };
	}
	if (field === "bare") return { ok: true, value: { kind: "bare" } };
	if (field === "detached") return { ok: true, value: { kind: "detached" } };
	const locked = optionalAttribute(field, "locked");
	if (locked !== undefined) return { ok: true, value: { kind: "locked", value: locked } };
	const prunable = optionalAttribute(field, "prunable");
	if (prunable !== undefined) return { ok: true, value: { kind: "prunable", value: prunable } };
	return fail("Git returned an invalid worktree record.");
}

function setOnce<K extends keyof RecordDraft>(draft: RecordDraft, key: K, value: NonNullable<RecordDraft[K]>): boolean {
	if (draft[key] !== undefined) return false;
	draft[key] = value;
	return true;
}

function applyField(draft: RecordDraft, field: WorktreeField): boolean {
	switch (field.kind) {
		case "head":
			return setOnce(draft, "head", field.value);
		case "branch":
			return setOnce(draft, "branch", field.value);
		case "bare":
			return setOnce(draft, "bare", true);
		case "detached":
			return setOnce(draft, "detached", true);
		case "locked":
			return setOnce(draft, "locked", field.value);
		case "prunable":
			return setOnce(draft, "prunable", field.value);
		default: {
			const _exhaustive: never = field;
			return _exhaustive;
		}
	}
}

function hasValidCheckout(draft: RecordDraft): boolean {
	const stateCount = Number(draft.branch !== undefined) + Number(draft.bare === true) + Number(draft.detached === true);
	if (stateCount !== 1) return false;
	if (draft.bare) return draft.head === undefined;
	return Boolean(draft.head && OBJECT_ID_RE.test(draft.head));
}

function parseWorktreeRecord(chunk: string): ParseResult<WorktreeRecord> {
	const fields = chunk.split("\0");
	const first = fields.shift();
	if (!first?.startsWith(WORKTREE_PREFIX) || first.length === WORKTREE_PREFIX.length) {
		return fail("Git returned an invalid worktree record.");
	}
	const draft: RecordDraft = { path: first.slice(WORKTREE_PREFIX.length) };
	for (const field of fields) {
		const parsed = parseField(field);
		if (!parsed.ok) return parsed;
		if (!applyField(draft, parsed.value)) return fail("Git returned an invalid worktree record.");
	}
	if (!hasValidCheckout(draft)) return fail("Git returned an incomplete worktree record.");
	return {
		ok: true,
		value: {
			path: draft.path,
			head: draft.head,
			branch: draft.branch,
			bare: draft.bare === true,
			detached: draft.detached === true,
			locked: draft.locked ?? false,
			prunable: draft.prunable ?? false,
		},
	};
}

export function parseWorktreeInventory(stdout: string): WorktreeInventoryResult {
	if (!stdout?.endsWith("\0\0")) {
		return fail("Git returned an empty or unterminated worktree inventory.");
	}
	const records: WorktreeRecord[] = [];
	const paths = new Set<string>();
	for (const chunk of stdout.slice(0, -2).split("\0\0")) {
		const parsed = parseWorktreeRecord(chunk);
		if (!parsed.ok) return parsed;
		if (paths.has(parsed.value.path)) return fail("Git returned duplicate worktree records.");
		paths.add(parsed.value.path);
		records.push(parsed.value);
	}
	if (records.length === 0) return fail("Git returned an empty worktree inventory.");
	return { ok: true, value: records };
}
