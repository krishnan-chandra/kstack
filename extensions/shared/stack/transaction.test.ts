import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../git-exec.ts";
import type { LockAttempt } from "../publication-lock.ts";
import { emptyStackLandProgress, type StackLandOutcome, type StackPublishOutcome } from "./outcome.ts";
import {
	runLanding,
	runPublication,
	type StackTransactionAdapter,
	type StackTransactionOptions,
} from "./transaction.ts";

interface FakePlan {
	planId: string;
	preview: string;
}

const exec: ExecFn = async () => ({ code: 0, stdout: "/repo/.git\n", stderr: "" });
const completed: StackPublishOutcome = {
	status: "completed",
	planId: "plan-1",
	publication: { topRef: "top", pullRequests: [] },
	completedActions: [],
};

function harness(
	input: {
		planIds?: string[];
		confirm?: boolean;
		hasUI?: boolean;
		authorization?: StackTransactionOptions["authorization"];
		lock?: () => LockAttempt;
		release?: () => { ok: true } | { ok: false; error: string };
		controller?: AbortController;
		abortOn?: "plan" | "confirm" | "replan";
		lockExec?: ExecFn;
	} = {},
) {
	const events: string[] = [];
	const planIds = [...(input.planIds ?? ["plan-1", "plan-1"])];
	let held = false;
	const adapter: StackTransactionAdapter<FakePlan, StackPublishOutcome> = {
		async plan() {
			events.push(held ? "plan:locked" : "plan:unlocked");
			if (input.abortOn === (held ? "replan" : "plan")) input.controller?.abort();
			const planId = planIds.shift() ?? "exhausted";
			return { ok: true, plan: { planId, preview: `preview ${planId}` } };
		},
		async apply(plan) {
			events.push(`apply:${plan.planId}:${held ? "locked" : "unlocked"}`);
			return completed;
		},
	};
	const options: StackTransactionOptions = {
		authorization: input.authorization ?? "interactive-confirmation",
		ui: {
			hasUI: input.hasUI ?? true,
			async confirm(title, body) {
				events.push(`confirm:${held ? "locked" : "unlocked"}:${title}:${body}`);
				if (input.abortOn === "confirm") input.controller?.abort();
				return input.confirm ?? true;
			},
		},
		confirmTitle: "Publish?",
		lock: {
			exec: input.lockExec ?? exec,
			cwd: "/repo",
			realpath: (path) => path,
			acquireLock:
				input.lock ??
				(() => {
					held = true;
					events.push("lock");
					return {
						ok: true,
						lock: {
							release: () => {
								held = false;
								events.push("release");
								return input.release?.() ?? { ok: true };
							},
						},
					};
				}),
		},
		onPhase: (phase) => events.push(`phase:${phase}`),
		signal: input.controller?.signal,
	};
	return { adapter, options, events };
}

describe("runPublication", () => {
	it("confirms before locking, re-plans under the lock, and applies the re-planned plan", async () => {
		const { adapter, options, events } = harness();
		assert.deepEqual(await runPublication(adapter, options), completed);
		assert.deepEqual(events, [
			"phase:planning",
			"plan:unlocked",
			"phase:confirming",
			"confirm:unlocked:Publish?:preview plan-1",
			"phase:locking",
			"lock",
			"phase:replanning",
			"plan:locked",
			"phase:applying",
			"apply:plan-1:locked",
			"release",
		]);
	});

	it("returns stale without applying when the locked re-plan changes the plan ID", async () => {
		const { adapter, options, events } = harness({ planIds: ["plan-1", "plan-2"] });
		assert.deepEqual(await runPublication(adapter, options), {
			status: "stale",
			providedPlanId: "plan-1",
			recomputedPlanId: "plan-2",
		});
		assert.equal(
			events.some((event) => event.startsWith("apply")),
			false,
		);
		assert.equal(events.at(-1), "release");
	});

	it("skips confirmation for a model-tool authorization without requiring a UI", async () => {
		const { adapter, options, events } = harness({ authorization: "model-tool", hasUI: false });
		assert.equal((await runPublication(adapter, options)).status, "completed");
		assert.equal(
			events.some((event) => event.startsWith("confirm")),
			false,
		);
	});

	it("blocks interactive authorization without a UI before planning", async () => {
		const { adapter, options, events } = harness({ hasUI: false });
		assert.deepEqual(await runPublication(adapter, options), {
			status: "blocked",
			blockers: [{ code: "missing-ui", message: "Publication requires interactive TUI/RPC mode." }],
		});
		assert.deepEqual(events, []);
	});

	it("returns declined with the plan ID and never locks", async () => {
		const { adapter, options, events } = harness({ confirm: false });
		assert.deepEqual(await runPublication(adapter, options), { status: "declined", planId: "plan-1" });
		assert.equal(events.includes("lock"), false);
	});

	it("reports the lock holder when another mutation is active", async () => {
		const { adapter, options, events } = harness({
			lock: () => ({ ok: false, holder: { pid: 42, startedAt: "2026-01-01T00:00:00.000Z" } }),
		});
		assert.deepEqual(await runPublication(adapter, options), {
			status: "busy",
			message:
				"Another stack publication or landing is active for this repository (pid 42, since 2026-01-01T00:00:00.000Z). Retry after it finishes.",
		});
		assert.equal(
			events.some((event) => event.startsWith("plan:locked") || event.startsWith("apply")),
			false,
		);
	});

	it("attaches a failed lock release to the outcome as a warning", async () => {
		const { adapter, options } = harness({ release: () => ({ ok: false, error: "EACCES" }) });
		const outcome = await runPublication(adapter, options);
		assert.equal(outcome.status, "completed");
		assert.deepEqual(outcome.warnings, [
			"Repository lock cleanup failed: EACCES. Remove the lock file manually if later publications or landings report busy.",
		]);
	});

	it("attaches a failed lock release to a stale outcome too", async () => {
		const { adapter, options } = harness({
			planIds: ["plan-1", "plan-2"],
			release: () => ({ ok: false, error: "EACCES" }),
		});
		const outcome = await runPublication(adapter, options);
		assert.equal(outcome.status, "stale");
		assert.equal(outcome.warnings?.length, 1);
	});

	for (const abortOn of ["plan", "confirm"] as const) {
		it(`returns cancelled without locking when aborted during ${abortOn}`, async () => {
			const controller = new AbortController();
			const { adapter, options, events } = harness({ controller, abortOn });
			assert.deepEqual(await runPublication(adapter, options), { status: "cancelled" });
			assert.equal(events.includes("lock"), false);
		});
	}

	it("returns cancelled when the caller aborts while the lock identity resolves", async () => {
		const controller = new AbortController();
		const { adapter, options, events } = harness({
			controller,
			lockExec: async () => {
				controller.abort();
				throw new Error("aborted");
			},
		});
		assert.deepEqual(await runPublication(adapter, options), { status: "cancelled" });
		assert.equal(events.includes("lock"), false);
	});

	it("returns cancelled and releases the lock when aborted during the locked re-plan", async () => {
		const controller = new AbortController();
		const { adapter, options, events } = harness({ controller, abortOn: "replan" });
		assert.deepEqual(await runPublication(adapter, options), { status: "cancelled" });
		assert.equal(
			events.some((event) => event.startsWith("apply")),
			false,
		);
		assert.equal(events.at(-1), "release");
	});

	it("keeps the thrown error's class and adds a failed release to its message", async () => {
		class IndeterminateError extends Error {}
		const { adapter, options } = harness({ release: () => ({ ok: false, error: "EACCES" }) });
		adapter.apply = async () => {
			throw new IndeterminateError("push outcome unknown");
		};
		await assert.rejects(runPublication(adapter, options), (error) => {
			assert.ok(error instanceof IndeterminateError);
			assert.match(error.message, /^push outcome unknown Repository lock cleanup failed: EACCES\./);
			return true;
		});
	});

	it("rethrows a frozen error unchanged when the release diagnostic cannot be appended", async () => {
		class IndeterminateError extends Error {}
		const frozen = Object.freeze(new IndeterminateError("push outcome unknown"));
		let releases = 0;
		const { adapter, options } = harness({
			release: () => {
				releases++;
				return { ok: false, error: "EACCES" };
			},
		});
		adapter.apply = async () => {
			throw frozen;
		};
		await assert.rejects(runPublication(adapter, options), (error) => {
			assert.equal(error, frozen);
			assert.equal(frozen.message, "push outcome unknown");
			return true;
		});
		assert.equal(releases, 1);
	});

	it("releases the lock when apply throws", async () => {
		const { adapter, options, events } = harness();
		adapter.apply = async () => {
			throw new Error("boom");
		};
		await assert.rejects(runPublication(adapter, options), /boom/);
		assert.equal(events.at(-1), "release");
	});
});

describe("runLanding", () => {
	const landed: StackLandOutcome = { status: "completed", ...emptyStackLandProgress(), warnings: ["sync skipped"] };

	function landingHarness(input: Parameters<typeof harness>[0] = {}) {
		const { adapter, options, events } = harness(input);
		const landing: StackTransactionAdapter<FakePlan, StackLandOutcome> = {
			plan: adapter.plan,
			async apply() {
				events.push("apply");
				return landed;
			},
		};
		return { landing, options, events };
	}

	it("maps the transaction's own outcomes to landing outcomes", async () => {
		const declined = landingHarness({ confirm: false });
		assert.deepEqual(await runLanding(declined.landing, declined.options), { status: "declined" });
		const missingUi = landingHarness({ hasUI: false });
		assert.deepEqual(await runLanding(missingUi.landing, missingUi.options), {
			status: "blocked",
			blockers: [{ code: "missing-ui", message: "Stack landing requires interactive TUI/RPC mode." }],
		});
		const stale = landingHarness({ planIds: ["plan-1", "plan-2"] });
		assert.deepEqual(await runLanding(stale.landing, stale.options), {
			status: "stale",
			providedPlanId: "plan-1",
			recomputedPlanId: "plan-2",
		});
		const controller = new AbortController();
		const cancelled = landingHarness({ controller, abortOn: "confirm" });
		assert.deepEqual(await runLanding(cancelled.landing, cancelled.options), {
			status: "cancelled",
			...emptyStackLandProgress(),
		});
	});

	it("appends a failed lock release to the applied outcome's progress warnings", async () => {
		const { landing, options } = landingHarness({ release: () => ({ ok: false, error: "EACCES" }) });
		const outcome = await runLanding(landing, options);
		assert.equal(outcome.status, "completed");
		assert.deepEqual(outcome.warnings, [
			"sync skipped",
			"Repository lock cleanup failed: EACCES. Remove the lock file manually if later publications or landings report busy.",
		]);
	});

	it("attaches a failed lock release to a stale landing", async () => {
		const { landing, options, events } = landingHarness({
			planIds: ["plan-1", "plan-2"],
			release: () => ({ ok: false, error: "EACCES" }),
		});
		const outcome = await runLanding(landing, options);
		assert.equal(outcome.status, "stale");
		assert.equal(outcome.warnings?.length, 1);
		assert.equal(events.includes("apply"), false);
	});
});
