import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const MAX_SYMLINK_HOPS = 40;

type LoadedContext = Array<{ path: string; content: string }>;

interface ContextProvenanceDeps {
	loadContextFiles?: (options: { cwd: string; agentDir: string }) => LoadedContext;
	lstat?: typeof lstatSync;
	readlink?: typeof readlinkSync;
	realpath?: typeof realpathSync;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathChain(path: string, deps: Required<Pick<ContextProvenanceDeps, "lstat" | "readlink">>): string[] | null {
	let pending = normalize(resolve(path));
	const visitedLinks = new Set<string>();
	const chain: string[] = [];
	let hops = 0;
	while (true) {
		const root = resolve(pending, sep);
		const parts = relative(root, pending).split(sep).filter(Boolean);
		let current = root;
		let followed = false;
		for (let index = 0; index < parts.length; index++) {
			current = join(current, parts[index]);
			chain.push(current);
			let stat: Stats;
			try {
				stat = deps.lstat(current);
			} catch {
				return null;
			}
			if (!stat.isSymbolicLink()) continue;
			if (++hops > MAX_SYMLINK_HOPS || visitedLinks.has(current)) return null;
			visitedLinks.add(current);
			let target: string;
			try {
				target = deps.readlink(current);
			} catch {
				return null;
			}
			pending = resolve(dirname(current), target, ...parts.slice(index + 1));
			followed = true;
			break;
		}
		if (!followed) return chain;
	}
}

/** Conservatively decide whether Pi context loading must be disabled. */
export function contextFilesTouchChangedContent(options: {
	reviewRoot: string;
	changedPaths: string[];
	agentDir: string;
	deps?: ContextProvenanceDeps;
}): boolean {
	const root = resolve(options.reviewRoot);
	let canonicalRoot: string;
	try {
		canonicalRoot = (options.deps?.realpath ?? realpathSync)(root);
	} catch {
		return true;
	}
	const changed = new Set(options.changedPaths.flatMap((path) => [resolve(root, path), resolve(canonicalRoot, path)]));
	if (options.changedPaths.some((path) => CONTEXT_FILE_NAMES.includes(path.split("/").at(-1) ?? path))) return true;
	const load = options.deps?.loadContextFiles ?? loadProjectContextFiles;
	const fsDeps = { lstat: options.deps?.lstat ?? lstatSync, readlink: options.deps?.readlink ?? readlinkSync };
	let loaded: LoadedContext;
	try {
		loaded = load({ cwd: root, agentDir: options.agentDir });
	} catch {
		return true;
	}
	const selectedPaths = new Set(loaded.map((context) => resolve(context.path)));
	const searchDirs = [resolve(options.agentDir)];
	for (let directory = root; ; directory = dirname(directory)) {
		searchDirs.push(directory);
		if (dirname(directory) === directory) break;
	}
	for (const directory of searchDirs) {
		for (const name of CONTEXT_FILE_NAMES) {
			const candidate = join(directory, name);
			try {
				fsDeps.lstat(candidate);
			} catch {
				continue;
			}
			selectedPaths.add(candidate);
			break;
		}
	}
	for (const selectedPath of selectedPaths) {
		const chain = pathChain(selectedPath, fsDeps);
		if (!chain) return true;
		if (chain.some((path) => changed.has(path))) return true;
		const finalPath = chain.at(-1);
		if (finalPath && (isInside(root, finalPath) || isInside(canonicalRoot, finalPath))) {
			const containingRoot = isInside(root, finalPath) ? root : canonicalRoot;
			const rel = relative(containingRoot, finalPath);
			if (changed.has(resolve(containingRoot, rel))) return true;
		}
	}
	return false;
}
