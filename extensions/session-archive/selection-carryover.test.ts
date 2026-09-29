import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "../shared/kstack-config.ts";
import {
	bindReplacementSelectionApi,
	type ReplacementModelRef,
	type ReplacementSelectionApi,
	unbindReplacementSelectionApi,
} from "../shared/replacement-selection-api.ts";
import { readCarriedSelection, startNewSessionCarryingSelection } from "./selection-carryover.ts";

type ReplacedSessionContext = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>
>[0];

const CARRIED = {
	model: { provider: "openrouter", id: "stealth/space-bunny-alpha" },
	effort: "high",
} satisfies { model: ReplacementModelRef; effort: ModelThinkingLevel };

let sessionCounter = 0;
const uniqueSessionId = () => `carry-over-test-${++sessionCounter}`;

interface Notification {
	message: string;
	level: string;
}

interface FakeReplacement {
	sessionId: string;
	notifications: Notification[];
	setModelCalls: ReplacementModelRef[];
	thinkingCalls: ModelThinkingLevel[];
}

/** Fake replacement session plus the predecessor context that starts it. */
function makeReplacement(
	options: { publishApi?: boolean; currentModel?: ReplacementModelRef; hasCredentials?: boolean } = {},
) {
	const publishApi = options.publishApi ?? true;
	const hasCredentials = options.hasCredentials ?? true;
	const replacement: FakeReplacement = {
		sessionId: uniqueSessionId(),
		notifications: [],
		setModelCalls: [],
		thinkingCalls: [],
	};
	const api: ReplacementSelectionApi = {
		setModel: async (model) => {
			replacement.setModelCalls.push(model);
			return hasCredentials;
		},
		setThinkingLevel: (level) => {
			replacement.thinkingCalls.push(level);
		},
	};
	if (publishApi) bindReplacementSelectionApi(replacement.sessionId, api);
	const fresh = {
		sessionManager: { getSessionId: () => replacement.sessionId },
		model: options.currentModel,
		ui: { notify: (message: string, level: string) => replacement.notifications.push({ message, level }) },
	};
	const ctx = {
		model: CARRIED.model,
		thinkingLevel: CARRIED.effort,
		newSession: async (newSessionOptions: { withSession: (ctx: ReplacedSessionContext) => Promise<void> }) => {
			await newSessionOptions.withSession(/* SAFETY: Test double covers the members used here. */ fresh as never);
			return { cancelled: false };
		},
	};
	const start = (
		carried: Parameters<typeof startNewSessionCarryingSelection>[1],
		continueInFresh: () => Promise<void>,
	) =>
		startNewSessionCarryingSelection(
			/* SAFETY: Test double covers the members used here. */ ctx as never,
			carried,
			async (handle) => {
				handle.notify("Session archived", "info");
				await continueInFresh();
			},
		);
	const release = () => unbindReplacementSelectionApi(replacement.sessionId, api);
	return { replacement, start, release };
}

describe("readCarriedSelection", () => {
	it("captures the active model and effort", () => {
		const selection = readCarriedSelection({
			model: { provider: "openrouter", id: "stealth/space-bunny-alpha", name: "Space Bunny" },
			thinkingLevel: "high",
		});

		assert.deepEqual(selection, {
			model: { provider: "openrouter", id: "stealth/space-bunny-alpha", name: "Space Bunny" },
			effort: "high",
		});
	});

	it("returns undefined when the session has neither model nor effort", () => {
		assert.equal(readCarriedSelection({}), undefined);
	});

	it("keeps an effort-only selection", () => {
		const selection = readCarriedSelection({ thinkingLevel: "low" });
		assert.deepEqual(selection, { model: undefined, effort: "low" });
	});
});

describe("startNewSessionCarryingSelection", () => {
	it("restores the archived session's model and effort on the replacement session", async () => {
		const { replacement, start, release } = makeReplacement();
		const continued: string[] = [];

		await start(CARRIED, async () => {
			continued.push("archive");
		});

		assert.deepEqual(replacement.setModelCalls, [CARRIED.model]);
		assert.deepEqual(replacement.thinkingCalls, ["high"]);
		assert.deepEqual(continued, ["archive"]);
		assert.deepEqual(replacement.notifications, [{ message: "Session archived", level: "info" }]);
		release();
	});

	it("skips the model switch when the replacement already runs the carried model", async () => {
		const { replacement, start, release } = makeReplacement({ currentModel: CARRIED.model });

		await start(CARRIED, async () => {});

		assert.deepEqual(replacement.setModelCalls, []);
		assert.deepEqual(replacement.thinkingCalls, ["high"]);
		release();
	});

	it("warns in the replacement session when no live API is published, then continues the archive", async () => {
		const { replacement, start } = makeReplacement({ publishApi: false });
		const continued: string[] = [];

		await start(CARRIED, async () => {
			continued.push("archive");
		});

		assert.deepEqual(continued, ["archive"]);
		assert.equal(replacement.notifications[0]?.level, "warning");
		assert.match(replacement.notifications[0]?.message ?? "", /replacement session API is unavailable/);
		assert.deepEqual(replacement.notifications[1], { message: "Session archived", level: "info" });
	});

	it("reports missing credentials without blocking the archive", async () => {
		const { replacement, start, release } = makeReplacement({ hasCredentials: false });
		const continued: string[] = [];

		await start(CARRIED, async () => {
			continued.push("archive");
		});

		assert.deepEqual(replacement.setModelCalls, [CARRIED.model]);
		assert.deepEqual(replacement.thinkingCalls, ["high"], "effort is still applied");
		assert.deepEqual(continued, ["archive"]);
		assert.match(
			replacement.notifications[0]?.message ?? "",
			/no credentials for openrouter\/stealth\/space-bunny-alpha/,
		);
		release();
	});

	it("does nothing for a session without a model or effort", async () => {
		const { replacement, start, release } = makeReplacement();
		const continued: string[] = [];

		await start(undefined, async () => {
			continued.push("archive");
		});

		assert.deepEqual(replacement.setModelCalls, []);
		assert.deepEqual(replacement.thinkingCalls, []);
		assert.deepEqual(continued, ["archive"]);
		assert.deepEqual(replacement.notifications, [{ message: "Session archived", level: "info" }]);
		release();
	});
});
