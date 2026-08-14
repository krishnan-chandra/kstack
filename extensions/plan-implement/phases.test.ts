import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { phaseErrorText, runApprovedWorkflow, runPostReviewPhases, type ApprovedWorkflowOptions, type PhaseEffects } from "./phases.ts";
import type { RunAgentOptions } from "./agent-runner.ts";
import type { AgentRunResult } from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const validPlan = "## Ordered implementation steps\n1. [STEP-1] Make the change.\n\n## Acceptance criteria\n- [AC-1] Tests pass.\n";
const validLedger = "## Execution Ledger\n- [STEP-1] Make the change. — done\n- [AC-1] Tests pass. — done\n";

function options(): ApprovedWorkflowOptions {
	return {
		task: "make change", mode: "stack", workLocation: "current", initialCwd: "/repo",
		promptsDir: "/prompts", plannerModel: "test/planner", implementerModel: "test/implementer",
		timeoutMinutes: 1, skillPaths: [], changePrompts: [], trunkSha: "a".repeat(40),
	};
}

function effects(overrides: Partial<PhaseEffects> = {}): { fx: PhaseEffects; notifications: string[] } {
	const notifications: string[] = [];
	const fx: PhaseEffects = {
		confirm: async () => true,
		notify: (message) => notifications.push(message),
		setStatus: () => {}, sendPhase: () => {}, isCurrent: () => true, isSessionCurrent: () => true,
		beginChild: () => new AbortController(), endChild: () => {},
		exec: async () => ({ code: 1, stdout: "", stderr: "not configured" }),
		requestPanelReview: async () => ({ handled: false }),
		...overrides,
	};
	return { fx, notifications };
}

describe("plan-implement phases", () => {
	it("rejects planner output when ledger creation fails", async () => {
		let implementerRan = false;
		const runAgent = async (input: RunAgentOptions): Promise<AgentRunResult> => {
			if (input.role === "planner") return { status: "completed", role: "planner", model: input.model, output: "no stable item ids", usage };
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
			if (input.role === "planner") return { status: "completed", role: "planner", model: input.model, output: validPlan, usage };
			chmodSync(input.planFile!, 0o600);
			writeFileSync(input.planFile!, "changed");
			return { status: "completed", role: "implementer", model: input.model, output: validLedger, usage };
		};
		const { fx, notifications } = effects({ runAgent, requestPanelReview: async () => { requestedReview = true; return { handled: false }; } });
		await runApprovedWorkflow(options(), fx);
		assert.equal(requestedReview, false);
		assert.match(notifications.join("\n"), /modified the approved plan/);
	});

	it("does not offer review or publish after implementer failure", async () => {
		let requestedReview = false;
		const runAgent = async (input: RunAgentOptions): Promise<AgentRunResult> => input.role === "planner"
			? { status: "completed", role: "planner", model: input.model, output: validPlan, usage }
			: { status: "failed", role: "implementer", model: input.model, error: "boom" };
		const { fx } = effects({ runAgent, requestPanelReview: async () => { requestedReview = true; return { handled: false }; } });
		await runApprovedWorkflow(options(), fx);
		assert.equal(requestedReview, false);
	});

	it("blocks publication when fixer postconditions fail", async () => {
		let confirms = 0;
		const { fx, notifications } = effects({
			confirm: async () => { confirms++; return true; },
			runAgent: async (input) => ({ status: "completed", role: input.role, model: input.model, output: validLedger, usage }),
			exec: async () => ({ code: 0, stdout: "wrong-branch\n", stderr: "" }),
		});
		await runPostReviewPhases("fix it", { ...options(), mode: "single" }, { workflowCwd: "/repo", workstreamCheckpoint: { branch: "expected", baseSha: "a".repeat(40) } }, fx);
		assert.equal(confirms, 1);
		assert.match(notifications.join("\n"), /postcondition failed/);
	});

	it("skips the publisher cleanly when confirmation is declined", async () => {
		let agentRan = false;
		const { fx } = effects({
			confirm: async () => false,
			runAgent: async (input) => { agentRan = true; return { status: "completed", role: input.role, model: input.model, output: "", usage }; },
		});
		await runPostReviewPhases("nothing", options(), { workflowCwd: "/repo" }, fx);
		assert.equal(agentRan, false);
	});

	it("formats failed and aborted phase errors", () => {
		assert.equal(phaseErrorText({ status: "failed", role: "planner", model: "m", error: "bad" }), "bad");
		assert.match(phaseErrorText({ status: "aborted", role: "fixer", model: "m" }), /aborted/);
	});
});
