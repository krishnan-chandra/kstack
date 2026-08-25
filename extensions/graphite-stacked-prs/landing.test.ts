import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import type { ExecFn } from "../shared/git-exec.ts";
import { requestGraphiteStackLanding } from "./landing.ts";

const bottomSha = "a".repeat(40);
const topSha = "b".repeat(40);
const prs = [
	{
		number: 11,
		url: "https://example/11",
		headRefName: "kstack/bottom",
		baseRefName: "main",
		headRefOid: bottomSha,
		isDraft: false,
	},
	{
		number: 12,
		url: "https://example/12",
		headRefName: "kstack/top",
		baseRefName: "kstack/bottom",
		headRefOid: topSha,
		isDraft: false,
	},
];

function harness() {
	const calls: string[] = [];
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (key === "git rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n", stderr: "" };
		if (key === "git rev-parse --path-format=absolute --git-common-dir") {
			return { code: 0, stdout: "/repo/.git\n", stderr: "" };
		}
		if (key === "gt --no-interactive trunk") return { code: 0, stdout: "main\n", stderr: "" };
		if (key.startsWith("gh pr view 12 ")) {
			return {
				code: 0,
				stdout: JSON.stringify({
					number: 12,
					url: "https://example/12",
					title: "Top",
					state: "OPEN",
					isDraft: false,
					headRefName: "kstack/top",
					baseRefName: "kstack/bottom",
					headRefOid: topSha,
					mergeable: "MERGEABLE",
					mergeStateStatus: "CLEAN",
					mergedAt: null,
					mergeCommit: null,
				}),
				stderr: "",
			};
		}
		if (key.startsWith("gh pr list --state open")) {
			const headIndex = args.indexOf("--head");
			const baseIndex = args.indexOf("--base");
			const matches =
				headIndex >= 0
					? prs.filter((pr) => pr.headRefName === args[headIndex + 1])
					: prs.filter((pr) => pr.baseRefName === args[baseIndex + 1]);
			return { code: 0, stdout: JSON.stringify(matches), stderr: "" };
		}
		if (key === "git branch --show-current") return { code: 0, stdout: "kstack/top\n", stderr: "" };
		if (key.includes("refs/heads/kstack/bottom")) return { code: 0, stdout: `${bottomSha}\n`, stderr: "" };
		if (key.includes("refs/heads/kstack/top")) return { code: 0, stdout: `${topSha}\n`, stderr: "" };
		if (key === "gt --no-interactive merge --dry-run" || key === "gt --no-interactive merge") {
			return {
				code: 0,
				stdout: key.endsWith("--dry-run")
					? "Preparing to merge:\n▸ kstack/top\n▸ kstack/bottom\n✅ Dry run complete.\n"
					: "merged\n",
				stderr: "",
			};
		}
		if (key === "gt --no-interactive sync") return { code: 0, stdout: "synced\n", stderr: "" };
		return { code: 1, stdout: "", stderr: `unexpected ${key}` };
	};
	return { calls, exec };
}

function ready(prNumber: number): AutopilotResult {
	const pr = prs.find((item) => item.number === prNumber)!;
	return {
		status: "merge-ready",
		mergeReady: true,
		cyclesCompleted: 0,
		blockedReasons: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		prState: {
			number: pr.number,
			title: "Ready",
			state: "open",
			isDraft: false,
			headSha: pr.headRefOid,
			verifiedHeadSha: pr.headRefOid,
			baseRef: pr.baseRefName,
			headRef: pr.headRefName,
			mergeable: "mergeable",
			mergeStateStatus: "CLEAN",
			checks: [],
			threads: [],
			hasUnresolvedThreads: false,
		},
	};
}

describe("Graphite stack landing", () => {
	it("verifies the exact prefix, dry-runs twice, merges once, and syncs after verification", async () => {
		const { calls, exec } = harness();
		const readiness: number[] = [];
		let released = false;
		let preview = "";
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => {
					readiness.push(pr);
					return { handled: true, outcome: ready(pr) };
				},
				confirmMerge: async (body) => {
					preview = body;
					return true;
				},
				now: () => 0,
				sleep: async () => {},
				acquireLock: () => ({
					ok: true,
					lock: {
						release: () => {
							released = true;
							return { ok: true };
						},
					},
				}),
				realpath: (path) => path,
				waitForMerge: async (_exec, _cwd, number) => ({
					merged: true,
					snapshot: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
						number,
					} as never,
				}),
			},
		);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "completed");
		assert.deepEqual(readiness, [11, 12]);
		assert.match(preview, /PR #11: kstack\/bottom -> main/);
		assert.match(preview, /PR #12: kstack\/top -> kstack\/bottom/);
		assert.equal(calls.filter((call) => call === "gt --no-interactive merge --dry-run").length, 2);
		assert.equal(calls.filter((call) => call === "gt --no-interactive merge").length, 1);
		assert.equal(calls.filter((call) => call === "gt --no-interactive sync").length, 1);
		assert.match(
			response.status === "stack" && "completedMutations" in response.outcome
				? (response.outcome.completedMutations?.join("\n") ?? "")
				: "",
			/Synchronized Graphite/,
		);
		assert.equal(released, true);
	});

	it("reports bounded-watch recovery when Graphite readiness stops on pending CI", async () => {
		const { exec } = harness();
		const pending: AutopilotResult = {
			status: "blocked",
			mergeReady: false,
			cyclesCompleted: 1,
			blockedReasons: ["Checks remain pending"],
			blockedCodes: ["ci-pending-after-watch"],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		};
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "watch" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async () => ({ handled: true, outcome: pending }),
				confirmMerge: async () => true,
				now: () => 0,
				sleep: async () => {},
			},
		);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "blocked");
		assert.match(
			response.status === "stack" && response.outcome.status === "blocked"
				? response.outcome.blockers.map((b) => b.message).join("\n")
				: "",
			/Watch is bounded.*Inspect PR #11.*retry \/land after CI settles/i,
		);
	});

	it("keeps a verified landing successful when post-merge sync fails", async () => {
		const base = harness();
		const exec: ExecFn = async (command, args, options) => {
			if (command === "gt" && args.join(" ") === "--no-interactive sync") {
				return { code: 1, stdout: "", stderr: "network unavailable" };
			}
			return base.exec(command, args, options);
		};
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => ({ handled: true, outcome: ready(pr) }),
				confirmMerge: async () => true,
				now: () => 0,
				sleep: async () => {},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
				waitForMerge: async (_exec, _cwd, number) => ({
					merged: true,
					snapshot: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
						number,
					} as never,
				}),
			},
		);
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "completed");
		assert.match(
			response.status === "stack" && "warnings" in response.outcome
				? (response.outcome.warnings?.join("\n") ?? "")
				: "",
			/gt sync failed/,
		);
	});

	it("rejects an explicit merge method before readiness or mutation", async () => {
		const { calls, exec } = harness();
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check", method: "squash" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async () => assert.fail("readiness must not run"),
				confirmMerge: async () => false,
				now: () => 0,
				sleep: async () => {},
			},
		);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "blocked");
		assert.match(
			response.status === "stack" && response.outcome.status === "blocked"
				? response.outcome.blockers.map((b) => b.message).join("\n")
				: "",
			/--method is not supported/,
		);
		assert.equal(
			calls.some((call) => call === "gt --no-interactive merge"),
			false,
		);
	});

	it("declines after the dry run without acquiring the mutation lock", async () => {
		const { calls, exec } = harness();
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => ({ handled: true, outcome: ready(pr) }),
				confirmMerge: async () => false,
				now: () => 0,
				sleep: async () => {},
				acquireLock: () => assert.fail("declining must not acquire the publication lock"),
			},
		);
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "declined");
		assert.equal(calls.filter((call) => call === "gt --no-interactive merge --dry-run").length, 1);
		assert.equal(
			calls.some((call) => call === "gt --no-interactive merge"),
			false,
		);
	});

	it("rejects a dry run that includes a branch outside the confirmed prefix", async () => {
		const base = harness();
		const exec: ExecFn = async (command, args, options) => {
			if (command === "gt" && args.join(" ") === "--no-interactive merge --dry-run") {
				return {
					code: 0,
					stdout: "Preparing to merge:\n▸ kstack/unexpected\n▸ kstack/top\n▸ kstack/bottom\n✅ Dry run complete.\n",
					stderr: "",
				};
			}
			return base.exec(command, args, options);
		};
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => ({ handled: true, outcome: ready(pr) }),
				confirmMerge: async () => assert.fail("confirmation must not run"),
				now: () => 0,
				sleep: async () => {},
			},
		);
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "blocked");
		assert.match(
			response.status === "stack" && response.outcome.status === "blocked"
				? response.outcome.blockers.map((b) => b.message).join("\n")
				: "",
			/unexpected/,
		);
	});

	it("binds the final landing plan to the exact readiness heads", async () => {
		const base = harness();
		let targetReads = 0;
		const changedTop = "c".repeat(40);
		const exec: ExecFn = async (command, args, options) => {
			const key = `${command} ${args.join(" ")}`;
			if (key.startsWith("gh pr view 12 ") && ++targetReads >= 2) {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 12,
						url: "https://example/12",
						title: "Top",
						state: "OPEN",
						isDraft: false,
						headRefName: "kstack/top",
						baseRefName: "kstack/bottom",
						headRefOid: changedTop,
						mergeable: "MERGEABLE",
						mergeStateStatus: "CLEAN",
						mergedAt: null,
						mergeCommit: null,
					}),
					stderr: "",
				};
			}
			if (key.includes("refs/heads/kstack/top") && targetReads >= 2) {
				return { code: 0, stdout: `${changedTop}\n`, stderr: "" };
			}
			return base.exec(command, args, options);
		};
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => ({ handled: true, outcome: ready(pr) }),
				confirmMerge: async () => assert.fail("confirmation must not run"),
				now: () => 0,
				sleep: async () => {},
			},
		);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "blocked");
		assert.match(
			response.status === "stack" && response.outcome.status === "blocked"
				? response.outcome.blockers.map((b) => b.message).join("\n")
				: "",
			/readiness checks/,
		);
	});

	it("uses native Graphite landing when the selected PR has an unpublished local descendant", async () => {
		const selectedSha = "d".repeat(40);
		const calls: string[] = [];
		const exec: ExecFn = async (command, args) => {
			const key = `${command} ${args.join(" ")}`;
			calls.push(key);
			if (key === "git rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n", stderr: "" };
			if (key === "git rev-parse --path-format=absolute --git-common-dir") {
				return { code: 0, stdout: "/repo/.git\n", stderr: "" };
			}
			if (key === "gt --no-interactive trunk") return { code: 0, stdout: "main\n", stderr: "" };
			if (key.startsWith("gh pr view 20 ")) {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 20,
						url: "https://example/20",
						title: "Selected",
						state: "OPEN",
						isDraft: false,
						headRefName: "kstack/selected",
						baseRefName: "main",
						headRefOid: selectedSha,
						mergeable: "MERGEABLE",
						mergeStateStatus: "CLEAN",
						mergedAt: null,
						mergeCommit: null,
					}),
					stderr: "",
				};
			}
			if (key.startsWith("gh pr list --state open")) return { code: 0, stdout: "[]", stderr: "" };
			if (key === "git branch --show-current") return { code: 0, stdout: "kstack/selected\n", stderr: "" };
			if (key === "gt --no-interactive children") {
				return { code: 0, stdout: "kstack/unpublished-child\n", stderr: "" };
			}
			if (key.includes("refs/heads/kstack/selected")) return { code: 0, stdout: `${selectedSha}\n`, stderr: "" };
			if (key === "gt --no-interactive merge --dry-run") {
				return {
					code: 0,
					stdout: "Preparing to merge:\n▸ kstack/selected\n✅ Dry run complete.\n",
					stderr: "",
				};
			}
			if (key === "gt --no-interactive merge") return { code: 0, stdout: "merged", stderr: "" };
			return { code: 1, stdout: "", stderr: `unexpected ${key}` };
		};
		const response = await requestGraphiteStackLanding(
			{ prNumber: 20, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async () => ({
					handled: true,
					outcome: {
						...ready(12),
						prState: {
							...ready(12).prState!,
							number: 20,
							headRef: "kstack/selected",
							baseRef: "main",
							headSha: selectedSha,
							verifiedHeadSha: selectedSha,
						},
					},
				}),
				confirmMerge: async () => true,
				now: () => 0,
				sleep: async () => {},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
				waitForMerge: async () => ({
					merged: true,
					snapshot: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
						number: 20,
					} as never,
				}),
			},
		);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "completed");
		assert.ok(calls.includes("gt --no-interactive children"));
		assert.ok(calls.includes("gt --no-interactive merge"));
	});

	it("marks closed or head-changed remote results blocked rather than queued", async () => {
		const { calls, exec } = harness();
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => ({ handled: true, outcome: ready(pr) }),
				confirmMerge: async () => true,
				now: () => 0,
				sleep: async () => {},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
				waitForMerge: async (_exec, _cwd, number) => ({
					merged: number === 11,
					snapshot: {
						number,
						url: `https://example/${number}`,
						title: "PR",
						state: number === 11 ? "MERGED" : "CLOSED",
						isDraft: false,
						headRef: number === 11 ? "kstack/bottom" : "kstack/top",
						baseRef: number === 11 ? "main" : "kstack/bottom",
						headOid: number === 11 ? bottomSha : "c".repeat(40),
						mergeable: "UNKNOWN",
						mergeStateStatus: "UNKNOWN",
						mergedAt: number === 11 ? "2026-08-17T00:00:00Z" : null,
						mergeCommitOid: number === 11 ? "e".repeat(40) : null,
					},
				}),
			},
		);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "partial");
		assert.equal(
			response.status === "stack" && "frontiers" in response.outcome
				? response.outcome.frontiers?.[1]?.state
				: undefined,
			"blocked",
		);
		assert.match(response.status === "stack" && "error" in response.outcome ? response.outcome.error : "", /CLOSED/);
		assert.equal(
			calls.some((call) => call === "gt --no-interactive sync"),
			false,
		);
	});

	it("preserves fulfilled merge evidence when another remote verifier rejects", async () => {
		const { exec } = harness();
		let bottomSettled = false;
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => ({ handled: true, outcome: ready(pr) }),
				confirmMerge: async () => true,
				now: () => 0,
				sleep: async () => {},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
				waitForMerge: async (_exec, _cwd, number) => {
					if (number === 12) throw new Error("GitHub unavailable");
					bottomSettled = true;
					return {
						merged: true,
						snapshot: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
							number,
						} as never,
					};
				},
			},
		);
		assert.equal(bottomSettled, true);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "partial");
		assert.equal(
			response.status === "stack" && "frontiers" in response.outcome
				? response.outcome.frontiers?.[0]?.state
				: undefined,
			"landed",
		);
		assert.equal(
			response.status === "stack" && "frontiers" in response.outcome
				? response.outcome.frontiers?.[1]?.state
				: undefined,
			"blocked",
		);
		assert.match(
			response.status === "stack" && "error" in response.outcome ? response.outcome.error : "",
			/GitHub unavailable/,
		);
	});

	it("blocks a stale topology under the lock and releases it", async () => {
		const base = harness();
		let listReads = 0;
		let released = false;
		const exec: ExecFn = async (command, args, options) => {
			if (command === "gh" && args[0] === "pr" && args[1] === "list" && ++listReads === 5) {
				return {
					code: 0,
					stdout: JSON.stringify([{ ...prs[0], headRefOid: "c".repeat(40) }]),
					stderr: "",
				};
			}
			return base.exec(command, args, options);
		};
		const response = await requestGraphiteStackLanding(
			{ prNumber: 12, readiness: "check" },
			{
				exec,
				cwd: "/repo",
				signal: new AbortController().signal,
				runAutopilot: async (_mode, pr) => ({ handled: true, outcome: ready(pr) }),
				confirmMerge: async () => true,
				now: () => 0,
				sleep: async () => {},
				acquireLock: () => ({
					ok: true,
					lock: {
						release: () => {
							released = true;
							return { ok: true };
						},
					},
				}),
				realpath: (path) => path,
			},
		);
		assert.equal(response.status, "stack");
		assert.equal(response.status === "stack" ? response.outcome.status : undefined, "blocked");
		assert.equal(
			base.calls.some((call) => call === "gt --no-interactive merge"),
			false,
		);
		assert.equal(released, true);
	});
});
