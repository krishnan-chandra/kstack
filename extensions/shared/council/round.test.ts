import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { truncateHeadUtf8 } from "../child-agent-runner.ts";
import { COUNCIL_OUTPUT_CAP_BYTES } from "./protocol.ts";
import type { SeatLetter } from "./roster.ts";
import {
	type CouncilRecordInfo,
	overrideCouncilFinding,
	type RoundDeps,
	type RoundInput,
	runCouncilRound,
	type SeatAsk,
	type SeatAskResult,
} from "./round.ts";
import { councilPaths, initialCouncilState, readState, sha256, writeState } from "./store.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const APPROVE = "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n";

function revise(...ids: string[]): string {
	return `Verdict: revise\n\n## Blocking\n${ids.map((id) => `- [${id}] ${id} lacks a test`).join("\n")}\n\n## Suggestions\nNone.\n`;
}

function resolved(...ids: string[]): string {
	return `${APPROVE}\n## Resolved from previous round\n${ids.map((id) => `- ${id}: fixed`).join("\n")}\n`;
}

function ballot(votes: Record<string, string>, withdrawn: string[] = []): string {
	const voteLines = Object.entries(votes).map(([id, vote]) => `- ${id}: ${vote}`);
	return `## Votes\n${voteLines.join("\n") || "None."}\n\n## Withdrawn\n${withdrawn.map((id) => `- ${id}`).join("\n") || "None."}\n`;
}

type Phase = "review" | "cross-exam";

/** Concur on every finding the cross-examination request lists for this seat. */
function concurAll(ask: SeatAsk): string {
	const request = readFileSync(ask.promptFile, "utf8");
	const listed = request.slice(
		request.indexOf("Vote exactly once"),
		request.indexOf("\n\n", request.indexOf("Vote exactly once")),
	);
	const ids = [...listed.matchAll(/^- ([A-E]\/B-\d+):/gm)].map((match) => match[1] ?? "");
	return ballot(Object.fromEntries(ids.map((id) => [id, "concur"])));
}
type Reply = (ask: SeatAsk) => SeatAskResult | Promise<SeatAskResult>;

/** Scripted seats: each `phase-seat` key holds a queue of replies; an empty queue approves or concurs. */
class FakeSeats {
	readonly asks: { seat: SeatLetter; phase: Phase; repair: boolean; promptFile: string; capBytes: number }[] = [];
	readonly queues = new Map<string, Reply[]>();
	inFlight = 0;
	maxInFlight = 0;

	script(phase: Phase, seat: SeatLetter, ...outputs: string[]): this {
		return this.scriptReplies(
			phase,
			seat,
			...outputs.map(
				(output): Reply =>
					() => ({ status: "completed", output }),
			),
		);
	}

	scriptReplies(phase: Phase, seat: SeatLetter, ...replies: Reply[]): this {
		this.queues.set(`${phase}-${seat}`, [...(this.queues.get(`${phase}-${seat}`) ?? []), ...replies]);
		return this;
	}

	readonly deps: RoundDeps = {
		askSeat: async (ask) => {
			const name = basename(ask.promptFile);
			const phase: Phase = name.startsWith("cross-exam") ? "cross-exam" : "review";
			this.asks.push({
				seat: ask.seat,
				phase,
				repair: name.includes(".repair."),
				promptFile: ask.promptFile,
				capBytes: ask.outputCapBytes,
			});
			this.inFlight++;
			this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
			try {
				await new Promise((resolveTick) => setImmediate(resolveTick));
				const next = this.queues.get(`${phase}-${ask.seat}`)?.shift();
				const result: SeatAskResult = next
					? await next(ask)
					: { status: "completed", output: phase === "review" ? APPROVE : concurAll(ask) };
				if (result.status === "completed") writeFileSync(ask.outputFile, result.output);
				return result;
			} finally {
				this.inFlight--;
			}
		},
		now: () => new Date("2026-10-25T12:00:00Z"),
	};

	asked(phase: Phase): SeatLetter[] {
		return this.asks.filter((ask) => ask.phase === phase && !ask.repair).map((ask) => ask.seat);
	}
}

const INFO: CouncilRecordInfo = {
	seatModels: { A: "openai/gpt-6-astra:high", B: "google/gemini-4-argon:high", C: "openai/gpt-6-luna:high" },
	seatPanes: { A: "w1:p2", B: "w1:p3", C: "w1:p4" },
	plannerModel: "anthropic/claude-opus-5-5",
	excluded: [],
};

function council(seats: SeatLetter[], maxRounds = 3) {
	const root = mkdtempSync(join(tmpdir(), "kstack-council-round-"));
	roots.push(root);
	const dir = join(root, "council");
	writeState(dir, initialCouncilState(seats, maxRounds));
	const planFile = join(root, "plan.md");
	const taskFile = join(root, "task.md");
	const responseFile = join(root, "response.md");
	writeFileSync(planFile, "# Plan v1\n");
	writeFileSync(taskFile, "Build the thing.\n");
	const input = (overrides: Partial<RoundInput> = {}): RoundInput => ({
		dir,
		planFile,
		taskFile,
		timeoutMs: 60_000,
		info: INFO,
		...overrides,
	});
	return { dir, planFile, taskFile, responseFile, input, paths: councilPaths(dir) };
}

describe("runCouncilRound", () => {
	it("asks every seat in parallel, publishes the ledger, cross-examines, and tallies 2-of-3 dismissal", async () => {
		const c = council(["A", "B", "C"]);
		const seats = new FakeSeats()
			.script("review", "A", revise("B-1"))
			.script("review", "C", revise("B-1"))
			.script("cross-exam", "A", ballot({ "C/B-1": "object — src/x.ts:3 covers it" }))
			.script("cross-exam", "B", ballot({ "A/B-1": "abstain", "C/B-1": "object — tests already exist" }))
			.script("cross-exam", "C", ballot({ "A/B-1": "concur" }));
		const result = await runCouncilRound(c.input(), seats.deps);
		assert.equal(result.status, "complete", JSON.stringify(result));
		assert.equal(result.decision, "revise");
		assert.deepEqual(result.binding, ["A/B-1"]);
		assert.equal(seats.maxInFlight, 3);
		assert.deepEqual(seats.asked("review").sort(), ["A", "B", "C"]);
		assert.deepEqual(seats.asked("cross-exam").sort(), ["A", "B", "C"]);
		assert.ok(seats.asks.every((ask) => ask.capBytes === COUNCIL_OUTPUT_CAP_BYTES));
		assert.match(readFileSync(c.paths.round(1).ledger, "utf8"), /## Up for a vote\n- A\/B-1/);
		const decision = readFileSync(c.paths.round(1).decision, "utf8");
		assert.match(decision, /Decision: revise/);
		assert.match(decision, /C\/B-1 \[dismissed\]/);
		assert.match(readFileSync(c.paths.record, "utf8"), /tests already exist/);
		assert.equal(result.planChangedSinceSnapshot, false);
	});

	it("skips cross-examination with one seat or nothing up for a vote", async () => {
		const solo = council(["A"]);
		const soloSeats = new FakeSeats().script("review", "A", revise("B-1"));
		const soloResult = await runCouncilRound(solo.input(), soloSeats.deps);
		assert.equal(soloResult.decision, "revise");
		assert.deepEqual(soloSeats.asked("cross-exam"), []);

		const quiet = council(["A", "B"]);
		const quietSeats = new FakeSeats();
		const quietResult = await runCouncilRound(quiet.input(), quietSeats.deps);
		assert.equal(quietResult.decision, "approve");
		assert.deepEqual(quietSeats.asked("cross-exam"), []);
	});

	it("repairs one invalid reply, then leaves the round incomplete on a second failure", async () => {
		const c = council(["A", "B", "C"]);
		const seats = new FakeSeats()
			.script("review", "A", "no verdict here", APPROVE)
			.script("review", "B", "still nothing", "nope");
		const result = await runCouncilRound(c.input(), seats.deps);
		assert.equal(result.status, "incomplete");
		assert.equal(result.exitCode, 1);
		assert.deepEqual(
			result.failures?.map((failure) => [failure.seat, failure.pane]),
			[["B", "w1:p3"]],
		);
		assert.match(result.failures?.[0]?.error ?? "", /still invalid after one repair.*w1:p3/);
		assert.match(readFileSync(c.paths.round(1).repairRequest("review", "A"), "utf8"), /could not be accepted/);
		assert.deepEqual(Object.keys(readState(c.dir).rounds[0]?.reviews ?? {}).sort(), ["A", "C"]);

		const rerun = new FakeSeats();
		const resumed = await runCouncilRound(c.input(), rerun.deps);
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.resumed, true);
		assert.deepEqual(rerun.asked("review"), ["B"]);
		assert.equal(readState(c.dir).budgetUsed, 1);
	});

	it("repairs a truncated reply and never approves from a truncated prefix", async () => {
		const c = council(["A"]);
		const truncated = truncateHeadUtf8(`${APPROVE}${"x".repeat(70_000)}`, COUNCIL_OUTPUT_CAP_BYTES);
		const seats = new FakeSeats().script("review", "A", truncated, truncated);
		const result = await runCouncilRound(c.input(), seats.deps);
		assert.equal(result.status, "incomplete");
		assert.equal(result.decision, undefined);
		assert.equal(existsSync(c.paths.approvedPlan), false);
		assert.equal(seats.asks.filter((ask) => ask.repair).length, 1);
	});

	it("persists progress on cancellation and resumes only unfinished seats", async () => {
		const c = council(["A", "B", "C"]);
		const controller = new AbortController();
		const seats = new FakeSeats().scriptReplies(
			"review",
			"C",
			(ask) =>
				new Promise<SeatAskResult>((resolveAsk) => {
					ask.signal?.addEventListener("abort", () => resolveAsk({ status: "aborted" }), { once: true });
					setImmediate(() => controller.abort());
				}),
		);
		const result = await runCouncilRound(c.input({ signal: controller.signal }), seats.deps);
		assert.equal(result.status, "incomplete");
		assert.equal(result.cancelled, true);
		assert.deepEqual(Object.keys(readState(c.dir).rounds[0]?.reviews ?? {}).sort(), ["A", "B"]);
		assert.equal(existsSync(c.paths.lock), false);

		const rerun = new FakeSeats();
		const resumed = await runCouncilRound(c.input(), rerun.deps);
		assert.equal(resumed.decision, "approve");
		assert.deepEqual(rerun.asked("review"), ["C"]);
	});

	it("reviews the snapshot when the live plan changes during an incomplete round", async () => {
		const c = council(["A", "B"]);
		const first = await runCouncilRound(c.input(), new FakeSeats().script("review", "B", "bad", "bad").deps);
		assert.equal(first.status, "incomplete");
		writeFileSync(c.planFile, "# Plan v2\n");
		const seats = new FakeSeats();
		const resumed = await runCouncilRound(c.input(), seats.deps);
		assert.equal(resumed.decision, "approve");
		assert.equal(resumed.planChangedSinceSnapshot, true);
		assert.equal(readFileSync(c.paths.approvedPlan, "utf8"), "# Plan v1\n");
		assert.match(readFileSync(c.paths.round(1).request("review", "B"), "utf8"), /round-1\/plan\.md/);
	});

	it("keeps approved-plan.md when the live plan changes after approval", async () => {
		const c = council(["A", "B"]);
		const approved = await runCouncilRound(c.input(), new FakeSeats().deps);
		assert.equal(approved.decision, "approve");
		assert.equal(approved.approvedSha256, sha256("# Plan v1\n"));
		assert.equal(approved.approvedPlan, c.paths.approvedPlan);
		assert.match(readFileSync(c.paths.record, "utf8"), new RegExp(sha256("# Plan v1\n")));
		writeFileSync(c.planFile, "# Plan v2 with an unreviewed edit\n");
		const second = await runCouncilRound(c.input(), new FakeSeats().script("review", "A", "garbage", "garbage").deps);
		assert.equal(second.status, "incomplete");
		assert.equal(second.planChangedSinceSnapshot, false, "the new round snapshots the edited plan");
		assert.equal(readFileSync(c.paths.approvedPlan, "utf8"), "# Plan v1\n");
	});

	it("rejects response errors and escalations without asking seats or spending budget", async () => {
		const c = council(["A", "B"]);
		await runCouncilRound(c.input(), new FakeSeats().script("review", "A", revise("B-1", "B-2")).deps);
		const missing = await runCouncilRound(c.input(), new FakeSeats().deps);
		assert.match(missing.error ?? "", /--response is required.*A\/B-1, A\/B-2/);

		const seats = new FakeSeats();
		for (const [text, pattern] of [
			["## Responses\n- A/B-1: addressed — x\n", /does not answer A\/B-2/],
			["## Responses\n- A/B-1: addressed — x\n- A/B-1: addressed — y\n- A/B-2: addressed — z\n", /more than once/],
			["## Responses\n- A/B-1: addressed — x\n- A/B-2: addressed — y\n- B/B-7: addressed — z\n", /not binding/],
		] as const) {
			writeFileSync(c.responseFile, text);
			const result = await runCouncilRound(c.input({ responseFile: c.responseFile }), seats.deps);
			assert.equal(result.status, "failed");
			assert.equal(result.exitCode, 1);
			assert.match(result.error ?? "", pattern);
		}
		writeFileSync(
			c.responseFile,
			"## Responses\n- A/B-1: conflicts-with A/B-2 — both cannot hold\n- A/B-2: addressed — y\n",
		);
		const escalated = await runCouncilRound(c.input({ responseFile: c.responseFile }), seats.deps);
		assert.equal(escalated.status, "escalated");
		assert.equal(escalated.exitCode, 0);
		assert.equal(escalated.decision, "escalate");
		assert.equal(seats.asks.length, 0);
		const state = readState(c.dir);
		assert.equal(state.budgetUsed, 1);
		assert.equal(state.rounds.length, 1);
		assert.equal(state.escalations.length, 1);
	});

	it("re-votes a rebutted finding and escalates a second rebuttal", async () => {
		const c = council(["A", "B", "C"]);
		await runCouncilRound(
			c.input(),
			new FakeSeats().script("review", "A", revise("B-1")).script("cross-exam", "B", ballot({ "A/B-1": "concur" }))
				.deps,
		);
		writeFileSync(c.responseFile, "## Responses\n- A/B-1: rebutted — src/a.ts:4 already does it\n");
		const seats = new FakeSeats()
			.script("review", "A", revise("B-1"))
			.script("cross-exam", "B", ballot({ "A/B-1": "object — src/a.ts:4" }))
			.script("cross-exam", "C", ballot({ "A/B-1": "object — confirmed at src/a.ts:4" }));
		const second = await runCouncilRound(c.input({ responseFile: c.responseFile }), seats.deps);
		assert.equal(second.decision, "approve", JSON.stringify(second));
		assert.match(readFileSync(c.paths.round(2).request("review", "A"), "utf8"), /Planner rebuttal: src\/a\.ts:4/);

		const d = council(["A", "B"]);
		await runCouncilRound(d.input(), new FakeSeats().script("review", "A", revise("B-1")).deps);
		writeFileSync(d.responseFile, "## Responses\n- A/B-1: rebutted — evidence\n");
		const rebutted = await runCouncilRound(
			d.input({ responseFile: d.responseFile }),
			new FakeSeats().script("review", "A", revise("B-1")).deps,
		);
		assert.equal(rebutted.decision, "revise");
		const again = await runCouncilRound(d.input({ responseFile: d.responseFile }), new FakeSeats().deps);
		assert.equal(again.status, "escalated");
		assert.equal(again.escalations?.[0]?.reason, "second-rebuttal");
	});

	it("enforces the budget and allows uncounted --verify rounds only after it is used", async () => {
		const c = council(["A"], 1);
		const early = await runCouncilRound(c.input({ verify: true }), new FakeSeats().deps);
		assert.match(early.error ?? "", /--verify runs only after/);
		const first = await runCouncilRound(c.input(), new FakeSeats().script("review", "A", revise("B-1")).deps);
		assert.equal(first.decision, "exhausted");
		writeFileSync(c.responseFile, "## Responses\n- A/B-1: addressed — STEP-2\n");
		const refused = await runCouncilRound(c.input({ responseFile: c.responseFile }), new FakeSeats().deps);
		assert.match(refused.error ?? "", /All 1 budgeted rounds are used/);
		const verify = await runCouncilRound(
			c.input({ responseFile: c.responseFile, verify: true }),
			new FakeSeats().script("review", "A", resolved("B-1")).deps,
		);
		assert.equal(verify.decision, "approve");
		assert.equal(verify.kind, "verify");
		assert.deepEqual(verify.budget, { used: 1, max: 1 });
	});

	it("overrides a binding finding into approval under the shared lock", async () => {
		const c = council(["A", "B"]);
		await runCouncilRound(c.input(), new FakeSeats().script("review", "B", revise("B-1")).deps);
		const missingReason = await overrideCouncilFinding({ dir: c.dir, id: "B/B-1", reason: " ", info: INFO });
		assert.match(missingReason.error ?? "", /needs a reason/);
		const overridden = await overrideCouncilFinding({
			dir: c.dir,
			id: "B/B-1",
			reason: "the user accepts this risk",
			planFile: c.planFile,
			info: INFO,
		});
		assert.equal(overridden.decision, "approve");
		assert.equal(readFileSync(c.paths.approvedPlan, "utf8"), "# Plan v1\n");
		assert.match(readFileSync(c.paths.record, "utf8"), /B\/B-1 \(round 1\): the user accepts this risk/);
	});

	it("takes over a stale lock and refuses a live one for rounds and overrides", async () => {
		const c = council(["A"]);
		writeFileSync(c.paths.lock, "999999\n");
		const deps = { ...new FakeSeats().deps, pidAlive: (pid: number) => pid !== 999999 };
		const stale = await runCouncilRound(c.input(), deps);
		assert.equal(stale.status, "complete");
		assert.equal(existsSync(c.paths.lock), false);

		writeFileSync(c.paths.lock, `${process.pid}\n`);
		const live = await runCouncilRound(c.input(), new FakeSeats().deps);
		assert.match(live.error ?? "", /holds .*council\.lock/);
		const liveOverride = await overrideCouncilFinding({ dir: c.dir, id: "A/B-1", reason: "x", info: INFO });
		assert.match(liveOverride.error ?? "", /holds .*council\.lock/);
		assert.equal(existsSync(c.paths.lock), true);
	});
});
