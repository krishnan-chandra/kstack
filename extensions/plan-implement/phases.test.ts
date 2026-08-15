import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createGitBackend } from "../shared/vcs/git-backend.ts";
import type { RunAgentOptions } from "./agent-runner.ts";
import {
	type ApprovedWorkflowOptions,
	offerLandContinuation,
	type PhaseEffects,
	phaseErrorText,
	runApprovedWorkflow,
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

function effects(overrides: Partial<PhaseEffects> = {}): { fx: PhaseEffects; notifications: string[] } {
	const notifications: string[] = [];
	const fx: PhaseEffects = {
		confirm: async () => true,
		notify: (message) => notifications.push(message),
		setStatus: () => {},
		sendPhase: () => {},
		isCurrent: () => true,
		isSessionCurrent: () => true,
		beginChild: () => new AbortController(),
		endChild: () => {},
		backend: createGitBackend(async () => ({ code: 1, stdout: "", stderr: "not configured" })),
		requestPanelReview: async () => ({ handled: false }),
		resolvePublishedPr: async () => ({ ok: false, error: "not resolved (test default)" }),
		requestLand: async () => ({ handled: false }),
		requestAutopilot: async () => ({ handled: false }),
		...overrides,
	};
	return { fx, notifications };
}

describe("plan-implement phases", () => {
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
			requestPanelReview: async () => {
				requestedReview = true;
				return { handled: false };
			},
		});
		await runApprovedWorkflow(options(), fx);
		assert.equal(requestedReview, false);
		assert.match(notifications.join("\n"), /modified the approved plan/);
	});

	it("does not offer review or publish after implementer failure", async () => {
		let requestedReview = false;
		const runAgent = async (input: RunAgentOptions): Promise<AgentRunResult> =>
			input.role === "planner"
				? { status: "completed", role: "planner", model: input.model, output: validPlan, usage }
				: { status: "failed", role: "implementer", model: input.model, error: "boom" };
		const { fx } = effects({
			runAgent,
			requestPanelReview: async () => {
				requestedReview = true;
				return { handled: false };
			},
		});
		await runApprovedWorkflow(options(), fx);
		assert.equal(requestedReview, false);
	});

	it("blocks publication when fixer postconditions fail", async () => {
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
			backend: createGitBackend(async () => ({ code: 0, stdout: "wrong-branch\n", stderr: "" })),
		});
		await runPostReviewPhases(
			"fix it",
			{ ...options(), mode: "single" },
			{ workflowCwd: "/repo", workstreamCheckpoint: { ref: "expected", baseSha: "a".repeat(40) } },
			fx,
		);
		assert.equal(confirms, 1);
		assert.match(notifications.join("\n"), /postcondition failed/);
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
		await runPostReviewPhases("nothing", options(), { workflowCwd: "/repo" }, fx);
		assert.equal(agentRan, false);
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
							remainingBookmarks: [],
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
						remainingBookmarks: [],
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
						remainingBookmarks: [],
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
