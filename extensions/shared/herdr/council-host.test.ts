import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { CouncilRoster } from "../council/roster.ts";
import { councilPaths, readManifest } from "../council/store.ts";
import type { JsonObject } from "../validation.ts";
import type { HostDeps } from "./agent-host.ts";
import { closeCouncilSeats, createSeatAsker, openCouncilSeats } from "./council-host.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface FakeAgent {
	paneId: string;
	status: string;
	cwd: string;
}

type StartBehavior = "ok" | "not-ready";

/** Stateful Herdr fake: panes belong to tabs, agents live in panes, and names are unique. */
class StatefulHerdr {
	readonly calls: string[][] = [];
	readonly paneTabs = new Map<string, string>([["w1:p1", "w1:t1"]]);
	readonly agents = new Map<string, FakeAgent>();
	readonly startBehavior = new Map<string, StartBehavior>();
	readonly callerPane = "w1:p1";
	private nextPane = 10;

	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	private ok(result: JsonObject) {
		return { code: 0, stdout: JSON.stringify({ id: "x", result }), stderr: "" };
	}

	private error(code: string, message: string) {
		return { code: 1, stdout: "", stderr: JSON.stringify({ id: "x", error: { code, message } }) };
	}

	private agentRecord(name: string, agent: FakeAgent) {
		return {
			name,
			agent: "pi",
			cwd: agent.cwd,
			agent_status: agent.status,
			pane_id: agent.paneId,
			tab_id: this.paneTabs.get(agent.paneId) ?? "",
			agent_session: { kind: "path", value: join(this.root, `${name}.jsonl`) },
		};
	}

	addAgent(name: string, paneId: string, tabId: string, status = "idle"): void {
		this.paneTabs.set(paneId, tabId);
		this.agents.set(name, { paneId, status, cwd: this.root });
	}

	readonly exec: HostDeps["exec"] = async (args) => {
		this.calls.push(args);
		const [group, command] = args;
		if (group === "status") return { code: 0, stdout: "running\n", stderr: "" };
		if (group === "pane" && command === "layout") {
			const tabId = this.paneTabs.get(args[3] ?? "");
			if (!tabId) return this.error("pane_not_found", "pane not found");
			return this.ok({ type: "pane_layout", layout: { area: { width: 240, height: 60 }, tab_id: tabId } });
		}
		if (group === "pane" && command === "split") {
			const tabId = this.paneTabs.get(args[2] ?? "");
			if (!tabId) return this.error("pane_not_found", "pane not found");
			const paneId = `w1:p${this.nextPane++}`;
			this.paneTabs.set(paneId, tabId);
			return this.ok({ type: "pane_info", pane: { pane_id: paneId, tab_id: tabId, agent_status: "unknown" } });
		}
		if (group === "pane" && command === "close") {
			const paneId = args[2] ?? "";
			if (!this.paneTabs.delete(paneId)) return this.error("pane_not_found", `pane ${paneId} not found`);
			for (const [name, agent] of this.agents) if (agent.paneId === paneId) this.agents.delete(name);
			return this.ok({ type: "ok" });
		}
		if (group === "agent" && command === "start") {
			const name = args[2] ?? "";
			const paneId = args[6] ?? "";
			if (this.agents.has(name)) return this.error("agent_name_in_use", `agent name ${name} already in use`);
			const behavior = this.startBehavior.get(name) ?? "ok";
			this.agents.set(name, { paneId, status: behavior === "ok" ? "idle" : "blocked", cwd: this.root });
			if (behavior === "not-ready") return this.error("agent_not_ready", `agent ${name} is waiting at a prompt`);
			const agent = this.agents.get(name);
			return agent
				? this.ok({ type: "agent_started", agent: this.agentRecord(name, agent), argv: ["pi"] })
				: this.error("x", "x");
		}
		if (group === "agent" && (command === "get" || command === "wait")) {
			const name = args[2] ?? "";
			const agent = this.agents.get(name);
			if (!agent) return this.error("agent_not_found", `agent target ${name} not found`);
			return this.ok({ type: "agent_info", agent: this.agentRecord(name, agent) });
		}
		if (group === "agent" && command === "send-keys") return this.ok({ type: "ok" });
		throw new Error(`StatefulHerdr has no route for ${args.join(" ")}`);
	};

	count(group: string, command: string): number {
		return this.calls.filter((call) => call[0] === group && call[1] === command).length;
	}
}

const ROSTER: CouncilRoster = {
	seats: [
		{ letter: "A", model: "openai/gpt-6-astra:high" },
		{ letter: "B", model: "google/gemini-4-argon:high" },
	],
	excluded: ["anthropic/claude-opus-5-5:high"],
	maxRounds: 3,
	timeoutMinutes: 15,
	reviewTimeoutMinutes: 10,
};

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kstack-council-host-")));
	roots.push(root);
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "herdr-agent-state.ts"), "// integration\n");
	const herdr = new StatefulHerdr(root);
	const dir = join(root, "council");
	const deps: HostDeps = {
		exec: herdr.exec,
		env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: herdr.callerPane, PI_CODING_AGENT_DIR: root },
		sleep: async () => {},
	};
	const open = (roster: CouncilRoster = ROSTER) =>
		openCouncilSeats({ dir, slug: "demo", cwd: root, roster, plannerModel: "anthropic/claude-opus-5-5" }, deps);
	return { root, herdr, dir, deps, open };
}

describe("openCouncilSeats", () => {
	it("starts every seat from one right split of the caller with exact names, then reuses them", async () => {
		const { herdr, dir, open } = setup();
		const opened = await open();
		assert.ok(opened.ok, opened.ok ? "" : opened.error);
		assert.equal(opened.status, "ready");
		const splits = herdr.calls.filter((call) => call[0] === "pane" && call[1] === "split");
		assert.equal(splits[0]?.[2], herdr.callerPane);
		assert.equal(splits[0]?.[4], "right");
		assert.deepEqual(
			splits.slice(1).map((call) => call[4]),
			["down"],
		);
		assert.deepEqual(
			herdr.calls.filter((call) => call[1] === "start").map((call) => call[2]),
			["council-demo-a", "council-demo-b"],
		);
		const manifest = readManifest(dir);
		assert.equal(manifest.tabId, "w1:t1");
		assert.deepEqual(
			manifest.seats.map((seat) => [seat.letter, seat.model, seat.name, seat.state]),
			[
				["A", "openai/gpt-6-astra:high", "council-demo-a", "ready"],
				["B", "google/gemini-4-argon:high", "council-demo-b", "ready"],
			],
		);
		assert.ok(manifest.seats.every((seat) => seat.paneId && seat.paneId !== herdr.callerPane));
		const started = herdr.calls.find((call) => call[1] === "start") ?? [];
		assert.ok(started.includes("--no-skills"));
		assert.equal(started.includes("--no-extensions"), false);
		assert.ok(started.some((arg) => arg.endsWith("council-seat.md")));
		assert.ok(started.some((arg) => arg.endsWith("read-only.md")));
		assert.equal(JSON.parse(readFileSync(councilPaths(dir).state, "utf8")).maxRounds, 3);

		const splitsBefore = herdr.count("pane", "split");
		const again = await open();
		assert.ok(again.ok);
		assert.equal(herdr.count("pane", "split"), splitsBefore);
		assert.equal(herdr.count("agent", "start"), 2);
	});

	it("adopts a seat left waiting by agent_not_ready without a second start or split", async () => {
		const { herdr, dir, open } = setup();
		herdr.startBehavior.set("council-demo-b", "not-ready");
		const first = await open();
		assert.equal(first.ok, false);
		const waitingPane = readManifest(dir).seats[1]?.paneId;
		assert.ok(waitingPane);
		assert.equal(first.ok ? undefined : first.seats?.[1]?.paneId, waitingPane);

		const stillWaiting = await open();
		assert.ok(stillWaiting.ok);
		assert.equal(stillWaiting.status, "waiting");
		assert.match(stillWaiting.seats[1]?.error ?? "", new RegExp(waitingPane));

		const agent = herdr.agents.get("council-demo-b");
		if (agent) agent.status = "idle";
		const adopted = await open();
		assert.ok(adopted.ok);
		assert.equal(adopted.status, "ready");
		assert.equal(herdr.count("agent", "start"), 2);
		assert.equal(herdr.count("pane", "split"), 2);
		assert.equal(readManifest(dir).seats[1]?.paneId, waitingPane);
	});

	it("closes a vanished seat's stale pane before starting it again", async () => {
		const { herdr, dir, open } = setup();
		assert.ok((await open()).ok);
		const stalePane = readManifest(dir).seats[0]?.paneId ?? "";
		herdr.agents.delete("council-demo-a");
		const reopened = await open();
		assert.ok(reopened.ok, reopened.ok ? "" : reopened.error);
		const closeIndex = herdr.calls.findIndex((call) => call[1] === "close" && call[2] === stalePane);
		const lastStart = herdr.calls.findLastIndex((call) => call[1] === "start");
		assert.ok(closeIndex >= 0 && closeIndex < lastStart);
		assert.notEqual(readManifest(dir).seats[0]?.paneId, stalePane);
		assert.equal(herdr.paneTabs.has(stalePane), false);
	});

	it("refuses a name held outside the manifest and a changed roster", async () => {
		const conflict = setup();
		conflict.herdr.addAgent("council-demo-a", "w1:p50", "w1:t1");
		const refused = await conflict.open();
		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.error, /outside this council's manifest/);
		assert.equal(conflict.herdr.count("agent", "start"), 0);

		const changed = setup();
		assert.ok((await changed.open()).ok);
		const mismatch = await changed.open({ ...ROSTER, seats: [{ letter: "A", model: "openai/gpt-6-luna:high" }] });
		assert.match(mismatch.ok ? "" : mismatch.error, /differs from this council's manifest/);
	});

	it("refuses open, asks, and close from another tab", async () => {
		const { herdr, dir, deps, open } = setup();
		assert.ok((await open()).ok);
		herdr.paneTabs.set(herdr.callerPane, "w1:t9");
		const reopened = await open();
		assert.match(reopened.ok ? "" : reopened.error, /bound to tab w1:t1, but the caller is in tab w1:t9/);
		const asker = await createSeatAsker(dir, deps);
		assert.match(asker.ok ? "" : asker.error, /bound to tab w1:t1/);
		const closed = await closeCouncilSeats(dir, deps);
		assert.match(closed.ok ? "" : closed.error, /bound to tab w1:t1/);

		herdr.paneTabs.set(herdr.callerPane, "w1:t1");
		const seatPane = readManifest(dir).seats[0]?.paneId ?? "";
		herdr.paneTabs.set(seatPane, "w1:t7");
		const seatAsker = await createSeatAsker(dir, deps);
		assert.ok(seatAsker.ok);
		const asked = await seatAsker.askSeat({
			seat: "A",
			promptFile: join(dir, "p.md"),
			outputFile: join(dir, "o.md"),
			timeoutMs: 60_000,
			outputCapBytes: 65_536,
		});
		assert.equal(asked.status, "failed");
		assert.match(asked.status === "failed" ? asked.error : "", /seat A is in tab w1:t7/);
	});

	it("closes only manifest seat panes and never the caller pane", async () => {
		const { herdr, dir, deps, open } = setup();
		assert.ok((await open()).ok);
		const [a, b] = readManifest(dir).seats.map((seat) => seat.paneId ?? "");
		herdr.agents.delete("council-demo-b");
		herdr.addAgent("council-demo-b", "w1:p77", "w1:t1");
		const closed = await closeCouncilSeats(dir, deps);
		assert.ok(closed.ok, closed.ok ? "" : closed.error);
		assert.deepEqual(closed.closed, [a]);
		assert.deepEqual(closed.skipped, [b]);
		assert.ok(herdr.paneTabs.has(herdr.callerPane));
		assert.ok(herdr.paneTabs.has("w1:p77"));
		assert.equal(
			herdr.calls.filter((call) => call[1] === "close").some((call) => call[2] === herdr.callerPane),
			false,
		);
	});
});
