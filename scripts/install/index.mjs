#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULTS_DIR = join(REPO_ROOT, "config", "pi-defaults");
const MANAGED_SKILLS_FILE = ".kstack-managed.json";

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function getAgentDir(env = process.env) {
	return expandHome(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

export function readJsonObject(path, { allowMissing = false } = {}) {
	if (allowMissing && !existsSync(path)) return {};

	let value;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error.message}`);
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Expected ${path} to contain a JSON object`);
	}
	return value;
}

function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);

	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function applyPiDefaults({ agentDir = getAgentDir(), defaultsDir = DEFAULTS_DIR } = {}) {
	const files = ["settings.json", "keybindings.json"];
	const updates = [];

	// Parse everything before writing anything so malformed JSON cannot cause a partial update.
	for (const file of files) {
		const destination = join(agentDir, file);
		const current = readJsonObject(destination, { allowMissing: true });
		const defaults = readJsonObject(join(defaultsDir, file));
		updates.push({ destination, value: { ...current, ...defaults } });
	}

	for (const update of updates) {
		writeJsonAtomic(update.destination, update.value);
	}

	return updates.map((update) => update.destination);
}

export function runPiInstall(repoRoot = REPO_ROOT) {
	const result = spawnSync("pi", ["install", repoRoot], { stdio: "inherit" });
	if (result.error) throw new Error(`Failed to run pi install: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`pi install exited with status ${result.status ?? "unknown"}`);
}

function pathKind(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

export function syncGlobalSkills(
	repoRoot = REPO_ROOT,
	globalSkillsDir = process.env.AGENTS_SKILLS_DIR || join(homedir(), ".agents", "skills"),
) {
	const sourceDir = join(repoRoot, "skills");
	const managedPath = join(globalSkillsDir, MANAGED_SKILLS_FILE);
	mkdirSync(globalSkillsDir, { recursive: true });

	const previous = readJsonObject(managedPath, { allowMissing: true });
	const current = {};
	const skillNames = readdirSync(sourceDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(sourceDir, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();

	for (const name of skillNames) {
		const source = join(sourceDir, name);
		const destination = join(globalSkillsDir, name);
		const destinationKind = pathKind(destination);
		if (!destinationKind) continue;
		const linkTarget = destinationKind.isSymbolicLink() ? readlinkSync(destination) : undefined;
		const isManagedLink = linkTarget !== undefined && previous[name] === linkTarget;
		if (!isManagedLink && linkTarget !== source) {
			throw new Error(`Refusing to replace unmanaged skill at ${destination}`);
		}
	}

	for (const name of skillNames) {
		const source = join(sourceDir, name);
		const destination = join(globalSkillsDir, name);
		const destinationKind = pathKind(destination);
		if (destinationKind?.isSymbolicLink() && readlinkSync(destination) !== source) rmSync(destination);
		if (!pathKind(destination)) symlinkSync(source, destination, "dir");
		current[name] = source;
	}

	for (const [name, target] of Object.entries(previous)) {
		if (name in current) continue;
		const destination = join(globalSkillsDir, name);
		const destinationKind = pathKind(destination);
		if (destinationKind?.isSymbolicLink() && readlinkSync(destination) === target) rmSync(destination);
	}

	writeJsonAtomic(managedPath, current);
	return skillNames;
}

export function install({
	repoRoot = REPO_ROOT,
	agentDir = getAgentDir(),
	defaultsDir = DEFAULTS_DIR,
	installPackage = runPiInstall,
	syncSkills = syncGlobalSkills,
} = {}) {
	// Preflight both source and destination JSON before pi changes package registration.
	for (const file of ["settings.json", "keybindings.json"]) {
		readJsonObject(join(defaultsDir, file));
		readJsonObject(join(agentDir, file), { allowMissing: true });
	}

	installPackage(repoRoot);
	syncSkills(repoRoot);
	return applyPiDefaults({ agentDir, defaultsDir });
}

function main() {
	try {
		const updated = install();
		console.log("\nInstalled kstack, linked skills into ~/.agents/skills, and applied Pi defaults:");
		for (const path of updated) console.log(`  ${path}`);
		console.log("\nRun /reload in an active Pi session, or restart Pi, to apply the changes.");
	} catch (error) {
		console.error(`kstack install failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
