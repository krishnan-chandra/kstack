/**
 * Terminal placement for planning-council seats (Herdr or Rex).
 *
 * Seats run as Pi agents (`council-<slug>-<letter>`) in panes split to the
 * right of the caller's pane, stacked in one column, inside the caller's tab
 * (or Rex window). `manifest.json` binds the council to that backend and tab,
 * records each seat's pane and sidecar state path, adopts seats that are still
 * starting, closes stale council panes before restarting a vanished seat, and
 * refuses cross-backend or foreign-agent conflicts.
 */

import { existsSync, rmSync } from "node:fs";
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
import { type HostDeps, openPaneHostIn } from "./agent-host.ts";
import { connectBackend, resolveTerminalBackend, type TerminalSession } from "./backends.ts";
import { sameCwd } from "./cwd.ts";
import { attachHostedAgent } from "./hosted-agent.ts";
import {
	type AgentRef,
	type AgentSnapshot,
	type BackendKind,
	backendLabel,
	isSettledStatus,
	type Outcome,
	type TerminalBackend,
} from "./terminal-backend.ts";

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
	| { ok: true; status: "ready" | "waiting"; backend: BackendKind; tabId: string; seats: SeatReport[] }
	| { ok: false; error: string; seats?: SeatReport[] };

type CouncilPaths = ReturnType<typeof councilPaths>;

type Failure = { ok: false; error: string };

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

function tabMismatch(manifestTab: string, who: string, tabId: string): string {
	return `This council is bound to tab ${manifestTab}, but ${who} is in tab ${tabId}. Run council commands from tab ${manifestTab}, or run council close and use a new council directory.`;
}

function foreignAgent(seat: ManifestSeat, paneId: string): string {
	return `Agent ${seat.name} already runs in pane ${paneId}, outside this council's manifest. Close it or use another slug.`;
}

function sameRoster(manifest: CouncilManifest, roster: CouncilRoster): boolean {
	return (
		manifest.seats.length === roster.seats.length &&
		manifest.seats.every(
			(seat, index) => seat.letter === roster.seats[index]?.letter && seat.model === roster.seats[index]?.model,
		)
	);
}

/** The seat's sidecar path is derived from the council directory, never stored. */
function seatRef(paths: CouncilPaths, seat: ManifestSeat, paneId: string): AgentRef {
	return { name: seat.name, paneId, stateFile: paths.seatState(seat.letter) };
}

function loadManifest(dir: string): { ok: true; manifest: CouncilManifest } | Failure {
	try {
		return { ok: true, manifest: readManifest(dir) };
	} catch (error) {
		return {
			ok: false,
			error: `Could not read the council manifest: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Connect the backend bound to an existing council. The backend check runs
 * before preflight, so a cross-backend command never spawns the other
 * multiplexer; the caller must sit in the council's tab.
 */
async function connectCouncil(
	deps: HostDeps,
	manifest: CouncilManifest | undefined,
): Promise<{ ok: true; session: TerminalSession } | Failure> {
	const resolved = resolveTerminalBackend(deps);
	if (!resolved.ok) return resolved;
	if (manifest && manifest.terminal !== resolved.backend.kind) {
		const label = backendLabel(manifest.terminal);
		return {
			ok: false,
			error: `This council was opened under ${label}; run it from ${label} or start a new council directory.`,
		};
	}
	const connected = await connectBackend(resolved.backend);
	if (!connected.ok) return connected;
	if (manifest && manifest.tabId !== connected.session.caller.tabId) {
		return { ok: false, error: tabMismatch(manifest.tabId, "the caller", connected.session.caller.tabId) };
	}
	return connected;
}

/**
 * Live agents that could be this seat: the verified agent in its recorded
 * pane, or any agent holding the seat name when no pane is recorded.
 */
async function seatAgents(
	backend: TerminalBackend,
	paths: CouncilPaths,
	seat: ManifestSeat,
): Promise<Outcome<AgentSnapshot[]>> {
	if (!seat.paneId) return backend.findAgentsNamed(seat.name);
	const found = await backend.getAgent(seatRef(paths, seat, seat.paneId));
	if (found.ok) return { ok: true, value: [found.value] };
	if (found.code === "not_found") return { ok: true, value: [] };
	return found;
}

type Reconciled = { action: "ready" | "waiting" | "start"; error?: string } | { action: "refuse"; error: string };

/** Decide what one manifest seat needs without starting anything. Never closes either caller pane. */
async function reconcileSeat(
	backend: TerminalBackend,
	paths: CouncilPaths,
	manifest: CouncilManifest,
	seat: ManifestSeat,
	callerPane: string,
): Promise<Reconciled> {
	if (seat.paneId) {
		const found = await backend.getAgent(seatRef(paths, seat, seat.paneId));
		if (found.ok) {
			const agent = found.value;
			if (agent.tabId !== manifest.tabId) {
				return { action: "refuse", error: tabMismatch(manifest.tabId, `seat ${seat.letter}`, agent.tabId) };
			}
			if (agent.paneId !== seat.paneId || !sameCwd(agent.cwd, manifest.cwd)) {
				return { action: "refuse", error: foreignAgent(seat, agent.paneId) };
			}
			if (isSettledStatus(agent.status)) return { action: "ready" };
			return {
				action: "waiting",
				error: `Seat ${seat.letter} is ${agent.status} in pane ${seat.paneId}; answer any prompt there, then rerun council open.`,
			};
		}
		if (found.code !== "not_found") {
			return { action: "refuse", error: `Could not inspect ${seat.name}: ${found.message}` };
		}
	}

	// The seat is absent from its pane; a same-named agent anywhere else is foreign.
	const named = await backend.findAgentsNamed(seat.name);
	if (!named.ok) return { action: "refuse", error: `Could not inspect ${seat.name}: ${named.message}` };
	const conflict = named.value.find((entry) => entry.paneId !== seat.paneId);
	if (conflict) return { action: "refuse", error: foreignAgent(seat, conflict.paneId) };

	if (seat.paneId && seat.paneId !== manifest.callerPaneId && seat.paneId !== callerPane) {
		const layout = await backend.paneGeometry(seat.paneId);
		if (layout.ok && layout.value.tabId === manifest.tabId) {
			const closed = await backend.closePane(seat.paneId);
			if (!closed.ok && closed.code !== "not_found") {
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
	backend: TerminalBackend,
	paths: CouncilPaths,
	manifest: CouncilManifest,
	requireRecordedPane: boolean,
): Promise<{ ok: true } | Failure> {
	for (const seat of manifest.seats) {
		const found = await seatAgents(backend, paths, seat);
		if (!found.ok) return { ok: false, error: `Could not inspect ${seat.name}: ${found.message}` };
		for (const agent of found.value) {
			if (agent.tabId !== manifest.tabId) {
				return { ok: false, error: tabMismatch(manifest.tabId, `seat ${seat.letter}`, agent.tabId) };
			}
			if (requireRecordedPane && agent.paneId !== seat.paneId) {
				return {
					ok: false,
					error: `Seat ${seat.letter} runs in pane ${agent.paneId}, not its recorded pane ${seat.paneId ?? "(none)"}; rerun council open.`,
				};
			}
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
	const paths = councilPaths(input.dir);
	const existingManifest = existsSync(paths.manifest) ? readManifest(input.dir) : undefined;
	const connected = await connectCouncil(deps, existingManifest);
	if (!connected.ok) return connected;
	const { session } = connected;
	const { backend, caller } = session;

	let manifest: CouncilManifest;
	if (existingManifest) {
		manifest = existingManifest;
		if (manifest.slug !== input.slug) {
			return { ok: false, error: `This council directory belongs to slug ${manifest.slug}, not ${input.slug}.` };
		}
		if (!sameRoster(manifest, input.roster)) {
			return {
				ok: false,
				error: `The resolved roster (${input.roster.seats.map((seat) => `${seat.letter}=${seat.model}`).join(", ")}) differs from this council's manifest. Use a new council directory.`,
			};
		}
	} else {
		manifest = {
			version: 1,
			terminal: backend.kind,
			slug: input.slug,
			cwd: input.cwd,
			tabId: caller.tabId,
			callerPaneId: caller.paneId,
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
		const reconciled = await reconcileSeat(backend, paths, manifest, seat, caller.paneId);
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
		const opened = await openPaneHostIn(
			session,
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
						stateFile: paths.seatState(seat.letter),
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
						// A startup prompt keeps the agent alive in its pane; a rerun adopts it.
						const survivor = seat.paneId ? await backend.getAgent(seatRef(paths, seat, seat.paneId)) : undefined;
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
		backend: backend.kind,
		tabId: manifest.tabId,
		seats,
	};
}

type SeatAskerResult =
	| { ok: true; manifest: CouncilManifest; askSeat: (ask: SeatAsk) => Promise<SeatAskResult> }
	| Failure;

/**
 * Build the round's seat asker. Refuses a caller outside the council backend or
 * tab, and verifies each seat's tab and pane before every ask. Cancellation
 * sends the seat Escape only; seat panes are never closed here.
 */
export async function createSeatAsker(dir: string, deps: HostDeps): Promise<SeatAskerResult> {
	const loaded = loadManifest(dir);
	if (!loaded.ok) return loaded;
	const { manifest } = loaded;
	const connected = await connectCouncil(deps, manifest);
	if (!connected.ok) return connected;
	const { session } = connected;
	const paths = councilPaths(dir);
	const placement = await verifySeatPlacement(session.backend, paths, manifest, true);
	if (!placement.ok) return placement;

	const askSeat = async (ask: SeatAsk): Promise<SeatAskResult> => {
		const seat = manifest.seats.find((entry) => entry.letter === ask.seat);
		if (!seat?.paneId || seat.state !== "ready") {
			return { status: "failed", error: `Seat ${ask.seat} is not ready; run council open first.` };
		}
		const attached = await attachHostedAgent(seatRef(paths, seat, seat.paneId), session, deps.clock);
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

type CouncilCloseResult = { ok: true; closed: string[]; skipped: string[] } | Failure;

/** Close the manifest's seat panes whose agents still match the manifest pane and tab. */
export async function closeCouncilSeats(dir: string, deps: CouncilHostDeps): Promise<CouncilCloseResult> {
	const locked = await withCouncilLock(
		dir,
		async (): Promise<CouncilCloseResult> => {
			const loaded = loadManifest(dir);
			if (!loaded.ok) return loaded;
			const { manifest } = loaded;
			const connected = await connectCouncil(deps, manifest);
			if (!connected.ok) return connected;
			const { backend, caller } = connected.session;
			const paths = councilPaths(dir);
			const placement = await verifySeatPlacement(backend, paths, manifest, false);
			if (!placement.ok) return placement;

			const closed: string[] = [];
			const skipped: string[] = [];
			for (const seat of manifest.seats) {
				if (!seat.paneId || seat.paneId === caller.paneId || seat.paneId === manifest.callerPaneId) continue;
				const found = await backend.getAgent(seatRef(paths, seat, seat.paneId));
				if (!found.ok || found.value.paneId !== seat.paneId || found.value.tabId !== manifest.tabId) {
					skipped.push(seat.paneId);
					continue;
				}
				const result = await backend.closePane(seat.paneId);
				if (!result.ok) return { ok: false, error: `Could not close seat pane ${seat.paneId}: ${result.message}` };
				closed.push(seat.paneId);
				seat.state = "starting";
				delete seat.paneId;
				rmSync(paths.seatState(seat.letter), { force: true });
			}
			writeManifest(dir, manifest);
			return { ok: true, closed, skipped };
		},
		deps.pidAlive,
	);
	return locked.ok ? locked.value : { ok: false, error: locked.error };
}
