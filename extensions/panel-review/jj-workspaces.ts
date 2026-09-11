/** Discover live jj workspaces before a local review resolves workspace-relative `@`. */

import { existsSync, realpathSync } from "node:fs";
import { fallbackTerminalText, sanitizeDisplayText } from "../shared/terminal-text.ts";
import { type BoundaryValue, isObject, isString } from "../shared/validation.ts";
import { type CommandExec, defaultCommandExec } from "./repository-source.ts";

const MAX_WORKSPACE_LIST_BYTES = 1024 * 1024;
const MAX_WORKSPACES = 200;
const MAX_LABEL_WIDTH = 240;
const CHANGE_ID_PATTERN = /^[a-z]+$/;
const WORKSPACE_LIST_TEMPLATE =
	'"{\\"name\\":" ++ json(name) ++ ",\\"root\\":" ++ json(root) ++ ",\\"changeId\\":" ++ json(target.change_id()) ++ ",\\"bookmarks\\":" ++ json(target.local_bookmarks().map(|b| b.name())) ++ ",\\"description\\":" ++ json(target.description().first_line()) ++ "}\\n"';

interface JjWorkspaceRecord {
	name: string;
	root: string | null;
	changeId: string;
	bookmarks: string[];
	description: string;
}

export interface JjWorkspaceChoice extends Omit<JjWorkspaceRecord, "root"> {
	/** Canonical live workspace root. */
	root: string;
	current: boolean;
}

interface DiscoverJjWorkspacesOptions {
	/** Canonical root of the workspace that contains the Pi session cwd. */
	currentRoot: string;
	exec?: CommandExec;
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
}

function invalidRecord(line: number): Error {
	return new Error(`panel-review received an invalid jj workspace record on line ${line}.`);
}

function parseRecord(line: string, lineNumber: number): JjWorkspaceRecord {
	let value: BoundaryValue;
	try {
		value = JSON.parse(line);
	} catch {
		throw invalidRecord(lineNumber);
	}
	if (!isObject(value) || Array.isArray(value)) throw invalidRecord(lineNumber);
	if (!("name" in value) || !isString(value.name) || value.name.length === 0) throw invalidRecord(lineNumber);
	if (!("root" in value) || !(value.root === null || isString(value.root))) throw invalidRecord(lineNumber);
	if (!("changeId" in value) || !isString(value.changeId) || !CHANGE_ID_PATTERN.test(value.changeId))
		throw invalidRecord(lineNumber);
	if (!("bookmarks" in value) || !Array.isArray(value.bookmarks) || !value.bookmarks.every(isString))
		throw invalidRecord(lineNumber);
	if (!("description" in value) || !isString(value.description)) throw invalidRecord(lineNumber);
	return {
		name: value.name,
		root: value.root,
		changeId: value.changeId,
		bookmarks: value.bookmarks,
		description: value.description,
	};
}

/**
 * List workspace records without snapshotting sibling working copies. Entries
 * without a live recorded root are not offered to the user.
 */
export function discoverJjWorkspaces(
	options: DiscoverJjWorkspacesOptions,
): [JjWorkspaceChoice, ...JjWorkspaceChoice[]] {
	const exec = options.exec ?? defaultCommandExec;
	const exists = options.exists ?? existsSync;
	const realpath = options.realpath ?? ((path: string) => realpathSync(path));
	let output: string;
	try {
		output = exec(
			"jj",
			["--ignore-working-copy", "workspace", "list", "-T", WORKSPACE_LIST_TEMPLATE],
			options.currentRoot,
		);
	} catch {
		throw new Error("Could not list jj workspaces. Pass --repo <path> to select one explicitly.");
	}
	if (Buffer.byteLength(output, "utf8") > MAX_WORKSPACE_LIST_BYTES) {
		throw new Error("jj workspace list output exceeded the 1 MiB panel-review limit.");
	}
	const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
	if (lines.length > MAX_WORKSPACES) throw new Error(`jj reported more than ${MAX_WORKSPACES} workspaces.`);

	const seenRoots = new Set<string>();
	const workspaces: JjWorkspaceChoice[] = [];
	for (const [index, line] of lines.entries()) {
		const record = parseRecord(line, index + 1);
		if (record.root === null || !exists(record.root)) continue;
		let root: string;
		try {
			root = realpath(record.root);
		} catch {
			continue;
		}
		if (seenRoots.has(root)) throw new Error("Multiple jj workspace entries resolve to the same root.");
		seenRoots.add(root);
		workspaces.push({ ...record, root, current: root === options.currentRoot });
	}
	const current = workspaces.find((workspace) => workspace.current);
	if (!current) throw new Error("jj workspace list did not include the current jj workspace with a live root.");
	const others = workspaces
		.filter((workspace) => !workspace.current)
		.sort((left, right) => left.name.localeCompare(right.name));
	return [current, ...others];
}

function clip(value: string, maxWidth: number): string {
	return fallbackTerminalText.truncateToWidth(sanitizeDisplayText(value), maxWidth);
}

/** Format one single-line, bounded option for `ctx.ui.select`. */
export function formatJjWorkspaceChoice(options: { workspace: JjWorkspaceChoice; index: number }): string {
	const { workspace, index } = options;
	const name = clip(workspace.name, 40);
	const root = clip(workspace.root, 110);
	const identity =
		workspace.bookmarks.length > 0 ? workspace.bookmarks.join(", ") : workspace.description || "no description";
	const label = `${index + 1}. ${name}${workspace.current ? " (current)" : ""} · @ ${workspace.changeId.slice(0, 8)} · ${clip(identity, 60)} · ${root}`;
	return clip(label, MAX_LABEL_WIDTH);
}
