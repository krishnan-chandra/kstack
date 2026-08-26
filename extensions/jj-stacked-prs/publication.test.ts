import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findPrForBookmark, parseGithubUrl, parseOpenPrs, parsePrStatus, redactUrl } from "../shared/github.ts";
import {
	buildNavigationComment,
	findKstackComment,
	findNavigationAncestors,
	parseCommentMetadata,
	parseNavigationCommentEntries,
	reconcileStackEntries,
} from "../shared/stack/topology.ts";
import { buildPublicationPlan, displayPlanId, planIdsMatch } from "./publication.ts";
import { KSTACK_COMMENT_MARKER, type NavigationEntry, type OpenPullRequest, type StackSlice } from "./types.ts";

function slice(bookmark: string, base: string | null, changeIds: string[], subject: string): StackSlice {
	return { bookmark, baseBookmark: base, changeIds, subject };
}

function snapshot(overrides: Partial<Parameters<typeof buildPublicationPlan>[0]> = {}) {
	return {
		changeCount: 1,
		repository: { owner: "o", repo: "r" },
		remote: {
			name: "origin",
			url: "https://github.com/o/r.git",
			redactedUrl: "https://github.com/o/r.git",
			github: { owner: "o", repo: "r" },
		},
		defaultBranch: "main",
		slices: [slice("feat1", null, ["aaa"], "feat: aaa")],
		localBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
		remoteBookmarks: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as {
			name: string;
			commitId: string;
		}[],
		openPrs:
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as OpenPullRequest[],
		...overrides,
	};
}

describe("GitHub URL parsing", () => {
	it("parses HTTPS, SSH, and ssh:// forms", () => {
		assert.deepEqual(parseGithubUrl("https://github.com/owner/repo.git"), { owner: "owner", repo: "repo" });
		assert.deepEqual(parseGithubUrl("https://github.com/owner/repo"), { owner: "owner", repo: "repo" });
		assert.deepEqual(parseGithubUrl("git@github.com:owner/repo.git"), { owner: "owner", repo: "repo" });
		assert.deepEqual(parseGithubUrl("ssh://git@github.com/owner/repo.js.git"), { owner: "owner", repo: "repo.js" });
		assert.equal(parseGithubUrl("https://gitlab.com/owner/repo.git"), undefined);
		assert.equal(parseGithubUrl(""), undefined);
	});

	it("redacts credentials from URLs", () => {
		assert.equal(redactUrl("https://x-access-token:SECRET@github.com/owner/repo"), "https://***@github.com/owner/repo");
		assert.equal(redactUrl("https://github.com/owner/repo"), "https://github.com/owner/repo");
	});
});

describe("open PR matching", () => {
	it("matches the exact head repository case-insensitively and ignores deleted forks", () => {
		const payload = `${JSON.stringify({
			number: 1,
			headRefName: "feat1",
			baseRefName: "main",
			title: "right repo",
			isDraft: true,
			headCommitId: "aaa-commit",
			url: "https://github.com/Owner/Repo/pull/1",
			headRepository: { nameWithOwner: "Owner/Repo" },
			headRepositoryOwner: { login: "Owner" },
		})}\n${JSON.stringify({
			number: 2,
			headRefName: "feat1",
			baseRefName: "main",
			headRepository: { nameWithOwner: "Owner/repo-fork" },
			headRepositoryOwner: { login: "Owner" },
		})}\n${JSON.stringify({
			number: 3,
			headRefName: "deleted",
			baseRefName: "main",
			headRepository: null,
			headRepositoryOwner: null,
		})}`;
		const prs = parseOpenPrs(payload, { owner: "owner", repo: "repo" });
		assert.deepEqual(
			prs.map((pr) => pr.number),
			[1],
		);
	});

	it("rejects an ambiguous bookmark match", () => {
		const prs: OpenPullRequest[] = [
			{
				number: 1,
				headRef: "feat1",
				headCommitId: "aaa-commit",
				baseRef: "main",
				title: "one",
				draft: true,
				url: "u1",
				headOwner: "o",
			},
			{
				number: 2,
				headRef: "feat1",
				headCommitId: "bbb-commit",
				baseRef: "release",
				title: "two",
				draft: true,
				url: "u2",
				headOwner: "o",
			},
		];
		assert.equal(findPrForBookmark(prs, "feat1"), undefined);
		assert.equal(findPrForBookmark(prs, "missing"), undefined);
	});
});

describe("publication planning", () => {
	it("only pushes bookmarks whose remote target differs", () => {
		const plan = buildPublicationPlan(
			snapshot({
				slices: [slice("synced", null, ["a"], "Synced"), slice("changed", "synced", ["b"], "Changed")],
				localBookmarks: [
					{ name: "synced", commitId: "111" },
					{ name: "changed", commitId: "222" },
				],
				remoteBookmarks: [
					{ name: "synced", commitId: "111" },
					{ name: "changed", commitId: "old" },
				],
			}),
		);
		assert.deepEqual(
			plan.actions.map((action) => action.kind),
			["create-draft-pr", "push-bookmark", "create-draft-pr"],
		);
		assert.equal(
			plan.slices[0].actions.some((action) => action.kind === "push-bookmark"),
			false,
		);
		assert.equal(
			plan.slices[1].actions.some((action) => action.kind === "push-bookmark"),
			true,
		);
	});

	it("blocks an unresolved local bookmark and keeps a deterministic plan id", () => {
		const first = buildPublicationPlan(
			snapshot({
				localBookmarks: [
					{ name: "feat1", commitId: "one" },
					{ name: "feat1", commitId: "two" },
				],
			}),
		);
		const second = buildPublicationPlan(
			snapshot({
				localBookmarks: [
					{ name: "feat1", commitId: "one" },
					{ name: "feat1", commitId: "two" },
				],
			}),
		);
		assert.ok(first.blockers.some((blocker) => blocker.code === "ambiguous-local-bookmark"));
		assert.equal(first.planId, second.planId);
		assert.equal(first.planId.length, 64);
		assert.equal(displayPlanId(first.planId).length, 16);
		assert.equal(planIdsMatch(first.planId, second.planId), true);
	});

	it("blocks a conflicted remote bookmark and ambiguous open PRs", () => {
		const conflicted = buildPublicationPlan(
			snapshot({
				remoteBookmarks: [
					{ name: "feat1", commitId: "old1" },
					{ name: "feat1", commitId: "old2" },
				],
			}),
		);
		assert.ok(conflicted.blockers.some((blocker) => blocker.code === "remote-bookmark-conflict"));

		const ambiguous = buildPublicationPlan(
			snapshot({
				openPrs: [
					{
						number: 1,
						headRef: "feat1",
						headCommitId: "aaa-commit",
						baseRef: "main",
						title: "one",
						draft: true,
						url: "u1",
						headOwner: "o",
					},
					{
						number: 2,
						headRef: "feat1",
						headCommitId: "bbb-commit",
						baseRef: "release",
						title: "two",
						draft: true,
						url: "u2",
						headOwner: "o",
					},
				],
			}),
		);
		assert.ok(ambiguous.blockers.some((blocker) => blocker.code === "ambiguous-pr"));
	});

	it("repairs only a wrong existing PR base and preserves draft metadata in the hash", () => {
		const existing: OpenPullRequest = {
			number: 11,
			headRef: "feat1",
			headCommitId: "aaa-commit",
			baseRef: "old-base",
			title: "Keep this title",
			draft: true,
			url: "https://example/11",
			headOwner: "o",
		};
		const plan = buildPublicationPlan(
			snapshot({
				localBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				remoteBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				openPrs: [existing],
			}),
		);
		assert.deepEqual(plan.actions, [
			{
				kind: "repair-pr-base",
				bookmark: "feat1",
				prNumber: 11,
				currentBase: "old-base",
				targetBase: "main",
			},
		]);
		const retitled = buildPublicationPlan(
			snapshot({
				localBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				remoteBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				openPrs: [{ ...existing, title: "Changed title" }],
			}),
		);
		assert.equal(plan.planId, retitled.planId);
		const undrafted = buildPublicationPlan(
			snapshot({
				localBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				remoteBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				openPrs: [{ ...existing, draft: false }],
			}),
		);
		assert.notEqual(plan.planId, undrafted.planId);
		const movedHead = buildPublicationPlan(
			snapshot({
				localBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				remoteBookmarks: [{ name: "feat1", commitId: "aaa-commit" }],
				openPrs: [{ ...existing, headCommitId: "different-commit" }],
			}),
		);
		assert.notEqual(plan.planId, movedHead.planId);
	});

	it("does not change plan identity when rendering shortens ids", () => {
		const longId = "abcdefghijklmnopqrstuvwxyz0123456789";
		const plan = buildPublicationPlan(
			snapshot({
				slices: [slice("feat1", null, [longId], "feat: aaa")],
				localBookmarks: [{ name: "feat1", commitId: `${longId}commit` }],
			}),
		);
		assert.equal(plan.planId.includes(displayPlanId(plan.planId)), true);
		assert.notEqual(plan.planId, displayPlanId(plan.planId));
		assert.ok(plan.slices[0].changeIds[0].length > 16);
	});
});

describe("navigation comments", () => {
	it("round-trips structured entries and HTML-escapes bookmark cells", () => {
		const entries: NavigationEntry[] = [
			{ prNumber: 74, bookmark: "feat-->|one", base: "main", status: "merged" },
			{ prNumber: 75, bookmark: "feat2", base: "feat-->|one", status: "draft" },
		];
		const body = buildNavigationComment(entries, "main");
		const dataLine = body.split("\n").find((line) => line.includes("kstack-stack-data"));
		assert.ok(dataLine);
		assert.equal(dataLine?.includes("feat-->"), false);
		assert.ok(body.includes(KSTACK_COMMENT_MARKER));
		assert.deepEqual(parseNavigationCommentEntries(body), entries);
	});

	it("parses a legacy Markdown table", () => {
		const body = `${KSTACK_COMMENT_MARKER}
<!-- kstack-stack-schema-v1 -->

## Stack navigation (kstack)

| PR | Bookmark | Base | Status |
|---|---|---|---|
| #10 | \`feat1\` | \`main\` | Merged |
| #11 | \`feat2\` | \`feat1\` | Open |
`;
		const entries = parseNavigationCommentEntries(body);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].prNumber, 10);
		assert.equal(entries[0].bookmark, "feat1");
		assert.equal(entries[0].status, "merged");
		assert.equal(entries[1].status, "open");
	});

	it("preserves merged ancestors and excludes removed descendants", () => {
		const prior = parseNavigationCommentEntries(`${KSTACK_COMMENT_MARKER}
<!-- kstack-stack-schema-v1 -->
| PR | Bookmark | Base |
|---|---|---|
| #10 | \`feat1\` | \`main\` |
| #11 | \`feat2\` | \`feat1\` |
| #12 | \`feat3\` | \`feat2\` |
`);
		const reconciled = reconcileStackEntries({
			published: [
				{ bookmark: "feat2", prNumber: 11, targetBase: "main", createPr: false },
				{ bookmark: "feat3", prNumber: 12, targetBase: "feat2", createPr: true },
			],
			priorEntries: prior,
			statusByPr: { 10: "merged", 11: "open", 12: "draft" },
			defaultBranch: "main",
		});
		assert.deepEqual(reconciled, [
			{ prNumber: 10, bookmark: "feat1", base: "main", status: "merged" },
			{ prNumber: 11, bookmark: "feat2", base: "main", status: "open" },
			{ prNumber: 12, bookmark: "feat3", base: "feat2", status: "draft" },
		]);
		assert.deepEqual(
			findNavigationAncestors(
				[
					{
						bookmark: "feat2",
						existingPr: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
							number: 11,
						} as OpenPullRequest,
					},
				],
				[
					{ prNumber: 10, bookmark: "feat1", base: "main", status: "merged" },
					{ prNumber: 11, bookmark: "feat2", base: "feat1", status: "open" },
					{ prNumber: 12, bookmark: "feat3", base: "feat2", status: "closed" },
				],
			),
			[{ prNumber: 10, bookmark: "feat1", base: "main", status: "merged" }],
		);
	});

	it("accepts only owned comments with a supported schema", () => {
		assert.equal(
			findKstackComment(
				[
					{ id: 1, body: `${KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v1 -->`, user: "someone-else" },
					{ id: 2, body: `${KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v999 -->`, user: "publisher" },
				],
				"publisher",
			),
			undefined,
		);
		assert.equal(
			findKstackComment([{ id: 7, body: `${KSTACK_COMMENT_MARKER}\nlegacy nav`, user: "publisher" }], "publisher")?.id,
			7,
		);
		assert.deepEqual(parseCommentMetadata(`${KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v1 -->`), {
			schemaVersion: 1,
		});
		assert.equal(parseCommentMetadata("just a comment"), undefined);
	});

	it("distinguishes merged, closed, and draft PR statuses", () => {
		assert.equal(parsePrStatus('{"state":"closed","merged":true,"draft":false}', 10), "merged");
		assert.equal(parsePrStatus('{"state":"closed","merged":false,"draft":false}', 11), "closed");
		assert.equal(parsePrStatus('{"state":"open","merged":false,"draft":true}', 12), "draft");
	});
});
