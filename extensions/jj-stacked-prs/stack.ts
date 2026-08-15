/** Pure blocker detection, top inference, and PR-slice derivation. */

import { type StackBlocker, type StackCommit, type StackSlice, TRUNK_BOOKMARK_NAMES } from "./types.ts";

export function parseConcatenatedJson(text: string): unknown[] {
	const objects: unknown[] = [];
	let index = 0;
	while (index < text.length) {
		while (index < text.length && text[index] !== "{" && text[index] !== "[") index++;
		if (index >= text.length) break;
		const end = jsonValueEnd(text, index);
		if (end === undefined) break;
		try {
			const value: unknown = JSON.parse(text.slice(index, end));
			if (typeof value === "object" && value !== null) objects.push(value);
		} catch {
			break;
		}
		index = end;
	}
	return objects;
}

function jsonValueEnd(text: string, start: number): number | undefined {
	const opener = text[start];
	if (opener !== "{" && opener !== "[") return undefined;
	const closer = opener === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === opener) depth++;
		else if (ch === closer) {
			depth--;
			if (depth === 0) return i + 1;
		} else if ((opener === "{" && ch === "[") || (opener === "[" && ch === "{")) {
			const nested = jsonValueEnd(text, i);
			if (nested === undefined) return undefined;
			i = nested - 1;
		}
	}
	return undefined;
}

export function detectTopBookmark(commits: readonly Pick<StackCommit, "bookmarks">[]): string | undefined {
	if (commits.length === 0) return undefined;
	for (let i = commits.length - 1; i >= 0; i--) {
		for (const bookmark of commits[i].bookmarks) {
			if (!TRUNK_BOOKMARK_NAMES.has(bookmark)) return bookmark;
		}
	}
	for (let i = commits.length - 1; i >= 0; i--) {
		if (commits[i].bookmarks.length > 0) return commits[i].bookmarks[0];
	}
	return undefined;
}

export function inferUniqueTop(commits: readonly StackCommit[]): { top: string } | { blocker: StackBlocker } {
	const candidates = uniqueTopCandidates(commits);
	if (candidates.length === 1) {
		const tail = unbookmarkedTail(commits, candidates[0]);
		if (tail && !isAllowedEmptyWorkingCopy(tail)) {
			return {
				blocker: {
					code: "unbookmarked-tail",
					message: `A non-empty unbookmarked change ${tail.changeId} sits above inferred top ${candidates[0]}; specify --top explicitly.`,
				},
			};
		}
		return { top: candidates[0] };
	}
	if (candidates.length === 0) {
		return { blocker: { code: "missing-top", message: "No top bookmark was specified and none could be inferred." } };
	}
	return {
		blocker: {
			code: "ambiguous-top",
			message: `Multiple topmost bookmarks could be inferred (${candidates.join(", ")}); specify --top explicitly.`,
		},
	};
}

function uniqueTopCandidates(commits: readonly Pick<StackCommit, "bookmarks">[]): string[] {
	const found = new Set<string>();
	for (let i = commits.length - 1; i >= 0; i--) {
		for (const bookmark of commits[i].bookmarks) {
			if (!TRUNK_BOOKMARK_NAMES.has(bookmark)) found.add(bookmark);
		}
		if (found.size > 0) return [...found];
	}
	for (let i = commits.length - 1; i >= 0; i--) {
		for (const bookmark of commits[i].bookmarks) found.add(bookmark);
		if (found.size > 0) return [...found];
	}
	return [];
}

function unbookmarkedTail(commits: readonly StackCommit[], top: string): StackCommit | undefined {
	let seenTop = false;
	let tail: StackCommit | undefined;
	for (const commit of commits) {
		if (commit.bookmarks.includes(top)) {
			seenTop = true;
			tail = undefined;
			continue;
		}
		if (seenTop && commit.bookmarks.length === 0) tail = commit;
	}
	return tail;
}

function isAllowedEmptyWorkingCopy(commit: StackCommit): boolean {
	return commit.empty && commit.workingCopy;
}

export function deriveSlices(stack: readonly StackCommit[], topBookmark: string): StackSlice[] {
	const bookmarkIndices: Array<{ index: number; bookmark: string }> = [];
	for (const [index, entry] of stack.entries()) {
		for (const bookmark of entry.bookmarks) bookmarkIndices.push({ index, bookmark });
	}

	const slices: StackSlice[] = [];
	let prevIndex = 0;
	let prevBookmark: string | null = null;
	for (const { index, bookmark } of bookmarkIndices) {
		const changeIds = stack.slice(prevIndex, index + 1).map((entry) => entry.changeId);
		slices.push({
			bookmark,
			baseBookmark: prevBookmark,
			changeIds,
			subject: subjectFor(stack, changeIds),
		});
		prevIndex = index + 1;
		prevBookmark = bookmark;
	}
	void topBookmark;
	return slices;
}

function subjectFor(stack: readonly StackCommit[], changeIds: readonly string[]): string {
	const belonging = new Set(changeIds);
	for (let i = stack.length - 1; i >= 0; i--) {
		if (belonging.has(stack[i].changeId) && stack[i].subject) return stack[i].subject;
	}
	return "";
}

export function detectBlockers(input: {
	commits: readonly StackCommit[];
	trunkCommit: string;
	topBookmark: string | undefined;
	allowUnbookmarkedTail?: boolean;
}): StackBlocker[] {
	const { commits, trunkCommit, topBookmark } = input;
	const blockers: StackBlocker[] = [];
	if (commits.length === 0) {
		blockers.push({ code: "empty-stack", message: "No commits between trunk() and the selected top bookmark." });
	}
	if (topBookmark === undefined) {
		blockers.push({ code: "missing-top", message: "No top bookmark was specified and none could be inferred." });
	}

	const seenBookmarkTargets = new Map<string, string>();
	const duplicateBookmarks = new Set<string>();
	for (const commit of commits) {
		const label = `${commit.changeId} (${commit.subject || "no description"})`;
		if (commit.conflict) {
			blockers.push({ code: "conflict", message: `${label} contains a merge conflict.`, changeId: commit.changeId });
		}
		if (commit.divergent) {
			blockers.push({
				code: "divergence",
				message: `${label} is divergent (multiple commits share its change id).`,
				changeId: commit.changeId,
			});
		}
		if (commit.merge) {
			blockers.push({
				code: "merge",
				message: `${label} is a merge commit; only linear stacks are supported.`,
				changeId: commit.changeId,
			});
		}
		if (commit.empty && commit.bookmarks.length > 0 && !commit.workingCopy) {
			blockers.push({
				code: "empty-boundary",
				message: `${label} is empty but carries a bookmark; the PR would have no diff.`,
				changeId: commit.changeId,
			});
		}
		if (!commit.subject && commit.bookmarks.length > 0) {
			blockers.push({
				code: "empty-description",
				message: `${label} has a bookmark but an empty description.`,
				changeId: commit.changeId,
			});
		}
		for (const bookmark of commit.bookmarks) {
			const previous = seenBookmarkTargets.get(bookmark);
			if (previous !== undefined && previous !== commit.commitId) duplicateBookmarks.add(bookmark);
			seenBookmarkTargets.set(bookmark, commit.commitId);
		}
		if (commit.bookmarks.length > 1) {
			blockers.push({
				code: "multiple-bookmarks",
				message: `${label} carries multiple bookmarks (${commit.bookmarks.join(", ")}); one PR boundary per change is expected.`,
				bookmark: commit.bookmarks[0],
			});
		}
	}
	if (duplicateBookmarks.size > 0) {
		blockers.push({
			code: "ambiguous-local-bookmark",
			message: `Bookmarks point to more than one commit: ${[...duplicateBookmarks].sort().join(", ")}.`,
			bookmark: [...duplicateBookmarks].sort()[0],
		});
	}
	if (commits.length > 0) {
		const firstParent = commits[0].parentCommitIds[0];
		if (firstParent !== trunkCommit) {
			blockers.push({
				code: "not-rooted-at-trunk",
				message: `The bottom of the inspected stack is not rooted at trunk(); its parent is ${firstParent ?? "missing"} but trunk() is ${trunkCommit}.`,
			});
		}
	}
	if (topBookmark && commits.length > 0) {
		const slices = deriveSlices(commits, topBookmark);
		if (slices.length === 0 || slices[slices.length - 1].bookmark !== topBookmark) {
			blockers.push({
				code: "top-not-final-boundary",
				message: `Selected top bookmark ${JSON.stringify(topBookmark)} is not the final PR boundary.`,
			});
		}
		if (!input.allowUnbookmarkedTail) {
			const tail = unbookmarkedTail(commits, topBookmark);
			if (tail && !isAllowedEmptyWorkingCopy(tail)) {
				blockers.push({
					code: "unbookmarked-tail",
					message: `A non-empty unbookmarked change ${tail.changeId} sits above top ${topBookmark}.`,
				});
			}
		}
	}
	return blockers;
}

export function truncateStack<T>(items: readonly T[], maxStack: number): { items: T[]; truncated: boolean } {
	if (items.length <= maxStack) return { items: [...items], truncated: false };
	return { items: items.slice(0, maxStack), truncated: true };
}

export function shortenId(id: string, chars: number): string {
	return id.length <= chars ? id : id.slice(0, chars);
}
