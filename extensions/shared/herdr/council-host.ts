/**
 * Herdr placement for planning-council seats.
 *
 * Seats run as named Pi agents (`council-<slug>-<letter>`) in panes split to
 * the right of the caller's pane, stacked in one column, inside the caller's
 * tab. `manifest.json` binds the council to that tab and records every start
 * attempt, so a rerun adopts seats that are still starting, closes stale
 * council panes before restarting a vanished seat, and never starts a
 * duplicate agent.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CouncilRoster, SeatLetter } from "../council/roster.ts";
import type { CouncilRecordInfo, SeatAsk, SeatAskResult } from "../council/round.ts";
import {
	type CouncilManifest,
	councilPaths,
	initialCouncilState,
	type ManifestSeat,
	readManifest,
	readState,
	withCouncilLock,
	writeManifest,
	writeState,
} from "../council/store.ts";
import { COUNCIL_SEAT_PROMPT_FILE, READ_ONLY_PROMPT_FILE } from "../prompt-assets.ts";
import { attachHostedAgent, type HostDeps, openPaneHost, preflightHerdr } from "./agent-host.ts";
import { createHerdrCli, type HerdrCli } from "./herdr-cli.ts";

const CONTROL_TIMEOUT_MS = 15_000;
const SLUG_RE = /^[a-z0-9-]{1,21}$/;

interface CouncilHostDeps extends HostDeps {
	pidAlive?: (pid: number) => boolean;
}

interface SeatReport {
	letter: SeatLetter;
	model: string;
	name: string;
	state: "ready" | "waiting" | "failed";
	paneId?: string;
	error?: string;
}

type CouncilOpenResult =
	| { ok: true; status: "ready" | "waiting"; tabId: string; seats: SeatReport[] }
	| { ok: false; error: string; seats?: SeatReport[] };

/** Host-only seat data for `record.md` and failure messages. */
/* exported: cli.mjs builds council round and override input from the manifest */
export function councilRecordInfo(manifest: CouncilManifest): CouncilRecordInfo {
	const seatModels: CouncilRecordInfo["seatModels"] = {};
	const seatPanes: CouncilRecordInfo["seatPanes"] = {};
	for (const seat of manifest.seats) {
		seatModels[seat.letter] = seat.model;
		if (seat.paneId) seatPanes[seat.letter] = seat.paneId;
	}
	return { seatModels, seatPanes, plannerModel: manifest.plannerModel, excluded: manifest.excluded };
}

function councilSeatName(slug: string, letter: SeatLetter): string {
	return `council-${slug}-${letter.toLowerCase()}`;
}

function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

function tabMismatch(manifestTab: string, who: string, tabId: string): string {
	return `This council is bound to tab ${manifestTab}, but ${who} is in tab ${tabId}. Run council commands from tab ${manifestTab}, or run council close and use a new council directory.`;
}

async function callerTab(
	cli: HerdrCli,
	callerPane: string,
): Promise<{ ok: true; tabId: string } | { ok: false; error: string }> {
	const layout = await cli.paneLayout({ paneId: callerPane }, { timeoutMs: CONTROL_TIMEOUT_MS });
	if (!layout.ok) return { ok: false, error: `Could not read the caller's Herdr tab: ${layout.message}` };
	if (!layout.value.tabId) return { ok: false, error: "Herdr did not report the caller's tab." };
	return { ok: true, tabId: layout.value.tabId };
}

function sameRoster(manifest: CouncilManifest, roster: CouncilRoster): boolean {
	return (
		manifest.seats.length === roster.seats.length &&
		manifest.seats.every(
			(seat, index) => seat.letter === roster.seats[index]?.letter && seat.model === roster.seats[index]?.model,
		)
	);
}

type Reconciled = { action: "ready" | "waiting" | "start"; error?: string } | { action: "refuse"; error: string };

/** Decide what one manifest seat needs without starting anything. Never closes either caller pane. */
async function reconcileSeat(
	cli: HerdrCli,
	manifest: CouncilManifest,
	seat: ManifestSeat,
	callerPane: string,
): Promise<Reconciled> {
	const found = await cli.agentGet({ name: seat.name }, { timeoutMs: CONTROL_TIMEOUT_MS });
	if (found.ok) {
		const agent = found.value;
		if (agent.tabId !== manifest.tabId)
			return { action: "refuse", error: tabMismatch(manifest.tabId, `seat ${seat.letter}`, agent.tabId) };
		if (
			!seat.paneId ||
			agent.paneId !== seat.paneId ||
			!agent.cwd ||
			canonicalCwd(agent.cwd) !== canonicalCwd(manifest.cwd)
		) {
			return {
				action: "refuse",
				error: `Agent ${seat.name} already runs in pane ${agent.paneId}, outside this council's manifest. Close it or use another slug.`,
			};
		}
		if (agent.agentStatus === "idle" || agent.agentStatus === "done") return { action: "ready" };
		return {
			action: "waiting",
			error: `Seat ${seat.letter} is ${agent.agentStatus} in pane ${seat.paneId}; answer any prompt there, then rerun council open.`,
		};
	}
	if (found.code !== "agent_not_found")
		return { action: "refuse", error: `Could not inspect ${seat.name}: ${found.message}` };
	if (seat.paneId && seat.paneId !== manifest.callerPaneId && seat.paneId !== callerPane) {
		const layout = await cli.paneLayout({ paneId: seat.paneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
		if (layout.ok && layout.value.tabId === manifest.tabId) {
			const closed = await cli.paneClose({ paneId: seat.paneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
			if (!closed.ok && closed.code !== "pane_not_found") {
				return { action: "refuse", error: `Could not close the stale seat pane ${seat.paneId}: ${closed.message}` };
			}
		}
	}
	return { action: "start" };
}

/**
 * Check every manifest seat that still has an agent before a round or close.
 * A seat in another tab refuses the command; `requireRecordedPane` also
 * refuses an agent that moved out of its recorded pane.
 */
async function verifySeatPlacement(
	cli: HerdrCli,
	manifest: CouncilManifest,
	requireRecordedPane: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
	for (const seat of manifest.seats) {
		const found = await cli.agentGet({ name: seat.name }, { timeoutMs: CONTROL_TIMEOUT_MS });
		if (!found.ok) {
			if (found.code === "agent_not_found") continue;
			return { ok: false, error: `Could not inspect ${seat.name}: ${found.message}` };
		}
		if (found.value.tabId !== manifest.tabId) {
			return { ok: false, error: tabMismatch(manifest.tabId, `seat ${seat.letter}`, found.value.tabId) };
		}
		if (requireRecordedPane && found.value.paneId !== seat.paneId) {
			return {
				ok: false,
				error: `Seat ${seat.letter} runs in pane ${found.value.paneId}, not its recorded pane ${seat.paneId ?? "(none)"}; rerun council open.`,
			};
		}
	}
	return { ok: true };
}

/**
 * Open or reconcile council seats under the council lock. Seats that need a
 * start share one split of the caller's pane; a rerun with every seat alive
 * splits nothing.
 */
export async function openCouncilSeats(
	input: { dir: string; slug: string; cwd: string; roster: CouncilRoster; plannerModel: string; signal?: AbortSignal },
	deps: CouncilHostDeps,
): Promise<CouncilOpenResult> {
	if (!SLUG_RE.test(input.slug)) return { ok: false, error: "The council slug must match [a-z0-9-]{1,21}." };
	const locked = await withCouncilLock(input.dir, () => openLocked(input, deps), deps.pidAlive);
	return locked.ok ? locked.value : { ok: false, error: locked.error };
}

async function openLocked(
	input: { dir: string; slug: string; cwd: string; roster: CouncilRoster; plannerModel: string; signal?: AbortSignal },
	deps: CouncilHostDeps,
): Promise<CouncilOpenResult> {
	const preflight = await preflightHerdr(deps);
	if (!preflight.ok) return preflight;
	const cli = createHerdrCli(deps.exec);
	const caller = await callerTab(cli, preflight.callerPane);
	if (!caller.ok) return caller;
	const paths = councilPaths(input.dir);
	let manifest: CouncilManifest;
	if (existsSync(paths.manifest)) {
		manifest = readManifest(input.dir);
		if (manifest.slug !== input.slug) {
			return { ok: false, error: `This council directory belongs to slug ${manifest.slug}, not ${input.slug}.` };
		}
		if (manifest.tabId !== caller.tabId)
			return { ok: false, error: tabMismatch(manifest.tabId, "the caller", caller.tabId) };
		if (!sameRoster(manifest, input.roster)) {
			return {
				ok: false,
				error: `The resolved roster (${input.roster.seats.map((seat) => `${seat.letter}=${seat.model}`).join(", ")}) differs from this council's manifest. Use a new council directory.`,
			};
		}
	} else {
		manifest = {
			version: 1,
			slug: input.slug,
			cwd: input.cwd,
			tabId: caller.tabId,
			callerPaneId: preflight.callerPane,
			plannerModel: input.plannerModel,
			excluded: input.roster.excluded,
			timeoutMinutes: input.roster.timeoutMinutes,
			seats: input.roster.seats.map((seat) => ({
				letter: seat.letter,
				model: seat.model,
				name: councilSeatName(input.slug, seat.letter),
				state: "starting",
			})),
		};
		writeManifest(input.dir, manifest);
	}
	if (!existsSync(paths.state)) {
		writeState(
			input.dir,
			initialCouncilState(
				manifest.seats.map((seat) => seat.letter),
				input.roster.maxRounds,
			),
		);
	} else if (readState(input.dir).seats.join() !== manifest.seats.map((seat) => seat.letter).join()) {
		return { ok: false, error: "state.json and manifest.json disagree about the seats." };
	}

	const reports = new Map<SeatLetter, SeatReport>();
	const toStart: ManifestSeat[] = [];
	for (const seat of manifest.seats) {
		const reconciled = await reconcileSeat(cli, manifest, seat, preflight.callerPane);
		if (reconciled.action === "refuse") return { ok: false, error: reconciled.error };
		if (reconciled.action === "start") {
			toStart.push(seat);
			continue;
		}
		seat.state = reconciled.action === "ready" ? "ready" : "starting";
		reports.set(seat.letter, {
			letter: seat.letter,
			model: seat.model,
			name: seat.name,
			state: reconciled.action,
			...(seat.paneId ? { paneId: seat.paneId } : undefined),
			...(reconciled.error ? { error: reconciled.error } : undefined),
		});
	}
	writeManifest(input.dir, manifest);

	if (toStart.length > 0) {
		const opened = await openPaneHost(
			{
				owner: "council",
				label: input.slug,
				cwd: manifest.cwd,
				maxAgents: toStart.length,
				direction: "right",
				maxColumns: 1,
			},
			deps,
		);
		if (!opened.ok) return { ok: false, error: opened.error };
		try {
			await Promise.all(
				toStart.map(async (seat) => {
					const started = await opened.host.start({
						role: `seat-${seat.letter.toLowerCase()}`,
						exactName: seat.name,
						model: seat.model,
						cwd: manifest.cwd,
						inheritExtensions: true,
						noSkills: true,
						systemPromptFiles: [COUNCIL_SEAT_PROMPT_FILE, READ_ONLY_PROMPT_FILE],
						sessionName: `council/${manifest.slug}/${seat.letter.toLowerCase()}`,
						...(input.signal ? { signal: input.signal } : undefined),
					});
					let state: SeatReport["state"] = "ready";
					let error: string | undefined;
					if (started.ok) {
						seat.state = "ready";
						seat.paneId = started.agent.paneId;
						seat.tabId = started.agent.tabId;
					} else {
						seat.state = "starting";
						seat.tabId = manifest.tabId;
						if (started.paneId && !started.aborted) seat.paneId = started.paneId;
						else delete seat.paneId;
						// agent_not_ready keeps the named agent in its pane; a rerun adopts it.
						const survivor = seat.paneId
							? await cli.agentGet({ name: seat.name }, { timeoutMs: CONTROL_TIMEOUT_MS })
							: undefined;
						const waiting = survivor?.ok === true && survivor.value.paneId === seat.paneId;
						state = waiting ? "waiting" : "failed";
						error = waiting
							? `Seat ${seat.letter} is waiting at a prompt in pane ${seat.paneId}; answer it there, then rerun council open.`
							: started.error;
					}
					writeManifest(input.dir, manifest);
					reports.set(seat.letter, {
						letter: seat.letter,
						model: seat.model,
						name: seat.name,
						state,
						...(seat.paneId ? { paneId: seat.paneId } : undefined),
						...(error ? { error } : undefined),
					});
				}),
			);
		} finally {
			// A cancelled start may leave the first split without a seat; never orphan it.
			await opened.host.dispose({ closeUnassignedPanes: true });
		}
	}
	const seats = manifest.seats.flatMap((seat) => reports.get(seat.letter) ?? []);
	if (seats.some((seat) => seat.state === "failed")) {
		return { ok: false, error: "Some council seats did not start.", seats };
	}
	return {
		ok: true,
		status: seats.every((seat) => seat.state === "ready") ? "ready" : "waiting",
		tabId: manifest.tabId,
		seats,
	};
}

/**
 * Build the round's seat asker. Refuses a caller outside the council tab, and
 * verifies each seat's tab and pane before every ask. Cancellation sends the
 * seat Escape only; seat panes are never closed here.
 */
export async function createSeatAsker(
	dir: string,
	deps: HostDeps,
): Promise<
	| { ok: true; manifest: CouncilManifest; askSeat: (ask: SeatAsk) => Promise<SeatAskResult> }
	| { ok: false; error: string }
> {
	const preflight = await preflightHerdr(deps);
	if (!preflight.ok) return preflight;
	let manifest: CouncilManifest;
	try {
		manifest = readManifest(dir);
	} catch (error) {
		return {
			ok: false,
			error: `Could not read the council manifest: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const cli = createHerdrCli(deps.exec);
	const caller = await callerTab(cli, preflight.callerPane);
	if (!caller.ok) return caller;
	if (caller.tabId !== manifest.tabId)
		return { ok: false, error: tabMismatch(manifest.tabId, "the caller", caller.tabId) };
	const placement = await verifySeatPlacement(cli, manifest, true);
	if (!placement.ok) return placement;
	const askSeat = async (ask: SeatAsk): Promise<SeatAskResult> => {
		const seat = manifest.seats.find((entry) => entry.letter === ask.seat);
		if (!seat?.paneId || seat.state !== "ready") {
			return { status: "failed", error: `Seat ${ask.seat} is not ready; run council open first.` };
		}
		const attached = await attachHostedAgent(seat.name, deps);
		if (!attached.ok) return { status: "failed", error: `Seat ${ask.seat}: ${attached.error}` };
		try {
			if (attached.agent.tabId !== manifest.tabId) {
				return { status: "failed", error: tabMismatch(manifest.tabId, `seat ${ask.seat}`, attached.agent.tabId) };
			}
			if (attached.agent.paneId !== seat.paneId) {
				return {
					status: "failed",
					error: `Seat ${ask.seat} moved from pane ${seat.paneId} to ${attached.agent.paneId}; rerun council open.`,
				};
			}
			const result = await attached.agent.ask({
				promptFile: ask.promptFile,
				outputFile: ask.outputFile,
				timeoutMs: ask.timeoutMs,
				outputCapBytes: ask.outputCapBytes,
				...(ask.signal ? { signal: ask.signal } : undefined),
			});
			if (result.status === "completed") return { status: "completed", output: result.output };
			if (result.status === "failed") return { status: "failed", error: result.error };
			return { status: result.status };
		} finally {
			await attached.agent.dispose();
		}
	};
	return { ok: true, manifest, askSeat };
}

/** Close the manifest's seat panes whose agents still match the manifest pane and tab. */
export async function closeCouncilSeats(
	dir: string,
	deps: CouncilHostDeps,
): Promise<{ ok: true; closed: string[]; skipped: string[] } | { ok: false; error: string }> {
	const locked = await withCouncilLock(
		dir,
		async (): Promise<{ ok: true; closed: string[]; skipped: string[] } | { ok: false; error: string }> => {
			const preflight = await preflightHerdr(deps);
			if (!preflight.ok) return preflight;
			const cli = createHerdrCli(deps.exec);
			let manifest: CouncilManifest;
			try {
				manifest = readManifest(dir);
			} catch (error) {
				return {
					ok: false,
					error: `Could not read the council manifest: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			const caller = await callerTab(cli, preflight.callerPane);
			if (!caller.ok) return caller;
			if (caller.tabId !== manifest.tabId)
				return { ok: false, error: tabMismatch(manifest.tabId, "the caller", caller.tabId) };
			const placement = await verifySeatPlacement(cli, manifest, false);
			if (!placement.ok) return placement;
			const closed: string[] = [];
			const skipped: string[] = [];
			for (const seat of manifest.seats) {
				if (!seat.paneId || seat.paneId === preflight.callerPane || seat.paneId === manifest.callerPaneId) continue;
				const found = await cli.agentGet({ name: seat.name }, { timeoutMs: CONTROL_TIMEOUT_MS });
				if (!found.ok || found.value.paneId !== seat.paneId || found.value.tabId !== manifest.tabId) {
					skipped.push(seat.paneId);
					continue;
				}
				const result = await cli.paneClose({ paneId: seat.paneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
				if (!result.ok) return { ok: false, error: `Could not close seat pane ${seat.paneId}: ${result.message}` };
				closed.push(seat.paneId);
				seat.state = "starting";
				delete seat.paneId;
			}
			writeManifest(dir, manifest);
			return { ok: true, closed, skipped };
		},
		deps.pidAlive,
	);
	return locked.ok ? locked.value : { ok: false, error: locked.error };
}
