/**
 * Bounded loading and structural validation of a user-supplied plan file.
 *
 * Both the fast implementer and the full plan→implement handoff accept an
 * explicit plan path. The bytes read here become the immutable snapshot handed
 * to hosted roles, so a later edit to the source file cannot change it. The
 * full handoff additionally requires the machine-checkable `[STEP-n]` / `[AC-n]`
 * contract that the execution ledger depends on.
 */

import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { createExecutionLedger } from "./execution-ledger.ts";
import { LIMITS } from "./types.ts";

/** A plan file's resolved path and the exact bounded text that was read. */
export interface PlanSnapshot {
	path: string;
	text: string;
}

type SnapshotLoad = { ok: true; snapshot: PlanSnapshot } | { ok: false; error: string };

/**
 * Read at most `LIMITS.plannerOutputBytes` from `planFile`, resolved against
 * `cwd`. Rejects unreadable, empty, and oversized files.
 */
export async function readPlanSnapshot(planFile: string, cwd: string): Promise<SnapshotLoad> {
	const path = resolve(cwd, planFile);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Cannot open plan file ${path}: ${detail}` };
	}
	try {
		const buffer = Buffer.alloc(LIMITS.plannerOutputBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > LIMITS.plannerOutputBytes) {
			return { ok: false, error: `Plan file ${path} exceeds ${LIMITS.plannerOutputBytes} bytes.` };
		}
		const text = buffer.toString("utf8", 0, bytesRead);
		if (!text.trim()) return { ok: false, error: `Plan file ${path} is empty.` };
		return { ok: true, snapshot: { path, text } };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Cannot read plan file ${path}: ${detail}` };
	} finally {
		await handle.close();
	}
}

/**
 * Load a plan for the full implementation handoff: a bounded snapshot plus the
 * ordered `[STEP-n]` / `[AC-n]` structure required before implementation. The
 * shared ledger parser requires steps but tolerates zero criteria, so the
 * handoff additionally requires at least one criterion to review against.
 */
export async function loadPlanHandoff(planFile: string, cwd: string): Promise<SnapshotLoad> {
	const read = await readPlanSnapshot(planFile, cwd);
	if (!read.ok) return read;
	const ledger = createExecutionLedger(read.snapshot.text);
	if (!ledger.ok) {
		return { ok: false, error: `Plan file ${read.snapshot.path} is not a valid ordered plan: ${ledger.error}` };
	}
	if (!ledger.items.some((item) => item.kind === "criterion")) {
		return {
			ok: false,
			error: `Plan file ${read.snapshot.path} is not a valid ordered plan: no acceptance criteria in the required [AC-n] format.`,
		};
	}
	return read;
}
