/**
 * How a replacement session can read the previous session, and the prompt
 * text for each case. Pi applies `--tools` to the whole process and new
 * sessions start from the same tool configuration, so `/handoff` predicts the
 * replacement's tools from the current session and writes instructions for
 * only the tools it will have.
 */

export const HANDOFF_HISTORY_TOOLS = { read: "read_handoff_history", search: "search_handoff_history" } as const;

export type HistoryAccess =
	/** The outline reader, optionally with search. */
	| { kind: "handoff"; search: boolean }
	/** Only the handoff search tool. */
	| { kind: "handoff-search" }
	/** No handoff reader, but a tool that can read the transcript file. */
	| { kind: "file"; transcriptPath: string; reader: "read" | "bash"; searcher: "grep" | "bash" | undefined }
	| { kind: "unavailable" };

interface ToolApi {
	getAllTools(): readonly { name: string }[];
	getActiveTools(): readonly string[];
}

/**
 * Tools the replacement session is expected to have. Extension tools are
 * active in a new session whenever the allowlist registers them, so handoff
 * tools count when registered. Built-in tools such as `grep` can be registered
 * but inactive by default, so they count only when active now.
 */
export function availableHistoryTools(api: ToolApi): ReadonlySet<string> {
	const available = new Set(api.getActiveTools());
	for (const { name } of api.getAllTools()) {
		if (name === HANDOFF_HISTORY_TOOLS.read || name === HANDOFF_HISTORY_TOOLS.search) available.add(name);
	}
	return available;
}

export function selectHistoryAccess(tools: ReadonlySet<string>, transcriptPath: string): HistoryAccess {
	const search = tools.has(HANDOFF_HISTORY_TOOLS.search);
	if (tools.has(HANDOFF_HISTORY_TOOLS.read)) return { kind: "handoff", search };
	let reader: "read" | "bash" | undefined;
	if (tools.has("read")) reader = "read";
	else if (tools.has("bash")) reader = "bash";
	if (reader) {
		let searcher: "grep" | "bash" | undefined;
		if (tools.has("grep")) searcher = "grep";
		else if (tools.has("bash")) searcher = "bash";
		return { kind: "file", transcriptPath, reader, searcher };
	}
	return search ? { kind: "handoff-search" } : { kind: "unavailable" };
}

interface HistoryAccessText {
	/** Shown before the editor opens; an `error` notice means `/handoff` stops. */
	notice?: { level: "warning" | "error"; message: string };
	/** The `Lookup:` line of the history reference. */
	lookup: string;
	/** Where `--archive` leaves the previous session. */
	archivedStorage: string;
	/** Prompt instructions for reading the previous session, in order. */
	steps: string[];
}

const STORAGE = "in active or archived storage automatically.";
const ONLY_TOOL = "Read its history only through that tool; do not open the session file directly.";
const ARCHIVE_FALLBACK = "Storage: archived before this handoff; use the archive fallback by exact session ID.";
const WANTED = "the user requests, final assistant messages, decisions, files, commands, or errors you need";

function fileSteps(access: Extract<HistoryAccess, { kind: "file" }>): string[] {
	const intro =
		"This session cannot use the handoff history tools, so read the previous session's transcript file named in the Lookup line below. Each line is one JSON entry, and most of its bytes are tool output.";
	const readRanges = access.reader === "read" ? "read only those line ranges with read" : "print only those lines";
	switch (access.searcher) {
		case "grep":
			return [intro, `Search it with grep for ${WANTED}, then ${readRanges} instead of the whole file.`];
		case "bash":
			return [
				intro,
				`Search it with bash (for example \`rg -n\`) for ${WANTED}, then ${readRanges} instead of the whole file.`,
			];
		case undefined:
			return [
				intro,
				`Read it in bounded ranges with read's offset and limit, starting near the end where the resume point is, and stop once you have ${WANTED}.`,
			];
		default: {
			const exhaustive: never = access.searcher;
			throw new Error(`unhandled transcript searcher ${String(exhaustive)}`);
		}
	}
}

/** Everything the handoff command and prompt say about one access mode, kept together. */
export function describeHistoryAccess(access: HistoryAccess): HistoryAccessText {
	switch (access.kind) {
		case "handoff":
			return {
				notice: access.search
					? undefined
					: {
							level: "warning",
							message:
								"search_handoff_history is not in this session's tool allowlist; the replacement session will use read_handoff_history only.",
						},
				lookup: access.search
					? `Lookup: read_handoff_history and search_handoff_history find this session ${STORAGE} Read its history only through those tools; do not open the session file directly.`
					: `Lookup: read_handoff_history finds this session ${STORAGE} ${ONLY_TOOL}`,
				archivedStorage: ARCHIVE_FALLBACK,
				steps: [
					"Call read_handoff_history first, with no arguments. Its default outline maps the whole previous session with entry numbers.",
					'Expand only the entries you need with read_handoff_history({ view: "entries", offset, limit }).',
					...(access.search ? ["Use search_handoff_history to find a decision, file, command, or error."] : []),
				],
			};
		case "handoff-search":
			return {
				notice: {
					level: "warning",
					message:
						"read_handoff_history is not in this session's tool allowlist; the replacement session can only search the previous session.",
				},
				lookup: `Lookup: search_handoff_history finds this session ${STORAGE} ${ONLY_TOOL}`,
				archivedStorage: ARCHIVE_FALLBACK,
				steps: [
					`Only search_handoff_history is available for the previous session. Search it for ${WANTED}; matches are bounded snippets with entry numbers.`,
				],
			};
		case "file": {
			const { reader, searcher } = access;
			const tools = searcher && searcher !== reader ? `${reader} and ${searcher}` : reader;
			return {
				notice: {
					level: "warning",
					message:
						"This session's tool allowlist excludes read_handoff_history, and the replacement session inherits it. The handoff prompt points to the transcript file instead.",
				},
				lookup: `Lookup: the handoff history tools are not available in this session; read the transcript JSONL at ${access.transcriptPath} with ${tools}.`,
				archivedStorage: "Storage: archived before this handoff; the Lookup path is its archived location.",
				steps: fileSteps(access),
			};
		}
		case "unavailable":
			return {
				notice: {
					level: "error",
					message:
						"Cannot hand off: the replacement session inherits this session's tool allowlist, which has no tool that can read the previous session. Allow read_handoff_history (or read or bash) with --tools, then retry.",
				},
				lookup: "Lookup: no tool in this session can read the previous session.",
				archivedStorage: ARCHIVE_FALLBACK,
				steps: ["No tool in this session can read the previous session; ask the user how to proceed."],
			};
		default: {
			const exhaustive: never = access;
			throw new Error(`unhandled history access ${JSON.stringify(exhaustive)}`);
		}
	}
}
