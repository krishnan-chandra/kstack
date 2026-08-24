import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

async function findFiles(root, predicate) {
	const entries = await readdir(root, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await findFiles(path, predicate)));
		} else if (entry.isFile() && predicate(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

function sortedUnique(values) {
	return [...new Set(values)].sort();
}

function commandNamesFromSource(source, path) {
	const names = [];
	for (const match of source.matchAll(/\bpi\.registerCommand\(\s*["']([^"']+)["']/g)) {
		names.push(match[1]);
	}
	if (source.includes(".registerCommand(") && names.length === 0) {
		throw new Error(`Cannot derive extension command names from ${path}.`);
	}
	return names;
}

async function discoverExtensionCommands(packageRoot) {
	const entrypoints = await findFiles(join(packageRoot, "extensions"), (name) => name === "index.ts");
	const commands = [];
	for (const path of entrypoints.sort()) {
		commands.push(...commandNamesFromSource(await readFile(path, "utf8"), path));
	}
	return sortedUnique(commands);
}

function skillNameFromSource(source, path) {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
	const name = frontmatter?.[1].match(/^name:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/m);
	const value = name?.[1] ?? name?.[2] ?? name?.[3];
	if (!value) throw new Error(`Cannot derive a skill name from ${path}.`);
	return `skill:${value}`;
}

async function discoverSkillCommands(packageRoot) {
	const skillFiles = await findFiles(join(packageRoot, "skills"), (name) => name === "SKILL.md");
	const commands = [];
	for (const path of skillFiles.sort()) {
		commands.push(skillNameFromSource(await readFile(path, "utf8"), path));
	}
	return sortedUnique(commands);
}

function packageFilter(source, { extensions = [], skills = [] } = {}) {
	return { source, extensions, skills, prompts: [], themes: [] };
}

function profile({ id, purpose, packages, skillPaths = [], inventory, loadExtensions, loadSkills }) {
	const requiredCommands = [
		...(loadExtensions ? inventory.extensionCommands : []),
		...(loadSkills ? inventory.skillCommands : []),
	];
	const forbiddenCommands = [
		...(loadExtensions ? [] : inventory.extensionCommands),
		...(loadSkills ? [] : inventory.skillCommands),
	];
	return {
		id,
		purpose,
		packages,
		skillPaths,
		requiredCommands,
		forbiddenCommands,
		timingRequirements: { main: true, extensions: loadExtensions },
	};
}

export async function createScenarioProfiles(packageRoot) {
	const source = resolve(packageRoot);
	const inventory = {
		extensionCommands: await discoverExtensionCommands(source),
		skillCommands: await discoverSkillCommands(source),
	};
	if (inventory.extensionCommands.length === 0 || inventory.skillCommands.length === 0) {
		throw new Error("Cannot benchmark Kstack without a discovered extension-command and skill inventory.");
	}

	return {
		inventory,
		profiles: [
			profile({
				id: "empty",
				purpose: "Fixed Pi and built-in startup cost.",
				packages: [],
				inventory,
				loadExtensions: false,
				loadSkills: false,
			}),
			profile({
				id: "package-disabled",
				purpose: "Package resolution and filtering overhead without package resources.",
				packages: [packageFilter(source)],
				inventory,
				loadExtensions: false,
				loadSkills: false,
			}),
			profile({
				id: "skills-only",
				purpose: "Kstack skill discovery cost.",
				packages: [],
				skillPaths: [join(source, "skills")],
				inventory,
				loadExtensions: false,
				loadSkills: true,
			}),
			profile({
				id: "extensions-only",
				purpose: "Kstack extension loading cost.",
				packages: [packageFilter(source, { extensions: ["kstack.ts"] })],
				inventory,
				loadExtensions: true,
				loadSkills: false,
			}),
			profile({
				id: "full",
				purpose: "Installed Kstack behavior.",
				packages: [source],
				skillPaths: [join(source, "skills")],
				inventory,
				loadExtensions: true,
				loadSkills: true,
			}),
		],
	};
}
