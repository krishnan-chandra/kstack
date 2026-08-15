import assert from "node:assert/strict";
import test from "node:test";
import { type ConfigLoad, DEFAULT_SYNTHESIS, type ResolveDeps } from "./config.ts";
import { type ReviewPipelineEffects, type ReviewPipelineOps, resolvePanel, runReviewPipeline } from "./run-phases.ts";
import type { PanelConfig, ScopeBundle } from "./types.ts";

const panelConfig: PanelConfig = {
	reviewers: [
		{ label: "one", model: "test/one", thinking: "high" },
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
	const scope: ScopeBundle = {
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
	const result = await runReviewPipeline(
		{
			scope,
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
		},
		fx,
		ops,
	);
	assert.equal(result.status, "failed");
	if (result.status === "failed") {
		assert.match(result.error, /one \(test\/one\): failed — timeout/);
		assert.match(result.error, /two \(test\/two\): failed — bad output/);
	}
	assert.match(notifications[0] ?? "", /All reviewers failed; nothing to synthesize/);
});

test("pipeline forwards and observes the lifecycle run signal", async () => {
	const controller = new AbortController();
	const fx: ReviewPipelineEffects = {
		isCurrent: () => true,
		notify: () => {},
		setCompactStatus: () => {},
		createDashboard: () => undefined,
		runSignal: controller.signal,
		waitForIdle: async () => {},
		sendVerdict: () => assert.fail("aborted panels must not emit a verdict"),
	};
	const ops: ReviewPipelineOps = {
		runPanel: async (reviewers, _maxConcurrency, runOne) => {
			const result = await runOne(reviewers[0], 0);
			return { results: [result], completed: 0, failed: 0, aborted: 1 };
		},
		runReviewer: async (input) => {
			assert.equal(input.signal, controller.signal);
			controller.abort();
			assert.equal(input.signal.aborted, true);
			return { status: "aborted", label: input.spec.label, model: input.model };
		},
	};
	const scope: ScopeBundle = {
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

	const result = await runReviewPipeline(
		{
			scope,
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
		},
		fx,
		ops,
	);

	assert.equal(result.status, "aborted");
});
