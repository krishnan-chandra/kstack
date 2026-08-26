import { mapWithConcurrencyLimit } from "../concurrency.ts";
import type { GitHubComment, GitHubGateway, GitHubRepository } from "../github.ts";
import { isGitHubIndeterminate } from "../github.ts";
import { type BoundaryValue, isNumber, isObject, isString, type JsonObject } from "../validation.ts";
import type { CompletedPublicationAction, FailedPublicationAction } from "./outcome.ts";

/** Marker identifying Kstack-owned PR navigation comments across extensions. */
export const KSTACK_COMMENT_MARKER = "<!-- kstack-stack-nav -->";
const KSTACK_COMMENT_SCHEMA_VERSION = 1;
const MAX_NAVIGATION_ENTRIES = 100;
const MAX_NAVIGATION_COMMENT_BYTES = 60_000;
const NAVIGATION_READ_CONCURRENCY = 4;
const DATA_MARKER_PATTERN = /<!-- kstack-stack-data-v1: ([A-Za-z0-9_-]+) -->/;

export type NavigationStatus = "open" | "draft" | "merged" | "closed" | "unknown";
export interface NavigationEntry {
	prNumber: number | undefined;
	bookmark: string;
	base: string;
	status: NavigationStatus;
}
/* exported: stack topology adapter contract */
export interface StackTopologySlice {
	ref: string;
	prNumber: number | undefined;
	targetBase: string;
	createPr: boolean;
	draft: boolean;
}
/* exported: stack topology adapter contract */
export interface StackTopologyStore {
	reconcile(input: {
		repo: GitHubRepository;
		defaultBranch: string;
		published: readonly StackTopologySlice[];
		cwd: string;
		signal?: AbortSignal;
	}): Promise<{ completed: CompletedPublicationAction[]; errors: string[]; indeterminate?: FailedPublicationAction }>;
	membership(input: {
		repo: GitHubRepository;
		prNumber: number;
		headRef: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<{ entries: NavigationEntry[]; selectedIndex: number }>;
}
const VALID_NAVIGATION_STATUSES = new Set<NavigationStatus>(["open", "draft", "merged", "closed", "unknown"]);

function normalizeNavigationStatus(value: string): NavigationStatus {
	const status = value.toLowerCase();
	// SAFETY: Set membership establishes NavigationStatus before the asserted branch returns it.
	return VALID_NAVIGATION_STATUSES.has(
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ status as NavigationStatus,
	)
		? /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (status as NavigationStatus)
		: "unknown";
}

export function buildNavigationComment(entries: readonly NavigationEntry[], defaultBranch: string): string {
	if (entries.length > MAX_NAVIGATION_ENTRIES) {
		throw new Error(`Navigation comment has ${entries.length} entries; maximum is ${MAX_NAVIGATION_ENTRIES}.`);
	}
	const dataPayload = encodeNavigationEntries(entries);
	const lines = [
		KSTACK_COMMENT_MARKER,
		`<!-- kstack-stack-schema-v${KSTACK_COMMENT_SCHEMA_VERSION} -->`,
		`<!-- kstack-stack-data-v1: ${dataPayload} -->`,
		"",
		"## Stack navigation (kstack)",
		"",
		"| PR | Bookmark | Base | Status |",
		"|---|---|---|---|",
	];
	for (const entry of entries) {
		const prRef = entry.prNumber ? `#${entry.prNumber}` : "—";
		const bookmark = entry.bookmark ? markdownCode(entry.bookmark) : "—";
		const base = markdownCode(entry.base || defaultBranch);
		lines.push(`| ${prRef} | ${bookmark} | ${base} | ${capitalize(entry.status)} |`);
	}
	lines.push("", "_Navigated by kstack. Republish with the active stack provider._");
	const body = lines.join("\n");
	if (Buffer.byteLength(body, "utf8") > MAX_NAVIGATION_COMMENT_BYTES) {
		throw new Error(`Navigation comment exceeds ${MAX_NAVIGATION_COMMENT_BYTES} bytes.`);
	}
	return body;
}

export function parseNavigationCommentEntries(body: string): NavigationEntry[] {
	if (!body.includes(KSTACK_COMMENT_MARKER)) return [];
	const dataMatch = DATA_MARKER_PATTERN.exec(body);
	if (dataMatch) {
		const encoded = dataMatch[1];
		try {
			const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
			const parsed: BoundaryValue = JSON.parse(Buffer.from(encoded + padding, "base64url").toString("utf8"));
			if (Array.isArray(parsed) && parsed.length <= MAX_NAVIGATION_ENTRIES) {
				const entries = parsed.map(parseNavigationItem);
				if (entries.every((entry) => entry !== undefined)) return entries.filter((entry) => entry !== undefined);
			}
		} catch {
			/* fall back to the Markdown table */
		}
	}

	const entries: NavigationEntry[] = [];
	for (const line of body.split("\n")) {
		const stripped = line.trim();
		if (!stripped.startsWith("|")) continue;
		const cells = stripped
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
		if (cells.length !== 3 && cells.length !== 4) continue;
		if (cells[0].toLowerCase() === "pr") continue;
		if (cells.every((cell) => /^[-:]+$/.test(cell))) continue;
		const prMatch = /#(\d+)/.exec(cells[0]);
		entries.push({
			prNumber: prMatch ? Number(prMatch[1]) : undefined,
			bookmark: decodeCodeCell(cells[1]),
			base: decodeCodeCell(cells[2]),
			status: normalizeNavigationStatus(cells[3] ?? "open"),
		});
		if (entries.length >= MAX_NAVIGATION_ENTRIES) break;
	}
	return entries;
}

export function parseCommentMetadata(body: string): { schemaVersion: number } | undefined {
	if (!body.includes(KSTACK_COMMENT_MARKER)) return undefined;
	const match = /kstack-stack-schema-v(\d+)/.exec(body);
	return { schemaVersion: match ? Number(match[1]) : 0 };
}

export function findKstackComment(comments: readonly GitHubComment[], ghUser?: string): GitHubComment | undefined {
	for (const comment of comments) {
		if (!comment.body.includes(KSTACK_COMMENT_MARKER)) continue;
		if (ghUser !== undefined && (comment.user === undefined || comment.user.toLowerCase() !== ghUser.toLowerCase())) {
			continue;
		}
		const metadata = parseCommentMetadata(comment.body);
		if (
			metadata === undefined ||
			(metadata.schemaVersion !== 0 && metadata.schemaVersion !== KSTACK_COMMENT_SCHEMA_VERSION)
		) {
			continue;
		}
		return comment;
	}
	return undefined;
}

export function findNavigationAncestors(
	published: readonly { bookmark: string; existingPr?: { number: number } }[],
	priorEntries: readonly NavigationEntry[],
): NavigationEntry[] {
	for (const [index, prior] of priorEntries.entries()) {
		if (
			published.some(
				(slice) =>
					(slice.existingPr !== undefined && slice.existingPr.number === prior.prNumber) ||
					slice.bookmark === prior.bookmark,
			)
		) {
			return priorEntries.slice(0, index);
		}
	}
	return [];
}

export function reconcileStackEntries(input: {
	published: readonly {
		bookmark: string;
		prNumber: number | undefined;
		targetBase: string;
		createPr: boolean;
	}[];
	priorEntries: readonly NavigationEntry[];
	statusByPr: Readonly<Record<number, string>>;
	defaultBranch: string;
}): NavigationEntry[] {
	const publishedSlices = input.published.map((slice) => ({
		bookmark: slice.bookmark,
		existingPr: slice.prNumber === undefined ? undefined : { number: slice.prNumber },
	}));
	const ancestors = findNavigationAncestors(publishedSlices, input.priorEntries).map((entry) => {
		const status = entry.prNumber === undefined ? "unknown" : (input.statusByPr[entry.prNumber] ?? entry.status);
		return { ...entry, status: normalizeNavigationStatus(status) };
	});
	const active = input.published.map((slice) => {
		let status = slice.createPr ? "draft" : "open";
		if (slice.prNumber === undefined) status = "unknown";
		else if (input.statusByPr[slice.prNumber] !== undefined) status = input.statusByPr[slice.prNumber];
		return {
			prNumber: slice.prNumber,
			bookmark: slice.bookmark,
			base: slice.targetBase.replace(/^refs\/heads\//, "") || input.defaultBranch,
			status: normalizeNavigationStatus(status),
		};
	});
	return [...ancestors, ...active];
}

function encodeNavigationEntries(entries: readonly NavigationEntry[]): string {
	const payload = JSON.stringify(
		entries.map((entry) => ({
			pr_number: entry.prNumber ?? null,
			bookmark: entry.bookmark,
			base: entry.base,
			status: entry.status,
		})),
	);
	return Buffer.from(payload, "utf8").toString("base64url").replace(/=+$/, "");
}

function parseNavigationItem(item: BoundaryValue): NavigationEntry | undefined {
	if (!isObject(item) || item === null) return undefined;
	const record =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ item as JsonObject;
	const prNumber = record.pr_number;
	if (prNumber !== null && prNumber !== undefined && (!Number.isSafeInteger(prNumber) || Number(prNumber) <= 0)) {
		return undefined;
	}
	if (!isString(record.bookmark) || !isString(record.base) || !isString(record.status)) {
		return undefined;
	}
	return {
		prNumber: isNumber(prNumber) ? prNumber : undefined,
		bookmark: record.bookmark,
		base: record.base,
		status: normalizeNavigationStatus(record.status),
	};
}

function markdownCode(value: string): string {
	const escaped = escapeHtml(value).replace(/\|/g, "&#124;");
	return `<code>${escaped}</code>`;
}

function decodeCodeCell(value: string): string {
	let cell = value.trim();
	if (cell.length >= 2 && cell.startsWith("`") && cell.endsWith("`")) cell = cell.slice(1, -1);
	else if (cell.startsWith("<code>") && cell.endsWith("</code>")) cell = cell.slice(6, -7);
	return unescapeHtml(cell);
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "\u0026amp;").replace(/</g, "\u0026lt;").replace(/>/g, "\u0026gt;");
}

function unescapeHtml(value: string): string {
	return value
		.replace(/&#124;/g, "|")
		.replace(/\u0026lt;/g, "<")
		.replace(/\u0026gt;/g, ">")
		.replace(/\u0026amp;/g, "&");
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

export function createNavigationCommentStore(github: GitHubGateway): StackTopologyStore {
	return {
		async membership(input) {
			const user = await github.getAuthenticatedUser(input.cwd, input.signal);
			const comments = await github.getPrComments(input.repo, input.prNumber, input.cwd, input.signal);
			const navigation = findKstackComment(comments, user);
			const entries = navigation ? parseNavigationCommentEntries(navigation.body) : [];
			return {
				entries,
				selectedIndex: entries.findIndex(
					(entry) => entry.prNumber === input.prNumber && entry.bookmark === input.headRef,
				),
			};
		},
		async reconcile(input) {
			const completed: CompletedPublicationAction[] = [];
			const errors: string[] = [];
			const user = await github.getAuthenticatedUser(input.cwd, input.signal);
			if (!user)
				return {
					completed,
					errors: ["Navigation comments skipped: could not determine the authenticated GitHub user."],
				};
			const existingByPr = new Map<number, GitHubComment[]>();
			const failedFetches = new Set<number>();
			let priorEntries: NavigationEntry[] = [];
			const withPrs = input.published.filter(
				(slice): slice is StackTopologySlice & { prNumber: number } => slice.prNumber !== undefined,
			);
			const reads = await mapWithConcurrencyLimit(withPrs, NAVIGATION_READ_CONCURRENCY, async (slice) => {
				try {
					return {
						kind: "ok" as const,
						prNumber: slice.prNumber,
						comments: await github.getPrComments(input.repo, slice.prNumber, input.cwd, input.signal),
					};
				} catch (error) {
					return { kind: "error" as const, prNumber: slice.prNumber, error };
				}
			});
			for (const read of reads) {
				if (read.kind === "error") {
					failedFetches.add(read.prNumber);
					errors.push(`PR #${read.prNumber}: ${errorMessage(read.error)}`);
					continue;
				}
				existingByPr.set(read.prNumber, read.comments);
				const existing = findKstackComment(read.comments, user);
				const entries = existing ? parseNavigationCommentEntries(existing.body) : [];
				if (entries.length > priorEntries.length) priorEntries = entries;
			}
			const statusByPr: Record<number, string> = {};
			for (const slice of input.published)
				if (slice.prNumber !== undefined) statusByPr[slice.prNumber] = slice.createPr || slice.draft ? "draft" : "open";
			const ancestors = findNavigationAncestors(
				input.published.map((slice) => ({
					bookmark: slice.ref,
					existingPr: slice.prNumber === undefined ? undefined : { number: slice.prNumber },
				})),
				priorEntries,
			);
			const queued = [
				...new Set(
					ancestors.flatMap((entry) => {
						if (entry.prNumber === undefined || statusByPr[entry.prNumber] || entry.status === "merged") return [];
						return [entry.prNumber];
					}),
				),
			];
			for (const entry of ancestors)
				if (entry.prNumber !== undefined && entry.status === "merged") statusByPr[entry.prNumber] = "merged";
			const statuses = await mapWithConcurrencyLimit(queued, NAVIGATION_READ_CONCURRENCY, async (prNumber) => {
				try {
					return {
						kind: "ok" as const,
						prNumber,
						status: await github.getPrStatus(input.repo, prNumber, input.cwd, input.signal),
					};
				} catch (error) {
					return { kind: "error" as const, prNumber, error };
				}
			});
			for (const read of statuses) {
				if (read.kind === "ok") statusByPr[read.prNumber] = read.status;
				else {
					statusByPr[read.prNumber] = "unknown";
					errors.push(errorMessage(read.error));
				}
			}
			let body: string;
			try {
				body = buildNavigationComment(
					reconcileStackEntries({
						published: input.published.map((slice) => ({
							bookmark: slice.ref,
							prNumber: slice.prNumber,
							targetBase: slice.targetBase,
							createPr: slice.createPr,
						})),
						priorEntries,
						statusByPr,
						defaultBranch: input.defaultBranch,
					}),
					input.defaultBranch,
				);
			} catch (error) {
				return { completed, errors: [...errors, errorMessage(error)] };
			}
			for (const slice of input.published) {
				if (slice.prNumber === undefined || failedFetches.has(slice.prNumber)) continue;
				const existing = findKstackComment(existingByPr.get(slice.prNumber) ?? [], user);
				try {
					await github.createOrUpdateComment({
						repo: input.repo,
						prNumber: slice.prNumber,
						body,
						existingCommentId: existing?.id,
						cwd: input.cwd,
						signal: input.signal,
					});
					completed.push({ kind: existing ? "update-nav-comment" : "create-nav-comment", prNumber: slice.prNumber });
				} catch (error) {
					if (isGitHubIndeterminate(error))
						return {
							completed,
							errors,
							indeterminate: { kind: "nav-comment", prNumber: slice.prNumber, error: errorMessage(error) },
						};
					errors.push(`PR #${slice.prNumber}: ${errorMessage(error)}`);
					break;
				}
			}
			return { completed, errors };
		},
	};
}
function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}
