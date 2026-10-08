import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { VcsBackend } from "../shared/vcs/backend.ts";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import type { RoleRunner, RunAgentOptions } from "./agent-runner.ts";
import {
	type ApprovedWorkflowOptions,
	offerLandContinuation,
	type PhaseEffects,
	phaseErrorText,
	runApprovedWorkflow,
	runImplementationReview,
	runPostReviewPhases,
} from "./phases.ts";
import type { AgentRunResult } from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const validPlan =
	"## Ordered implementation steps\n1. [STEP-1] Make the change.\n\n## Acceptance criteria\n- [AC-1] Tests pass.\n";
const validLedger = "## Execution Ledger\n- [STEP-1] Make the change. — done\n- [AC-1] Tests pass. — done\n";

function options(): ApprovedWorkflowOptions {
	return {
		task: "make change",
		mode: "stack",
		workLocation: "current",
		initialCwd: "/repo",
		promptsDir: "/prompts",
		plannerModel: "test/planner",
		implementerModel: "test/implementer",
		timeoutMinutes: 1,
		skillPaths: [],
		changePrompts: [],
		trunkSha: "a".repeat(40),
	};
}

type RunRole = (input: RunAgentOptions) => Promise<AgentRunResult>;
type EffectOverrides = Omit<Partial<PhaseEffects>, "runner"> & { runner?: RoleRunner; runAgent?: RunRole };

function fakeRunner(run: RunRole): RoleRunner {
	return {
		tabId: "w1:t-test",
		paneId: (role) => `w1:p-${role}`,
		run,
		abortActive: async () => false,
		dispose: async () => {},
	};
}

const defaultRunRole: RunRole = async (input) => ({
	status: "completed",
	role: input.role,
	model: input.model,
	output: input.role === "planner" ? validPlan : validLedger,
	usage,
});

const approveCritique = "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n";
const reviseCritique = "Verdict: revise\n\n## Blocking\n- [B-1] Unsafe operation.\n\n## Suggestions\nNone.\n";
const defaultRunAdversaries: PhaseEffects["runAdversaries"] = async (request) =>
	request.adversaries.map((adversary) => ({
		status: "completed" as const,
		role: "adversary" as const,
		model: adversary.model,
		output: approveCritique,
		usage,
	}));

function defaultBackend(): VcsBackend {
	return Object.assign(new GitBackend(async () => ({ code: 1, stdout: "", stderr: "not configured" })), {
		reviewDiff: async () => ({ ok: true as const, diff: "" }),
	});
}

function effects(overrides: EffectOverrides = {}) {
	const notifications: string[] = [];
	const { runAgent, ...phaseOverrides } = overrides;
	const fx: PhaseEffects = {
		runner: overrides.runner ?? fakeRunner(runAgent ?? defaultRunRole),
		confirm: async () => true,
		notify: (message) => notifications.push(message),
		setStatus: () => {},
		sendPhase: () => {},
		isCurrent: () => true,
		isSessionCurrent: () => true,
		beginRole: () => new AbortController(),
		endRole: () => {},
		backend: defaultBackend(),
		runAdversaries: overrides.runAdversaries ?? defaultRunAdversaries,
		resolvePublishedPr: async () => ({ ok: false, error: "not resolved (test default)" }),
		requestLand: async () => ({ handled: false }),
		requestAutopilot: async () => ({ handled: false }),
		...phaseOverrides,
	};
	return { fx, notifications };
}

describe("plan-implement phases", () => {
	it("runs an adversary and persists a plan-only result without an implementer", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "kstack-plan-only-"));
		const roles: string[] = [];
		let requestedReview = false;
		const { fx, notifications } = effects({
			runAgent: async (input) => {
				roles.push(input.role);
				if (input.role === "planner") {
					return { status: "completed", role: "planner", model: input.model, output: validPlan, usage };
				}
				if (input.role === "adversary") {
					return {
						status: "completed",
						role: "adversary",
						model: input.model,
						output: "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n",
						usage,
					};
				}
				return assert.fail(`unexpected role ${input.role}`);
			},
			runAdversaries: async () => {
				requestedReview = true;
				return [];
			},
		});
		await runApprovedWorkflow(
			{
				...options(),
				initialCwd: cwd,
				planOnly: true,
				adversaryModel: "test/adversary:medium",
				adversaryPromptFile: "/prompts/adversary.md",
				maxRounds: 3,
			},
			fx,
		);
		assert.deepEqual(roles, ["planner", "adversary"]);
		assert.equal(requestedReview, false);
		assert.match(readFileSync(join(cwd, "plans", "change.md"), "utf8"), /STEP-1/);
		assert.match(notifications.join("\n"), /Plan-only run complete/);
	});

	it("displays the verified human edit as the final plan at approval and implementation", async () => {
		let visible = "";
		let debateFile = "";
		let critiques = 0;
		let implemented = "";
		const edited = validPlan.replace("Make the change.", "Human-approved different operation.");
		const { fx } = effects({
			sendPhase: (result) => {
				if (result.role === "planner" && result.status === "completed") visible = result.output;
			},
			confirm: async (title) => {
				if (title === "Adversarial debate exhausted") {
					writeFileSync(debateFile, edited);
					return true;
				}
				if (title === "Approve planner output?") {
					assert.equal(visible, edited);
					return true;
				}
				return false;
			},
			runAgent: async (input) => {
				if (input.role === "planner")
					return { status: "completed", role: input.role, model: input.model, output: validPlan, usage };
				if (input.role === "adversary") {
					debateFile = input.planFile ?? "";
					critiques++;
					return {
						status: "completed",
						role: input.role,
						model: input.model,
						output:
							critiques === 1
								? "Verdict: revise\n\n## Blocking\n- [B-1] Unsafe operation.\n\n## Suggestions\nNone.\n"
								: "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n",
						usage,
					};
				}
				implemented = readFileSync(input.planFile ?? "", "utf8");
				return { status: "failed", role: input.role, model: input.model, error: "stop after inspection" };
			},
		});
		await runApprovedWorkflow(
			{ ...options(), adversaryModel: "test/adversary", adversaryPromptFile: "/prompt.md", maxRounds: 1 },
			fx,
		);
		assert.equal(implemented, `# Approved implementation plan\n\n${edited}\n`);
		assert.equal(critiques, 2);
	});

	it("rejects planner output when ledger creation fails", async () => {
		let implementerRan = false;
		const runAgent = async (input: RunAgentOptions): Promise<AgentRunResult> => {
			if (input.role === "planner")
				return { status: "completed", role: "planner", model: input.model, output: "no stable item ids", usage };
			implementerRan = true;
			return { status: "completed", role: input.role, model: input.model, output: validLedger, usage };
		};
		const { fx, notifications } = effects({ runAgent });
		await runApprovedWorkflow(options(), fx);
		assert.equal(implementerRan, false);
		assert.match(notifications.join("\n"), /cannot be approved/);
	});

	it("refuses an implementer that mutates the immutable plan", async () => {
		let requestedReview = false;
		const runAgent = async (input: RunAgentOptions): Promise<AgentRunResult> => {
			if (input.role === "planner")
				return { status: "completed", role: "planner", model: input.model, output: validPlan, usage };
			chmodSync(input.planFile!, 0o600);
			writeFileSync(input.planFile!, "changed");
			return { status: "completed", role: "implementer", model: input.model, output: validLedger, usage };
		};
		const { fx, notifications } = effects({
			runAgent,
			runAdversaries: async () => {
				requestedReview = true;
				return [];
			},
		});
		await runApprovedWorkflow(options(), fx);
		assert.equal(requestedReview, false);
		assert.match(notifications.join("\n"), /modified the approved plan/);
	});

	it("reviews the implemented change against the pinned base", async () => {
		let reviewBase: string | undefined;
		const backend = Object.assign(new GitBackend(async () => ({ code: 1, stdout: "", stderr: "unused" })), {
			reviewDiff: async (_cwd: string, baseSha: string) => {
				reviewBase = baseSha;
				return { ok: true as const, diff: "diff --git a/a.ts b/a.ts\n" };
			},
		});
		const { fx } = effects({ backend });

		await runApprovedWorkflow(
			{
				...options(),
				adversaryModels: ["test/adversary:medium"],
				reviewAdversaryPromptFile: "/prompts/implementation-adversary.md",
			},
			fx,
		);

		assert.equal(reviewBase, "a".repeat(40));
	});

	it("does not offer review or publish after implementer failure", async () => {
		let requestedReview = false;
		const runAgent = async (input: RunAgentOptions): Promise<AgentRunResult> =>
			input.role === "planner"
				? { status: "completed", role: "planner", model: input.model, output: validPlan, usage }
				: { status: "failed", role: "implementer", model: input.model, error: "boom" };
		const { fx } = effects({
			runAgent,
			runAdversaries: async () => {
				requestedReview = true;
				return [];
			},
		});
		await runApprovedWorkflow(options(), fx);
		assert.equal(requestedReview, false);
	});

	it("stops the review loop when the fixer fails its postcondition", async () => {
		let confirms = 0;
		const { fx, notifications } = effects({
			confirm: async () => {
				confirms++;
				return true;
			},
			runAgent: async (input) => ({
				status: "completed",
				role: input.role,
				model: input.model,
				output: validLedger,
				usage,
			}),
			runAdversaries: async (request) =>
				request.adversaries.map((adversary) => ({
					status: "completed" as const,
					role: "adversary" as const,
					model: adversary.model,
					output: reviseCritique,
					usage,
				})),
			backend: new GitBackend(async () => ({ code: 0, stdout: "wrong-branch\n", stderr: "" })),
		});
		await runImplementationReview(
			validPlan,
			validLedger,
			"a".repeat(40),
			{
				adversaries: [{ label: "adversary-1", model: "test/adversary" }],
				systemPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 3,
				reviewTimeoutMinutes: 10,
			},
			{ ...options(), mode: "single" },
			{ workflowCwd: "/repo", workstreamCheckpoint: { ref: "expected", baseSha: "a".repeat(40) } },
			fx,
		);
		assert.equal(confirms, 1);
		assert.match(notifications.join("\n"), /postcondition failed/);
	});

	it("approves without running the fixer when every adversary approves", async () => {
		const roles: string[] = [];
		let reviews = 0;
		const { fx, notifications } = effects({
			runAgent: async (input) => {
				roles.push(input.role);
				return { status: "completed", role: input.role, model: input.model, output: validLedger, usage };
			},
			runAdversaries: async (request) => {
				reviews++;
				return request.adversaries.map((adversary) => ({
					status: "completed" as const,
					role: "adversary" as const,
					model: adversary.model,
					output: approveCritique,
					usage,
				}));
			},
		});
		const outcome = await runImplementationReview(
			validPlan,
			validLedger,
			"a".repeat(40),
			{
				adversaries: [
					{ label: "adversary-1", model: "test/a" },
					{ label: "adversary-2", model: "test/b" },
				],
				systemPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 3,
				reviewTimeoutMinutes: 10,
			},
			options(),
			{ workflowCwd: "/repo" },
			fx,
		);
		assert.equal(outcome?.approved, true);
		assert.equal(reviews, 1);
		assert.equal(roles.includes("fixer"), false);
		assert.match(notifications.join("\n"), /approved by all 2/);
	});

	it("re-reviews after the fixer addresses blocking findings", async () => {
		const roles: string[] = [];
		let reviews = 0;
		const { fx } = effects({
			runAgent: async (input) => {
				roles.push(input.role);
				return { status: "completed", role: input.role, model: input.model, output: validLedger, usage };
			},
			runAdversaries: async (request) => {
				reviews++;
				const output = reviews === 1 ? reviseCritique : approveCritique;
				return request.adversaries.map((adversary) => ({
					status: "completed" as const,
					role: "adversary" as const,
					model: adversary.model,
					output,
					usage,
				}));
			},
		});
		const outcome = await runImplementationReview(
			validPlan,
			validLedger,
			"a".repeat(40),
			{
				adversaries: [{ label: "adversary-1", model: "test/a" }],
				systemPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 3,
				reviewTimeoutMinutes: 10,
			},
			options(),
			{ workflowCwd: "/repo" },
			fx,
		);
		assert.equal(outcome?.approved, true);
		assert.equal(reviews, 2);
		assert.equal(roles.filter((role) => role === "fixer").length, 1);
	});

	it("does not approve when an adversary fails to return a critique", async () => {
		const { fx } = effects({
			runAdversaries: async (request) =>
				request.adversaries.map((adversary, index) =>
					index === 0
						? {
								status: "completed" as const,
								role: "adversary" as const,
								model: adversary.model,
								output: approveCritique,
								usage,
							}
						: {
								status: "failed" as const,
								role: "adversary" as const,
								model: adversary.model,
								error: "timed out",
							},
				),
		});
		const outcome = await runImplementationReview(
			validPlan,
			validLedger,
			"a".repeat(40),
			{
				adversaries: [
					{ label: "adversary-1", model: "test/a" },
					{ label: "adversary-2", model: "test/b" },
				],
				systemPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 1,
				reviewTimeoutMinutes: 10,
			},
			options(),
			{ workflowCwd: "/repo" },
			fx,
		);
		assert.equal(outcome?.approved, false);
		assert.match(outcome?.verdict ?? "", /adversary-2/);
	});

	it("does not publish when the adversarial review does not approve", async () => {
		let published = false;
		const { fx, notifications } = effects({
			runAdversaries: async (request) =>
				request.adversaries.map((adversary) => ({
					status: "completed" as const,
					role: "adversary" as const,
					model: adversary.model,
					output: reviseCritique,
					usage,
				})),
			requestStackPublication: async () => {
				published = true;
				return { handled: false };
			},
		});
		await runApprovedWorkflow(
			{
				...options(),
				adversaryModels: ["test/adversary"],
				reviewAdversaryPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 1,
			},
			fx,
		);
		assert.equal(published, false);
		assert.match(notifications.join("\n"), /publication was not offered/);
	});

	it("does not publish when the fixer fails after changing files", async () => {
		let published = false;
		const { fx, notifications } = effects({
			runAgent: async (input) => {
				if (input.role === "planner")
					return { status: "completed", role: input.role, model: input.model, output: validPlan, usage };
				if (input.role === "fixer")
					return { status: "failed", role: input.role, model: input.model, error: "left partial edits" };
				return { status: "completed", role: input.role, model: input.model, output: validLedger, usage };
			},
			runAdversaries: async (request) =>
				request.adversaries.map((adversary) => ({
					status: "completed" as const,
					role: "adversary" as const,
					model: adversary.model,
					output: reviseCritique,
					usage,
				})),
			requestStackPublication: async () => {
				published = true;
				return { handled: false };
			},
		});
		await runApprovedWorkflow(
			{
				...options(),
				adversaryModels: ["test/adversary"],
				reviewAdversaryPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 3,
			},
			fx,
		);
		assert.equal(published, false);
		assert.match(notifications.join("\n"), /Review fixer did not complete/);
		assert.match(notifications.join("\n"), /publication was not offered/);
	});

	it("fails the review round when the diff cannot be computed", async () => {
		let adversaryRan = false;
		const backend = Object.assign(new GitBackend(async () => ({ code: 1, stdout: "", stderr: "unused" })), {
			reviewDiff: async () => ({ ok: false as const, error: "no merge base" }),
		});
		const { fx } = effects({
			backend,
			runAdversaries: async (request) => {
				adversaryRan = true;
				return request.adversaries.map((adversary) => ({
					status: "completed" as const,
					role: "adversary" as const,
					model: adversary.model,
					output: approveCritique,
					usage,
				}));
			},
		});
		const outcome = await runImplementationReview(
			validPlan,
			validLedger,
			"a".repeat(40),
			{
				adversaries: [{ label: "adversary-1", model: "test/adversary" }],
				systemPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 1,
				reviewTimeoutMinutes: 10,
			},
			options(),
			{ workflowCwd: "/repo" },
			fx,
		);
		assert.equal(outcome?.approved, false);
		assert.equal(adversaryRan, false);
		assert.match(outcome?.failures[0] ?? "", /diff could not be computed/);
	});

	it("gives the fixer the approved plan and execution ledger", async () => {
		let fixerPlan = "";
		let fixerLedger = "";
		let reviews = 0;
		const { fx } = effects({
			runAgent: async (input) => {
				if (input.role === "fixer") {
					fixerPlan = input.planFile ? readFileSync(input.planFile, "utf8") : "";
					fixerLedger = input.ledgerFile ? readFileSync(input.ledgerFile, "utf8") : "";
				}
				return { status: "completed", role: input.role, model: input.model, output: validLedger, usage };
			},
			runAdversaries: async (request) => {
				reviews++;
				const output = reviews === 1 ? reviseCritique : approveCritique;
				return request.adversaries.map((adversary) => ({
					status: "completed" as const,
					role: "adversary" as const,
					model: adversary.model,
					output,
					usage,
				}));
			},
		});
		await runImplementationReview(
			validPlan,
			validLedger,
			"a".repeat(40),
			{
				adversaries: [{ label: "adversary-1", model: "test/adversary" }],
				systemPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 2,
				reviewTimeoutMinutes: 10,
			},
			options(),
			{ workflowCwd: "/repo" },
			fx,
		);
		assert.match(fixerPlan, /STEP-1/);
		assert.match(fixerLedger, /Execution Ledger/);
	});

	it("does not offer the fixer when any adversary fails in the same round", async () => {
		const roles: string[] = [];
		let reviews = 0;
		const { fx, notifications } = effects({
			runAgent: async (input) => {
				roles.push(input.role);
				return { status: "completed", role: input.role, model: input.model, output: validLedger, usage };
			},
			runAdversaries: async (request) => {
				reviews++;
				return request.adversaries.map((adversary, index) =>
					index === 0
						? {
								status: "completed" as const,
								role: "adversary" as const,
								model: adversary.model,
								output: reviseCritique,
								usage,
							}
						: {
								status: "failed" as const,
								role: "adversary" as const,
								model: adversary.model,
								error: "timed out",
							},
				);
			},
		});
		const outcome = await runImplementationReview(
			validPlan,
			validLedger,
			"a".repeat(40),
			{
				adversaries: [
					{ label: "adversary-1", model: "test/a" },
					{ label: "adversary-2", model: "test/b" },
				],
				systemPromptFile: "/prompts/implementation-adversary.md",
				maxRounds: 3,
				reviewTimeoutMinutes: 10,
			},
			options(),
			{ workflowCwd: "/repo" },
			fx,
		);
		assert.equal(outcome?.approved, false);
		assert.equal(reviews, 1);
		assert.equal(roles.includes("fixer"), false);
		assert.match(notifications.join("\n"), /did not complete/);
	});

	it("offers autopilot and landing after a completed single-mode publisher", async () => {
		let resolved = 0;
		let autopilotRan = false;
		const { fx } = effects({
			runAgent: async (input) => ({
				status: "completed",
				role: input.role,
				model: input.model,
				output: "published",
				usage,
			}),
			resolvePublishedPr: async () => {
				resolved++;
				return { ok: true, prNumber: 42 };
			},
			requestAutopilot: async () => {
				autopilotRan = true;
				return {
					handled: true,
					outcome: { status: "merge-ready", mergeReady: true, cyclesCompleted: 1, blockedReasons: [], usage },
				};
			},
		});
		await runPostReviewPhases("nothing", { ...options(), mode: "single" }, { workflowCwd: "/repo" }, fx);
		assert.equal(resolved, 2); // autopilot phase, landing phase
		assert.equal(autopilotRan, true);

		let resolvedFailed = 0;
		const { fx: failedFx } = effects({
			runAgent: async (input) =>
				input.role === "publisher"
					? { status: "failed", role: input.role, model: input.model, error: "failed" }
					: { status: "completed", role: input.role, model: input.model, output: "fixed", usage },
			resolvePublishedPr: async () => {
				resolvedFailed++;
				return { ok: false, error: "none" };
			},
		});
		await runPostReviewPhases("nothing", { ...options(), mode: "single" }, { workflowCwd: "/repo" }, failedFx);
		assert.equal(resolvedFailed, 0);
	});

	it("skips the publisher cleanly when confirmation is declined", async () => {
		let agentRan = false;
		const { fx } = effects({
			confirm: async () => false,
			runAgent: async (input) => {
				agentRan = true;
				return { status: "completed", role: input.role, model: input.model, output: "", usage };
			},
		});
		await runPostReviewPhases("nothing", { ...options(), mode: "single" }, { workflowCwd: "/repo" }, fx);
		assert.equal(agentRan, false);
	});

	it("uses parent-owned single publication before launching the metadata publisher", async () => {
		let published = false;
		let publisherSawPublication = false;
		const backend = Object.assign(new GitBackend(async () => ({ code: 1, stdout: "", stderr: "unused" })), {
			parentOwnedPublication: {
				publish: async () => {
					published = true;
					return { ok: true } as const;
				},
			},
		});
		const { fx } = effects({
			backend,
			confirm: async () => true,
			resolvePublishedPr: async () => ({ ok: true, prNumber: 42 }),
			runAgent: async (input) => {
				if (input.role === "publisher") {
					publisherSawPublication = published;
					assert.match(input.taskFile ? readFileSync(input.taskFile, "utf8") : "", /Parent-published PR: #42/);
				}
				return { status: "completed", role: input.role, model: input.model, output: "done", usage };
			},
		});
		await runPostReviewPhases(
			"nothing",
			{ ...options(), mode: "single" },
			{ workflowCwd: "/repo", workstreamCheckpoint: { ref: "kstack/fix", baseSha: "a".repeat(40) } },
			fx,
		);
		assert.equal(publisherSawPublication, true);
	});

	it("does not launch the stack publisher agent when structural publication is not completed", async () => {
		let publisherRan = false;
		const { fx, notifications } = effects({
			runAgent: async (input) => {
				if (input.role === "publisher") publisherRan = true;
				return { status: "completed", role: input.role, model: input.model, output: "fixed", usage };
			},
			requestStackPublication: async () => ({ handled: true, outcome: { status: "declined" } }),
		});
		await runPostReviewPhases("nothing", options(), { workflowCwd: "/repo" }, fx);
		assert.equal(publisherRan, false);
		assert.match(notifications.join("\n"), /declined/);
	});

	it("launches metadata repair for drafts created by a partial publication", async () => {
		let trustedMap = "";
		const { fx, notifications } = effects({
			runAgent: async (input) => {
				if (input.role === "publisher") {
					const task = readFileSync(input.taskFile!, "utf8");
					const mapPath = task.match(/Trusted published PR map: (.+)/)?.[1];
					assert.ok(mapPath);
					trustedMap = readFileSync(mapPath, "utf8");
				}
				return { status: "completed", role: input.role, model: input.model, output: "fixed", usage };
			},
			requestStackPublication: async () => ({
				handled: true,
				outcome: {
					status: "partial",
					planId: "plan",
					completedActions: [{ kind: "create-draft-pr", ref: "feat1", prNumber: 11, url: "https://example/11" }],
					failedAction: { kind: "create-draft-pr", ref: "feat2", error: "creation failed" },
					publication: {
						topRef: "feat1",
						pullRequests: [{ ref: "feat1", baseRef: "main", prNumber: 11, url: "https://example/11", draft: true }],
					},
				},
			}),
		});
		await runPostReviewPhases("nothing", options(), { workflowCwd: "/repo" }, fx);
		assert.match(trustedMap, /"prNumber": 11/);
		assert.match(notifications.join("\n"), /partial/);
	});

	it("does not launch metadata repair for a partial publication without created drafts", async () => {
		let publisherRan = false;
		const { fx } = effects({
			runAgent: async (input) => {
				if (input.role === "publisher") publisherRan = true;
				return { status: "completed", role: input.role, model: input.model, output: "fixed", usage };
			},
			requestStackPublication: async () => ({
				handled: true,
				outcome: {
					status: "partial",
					planId: "plan",
					completedActions: [{ kind: "push-bookmark", ref: "feat1" }],
					failedAction: { kind: "create-draft-pr", ref: "feat1", error: "creation failed" },
				},
			}),
		});
		await runPostReviewPhases("nothing", options(), { workflowCwd: "/repo" }, fx);
		assert.equal(publisherRan, false);
	});

	it("writes the trusted PR map and can decline metadata after completed publication", async () => {
		let publisherRan = false;
		const { fx, notifications } = effects({
			confirm: async () => false,
			runAgent: async (input) => {
				if (input.role === "publisher") publisherRan = true;
				return { status: "completed", role: input.role, model: input.model, output: "fixed", usage };
			},
			requestStackPublication: async () => ({
				handled: true,
				outcome: {
					status: "completed",
					planId: "plan",
					completedActions: [],
					publication: {
						topRef: "feat2",
						pullRequests: [
							{
								ref: "feat2",
								baseRef: null,
								prNumber: 12,
								url: "https://example/12",
								draft: true,
							},
						],
					},
				},
			}),
		});
		await runPostReviewPhases("nothing", options(), { workflowCwd: "/repo" }, fx);
		assert.equal(publisherRan, false);
		assert.match(notifications.join("\n"), /left unchanged/);
	});

	describe("offerLandContinuation", () => {
		it("lands a resolved PR after confirmation", async () => {
			let requested: { prNumber: number; cwd: string } | undefined;
			const { fx, notifications } = effects({
				resolvePublishedPr: async () => ({ ok: true, prNumber: 7 }),
				requestLand: async (prNumber, cwd) => {
					requested = { prNumber, cwd };
					return {
						handled: true,
						outcome: {
							status: "landed",
							frontiers: [],
							autopilotRan: true,
							remainingRefs: [],
							blockers: [],
							completedMutations: ["merged"],
						},
					};
				},
			});
			await offerLandContinuation({ mode: "single" }, { workflowCwd: "/repo" }, fx);
			assert.deepEqual(requested, { prNumber: 7, cwd: "/repo" });
			assert.match(notifications.join("\n"), /Landing landed/);
		});

		it("does not land when the offer is declined", async () => {
			let requested = false;
			const { fx } = effects({
				confirm: async () => false,
				resolvePublishedPr: async () => ({ ok: true, prNumber: 7 }),
				requestLand: async () => {
					requested = true;
					return { handled: false };
				},
			});
			await offerLandContinuation({ mode: "single" }, { workflowCwd: "/repo" }, fx);
			assert.equal(requested, false);
		});

		it("reports resolution failure without confirmation", async () => {
			let confirmed = false;
			const { fx, notifications } = effects({
				confirm: async () => {
					confirmed = true;
					return true;
				},
				resolvePublishedPr: async () => ({ ok: false, error: "Expected exactly one open PR" }),
			});
			await offerLandContinuation({ mode: "single" }, { workflowCwd: "/repo" }, fx);
			assert.equal(confirmed, false);
			assert.match(notifications.join("\n"), /Landing not offered/);
		});

		it("reports an unavailable land extension", async () => {
			const { fx, notifications } = effects({ resolvePublishedPr: async () => ({ ok: true, prNumber: 7 }) });
			await offerLandContinuation({ mode: "single" }, { workflowCwd: "/repo" }, fx);
			assert.match(notifications.join("\n"), /not loaded/);
		});

		it("skips stack mode and stale runs", async () => {
			let resolved = false;
			const { fx } = effects({
				resolvePublishedPr: async () => {
					resolved = true;
					return { ok: true, prNumber: 7 };
				},
			});
			await offerLandContinuation({ mode: "stack" }, { workflowCwd: "/repo" }, fx);
			assert.equal(resolved, false);
			let current = true;
			let confirmed = false;
			const { fx: staleFx } = effects({
				isCurrent: () => current,
				resolvePublishedPr: async () => {
					current = false;
					return { ok: true, prNumber: 7 };
				},
				confirm: async () => {
					confirmed = true;
					return true;
				},
			});
			await offerLandContinuation({ mode: "single" }, { workflowCwd: "/repo" }, staleFx);
			assert.equal(confirmed, false);
		});

		it("reports partial landing as a warning", async () => {
			const notices: Array<[string, string]> = [];
			const { fx } = effects({
				resolvePublishedPr: async () => ({ ok: true, prNumber: 7 }),
				requestLand: async () => ({
					handled: true,
					outcome: {
						status: "partially-landed",
						frontiers: [],
						autopilotRan: true,
						remainingRefs: [],
						blockers: ["verification pending"],
						completedMutations: ["merge queued"],
					},
				}),
				notify: (message, level) => notices.push([message, level]),
			});
			await offerLandContinuation({ mode: "single" }, { workflowCwd: "/repo" }, fx);
			assert.deepEqual(notices.at(-1), ["Landing partially-landed — verification pending", "warning"]);
		});

		it("reports blocked landing as a warning", async () => {
			const notices: Array<[string, string]> = [];
			const { fx } = effects({
				resolvePublishedPr: async () => ({ ok: true, prNumber: 7 }),
				requestLand: async () => ({
					handled: true,
					outcome: {
						status: "blocked",
						frontiers: [],
						autopilotRan: true,
						remainingRefs: [],
						blockers: ["CI failing"],
						completedMutations: [],
					},
				}),
				notify: (message, level) => notices.push([message, level]),
			});
			await offerLandContinuation({ mode: "single" }, { workflowCwd: "/repo" }, fx);
			assert.deepEqual(notices.at(-1), ["Landing blocked — CI failing", "warning"]);
		});
	});

	it("formats failed and aborted phase errors", () => {
		assert.equal(phaseErrorText({ status: "failed", role: "planner", model: "m", error: "bad" }), "bad");
		assert.match(phaseErrorText({ status: "aborted", role: "fixer", model: "m" }), /aborted/);
	});
});
