import assert from "node:assert/strict";
import test from "node:test";
import { type ConfigLoad, DEFAULT_SYNTHESIS, type ResolveDeps } from "./config.ts";
import { type ReviewPipelineEffects, type ReviewPipelineOps, resolvePanel, runReviewPipeline } from "./run-phases.ts";
import type { PanelConfig, ScopeBundle } from "./types.ts";

const panelConfig: PanelConfig = {
	reviewers: [
		{ label: "one", model: "test/one", thinking: "medium" },
		{ label: "two", model: "test/two" },
	],
	maxConcurrency: 2,
	timeoutMinutes: 3,
	maxRuntimeMinutes: 7,
	synthesis: { model: "test/lead", thinking: "medium" },
};

function deps(available: string[], active = { provider: "active", id: "model" }): ResolveDeps {
	const models = new Set(available);
	return {
		find: (provider, modelId) => (models.has(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined),
		scopedModels: [],
		activeModel: active,
	};
}

function loaded(config = panelConfig): ConfigLoad {
	return { status: "loaded", config, path: "/agent/kstack.json" };
}

const testScope: ScopeBundle = {
	path: "/tmp/bundle.md",
	dir: "/tmp",
	repoRoot: "/repo",
	headSha: "head",
	baseSha: "base",
	baseRef: "main",
	baseStrategy: "main",
	fileCount: 1,
	diffBytes: 1,
	untrackedCount: 0,
	binaryCount: 0,
	truncated: false,
	contextFilesTouched: false,
	generatedAt: "now",
};

const testPipelineInput: Parameters<typeof runReviewPipeline>[0] = {
	scope: testScope,
	intent: "review",
	options: {},
	resolution: {
		reviewers: panelConfig.reviewers,
		maxConcurrency: 2,
		warnings: [],
		synthesis: { model: "test/lead", cliId: "test/lead" },
		timeoutMinutes: 1,
		maxRuntimeMinutes: 2,
	},
};

test("invalid configuration returns its original path and error", () => {
	const result = resolvePanel({ status: "invalid", path: "/agent/kstack.json", error: "bad reviewers" }, deps([]));
	assert.deepEqual(result, {
		ok: false,
		error: "Invalid /agent/kstack.json: bad reviewers",
		warnings: [],
	});
});

test("configured synthesis resolution failure is fatal", () => {
	const result = resolvePanel(loaded(), deps(["test/one", "test/two"]));
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /Configured synthesis model is unavailable/);
});

test("missing config falls back from unavailable synthesis to first reviewer", () => {
	const available = new Set(["anthropic/claude-sonnet-5", "openrouter/deepseek/deepseek-v4-pro"]);
	const result = resolvePanel(
		{ status: "missing", path: "/agent/kstack.json" },
		{
			find: (provider, modelId) => (available.has(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined),
			scopedModels: [],
		},
	);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.resolution.synthesis.model, "anthropic/claude-sonnet-5");
		assert.equal(result.resolution.synthesis.cliId, "anthropic/claude-sonnet-5");
		assert.ok(result.resolution.warnings.some((warning) => warning.includes("Using the first reviewer model instead")));
	}
});

test("synthesis thinking is included in the CLI model id", () => {
	const result = resolvePanel(loaded(), deps(["test/one", "test/two", "test/lead"]));
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.resolution.synthesis.cliId, "test/lead:medium");
});

test("reviewer warnings precede synthesis warnings", () => {
	const result = resolvePanel({ status: "missing", path: "/agent/kstack.json" }, deps([DEFAULT_SYNTHESIS.model]));
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.match(result.resolution.warnings[0] ?? "", /Default panel models unavailable/);
		assert.match(result.resolution.warnings[1] ?? "", /Only one model is available/);
	}
});

test("loaded timeout values are preserved", () => {
	const result = resolvePanel(loaded(), deps(["test/one", "test/two", "test/lead"]));
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.resolution.timeoutMinutes, 3);
		assert.equal(result.resolution.maxRuntimeMinutes, 7);
	}
});

test("missing config uses default timeout values", () => {
	const result = resolvePanel({ status: "missing", path: "/agent/kstack.json" }, deps([DEFAULT_SYNTHESIS.model]));
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.resolution.timeoutMinutes, 10);
		assert.equal(result.resolution.maxRuntimeMinutes, 30);
	}
});

test("pipeline reports every reviewer diagnostic when the panel fails", async () => {
	const notifications: string[] = [];
	const fx: ReviewPipelineEffects = {
		isCurrent: () => true,
		notify: (message) => notifications.push(message),
		setCompactStatus: () => {},
		createDashboard: () => undefined,
		runSignal: undefined,
		beginSynthesisPhase: () => undefined,
		waitForIdle: async () => {},
		sendVerdict: () => assert.fail("failed panels must not emit a verdict"),
	};
	const ops: ReviewPipelineOps = {
		runPanel: async () => ({
			results: [
				{ status: "failed", label: "one", model: "test/one", error: "timeout" },
				{ status: "failed", label: "two", model: "test/two", error: "bad output" },
			],
			completed: 0,
			failed: 2,
			aborted: 0,
		}),
		runReviewer: async () => {
			throw new Error("reviewer runner should be owned by the fake panel");
		},
	};
	const result = await runReviewPipeline(testPipelineInput, fx, ops);
	assert.equal(result.status, "failed");
	if (result.status === "failed") {
		assert.match(result.error, /one \(test\/one\): failed — timeout/);
		assert.match(result.error, /two \(test\/two\): failed — bad output/);
	}
	assert.match(notifications[0] ?? "", /All reviewers failed; nothing to synthesize/);
});

test("a partially aborted panel advances to synthesis with a fresh signal", async () => {
	const panelController = new AbortController();
	const synthesisController = new AbortController();
	const notifications: string[] = [];
	let verdictSent = false;
	const fx: ReviewPipelineEffects = {
		isCurrent: () => true,
		notify: (message) => notifications.push(message),
		setCompactStatus: () => {},
		createDashboard: () => undefined,
		runSignal: panelController.signal,
		beginSynthesisPhase: () => synthesisController.signal,
		waitForIdle: async () => {},
		sendVerdict: () => {
			verdictSent = true;
		},
	};
	const ops: ReviewPipelineOps = {
		runPanel: async (reviewers, _maxConcurrency, runOne) => {
			const aborted = await runOne(reviewers[0], 0);
			return {
				results: [
					{
						status: "completed",
						label: "finished",
						model: "test/finished",
						output: "no findings",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					},
					aborted,
				],
				completed: 1,
				failed: 0,
				aborted: 1,
			};
		},
		runReviewer: async (input) => {
			if (input.spec.label === "lead") {
				assert.equal(input.signal, synthesisController.signal);
				assert.equal(input.signal.aborted, false);
				return {
					status: "completed",
					label: "lead",
					model: input.model,
					output: "final verdict",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				};
			}
			assert.equal(input.signal, panelController.signal);
			assert.match(input.task, /complete independent thermo-nuclear review of the entire bundle/);
			assert.match(input.task, /every relevant rubric dimension and the full Approval Bar/);
			panelController.abort();
			assert.equal(input.signal.aborted, true);
			return { status: "aborted", label: input.spec.label, model: input.model };
		},
	};
	const result = await runReviewPipeline(testPipelineInput, fx, ops);

	assert.equal(result.status, "completed");
	assert.equal(verdictSent, true);
	assert.match(notifications[0] ?? "", /1 completed, 1 aborted.*Proceeding to synthesis/);
});

test("pipeline aborts when a fresh synthesis phase cannot begin", async () => {
	let reviewerStarted = false;
	let verdictSent = false;
	const fx: ReviewPipelineEffects = {
		isCurrent: () => true,
		notify: () => {},
		setCompactStatus: () => {},
		createDashboard: () => undefined,
		runSignal: undefined,
		beginSynthesisPhase: () => undefined,
		waitForIdle: async () => {},
		sendVerdict: () => {
			verdictSent = true;
		},
	};
	const ops: ReviewPipelineOps = {
		runPanel: async () => ({
			results: [{ status: "aborted", label: "one", model: "test/one" }],
			completed: 0,
			failed: 0,
			aborted: 1,
		}),
		runReviewer: async () => {
			reviewerStarted = true;
			throw new Error("synthesis must not start without a fresh phase signal");
		},
	};
	const result = await runReviewPipeline(testPipelineInput, fx, ops);

	assert.deepEqual(result, { status: "aborted" });
	assert.equal(reviewerStarted, false);
	assert.equal(verdictSent, false);
});
