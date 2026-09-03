import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPiDefaults, install, syncGlobalSkills } from "./index.mjs";

const defaultsDir = join(import.meta.dirname, "..", "..", "config", "pi-defaults");

function tempAgentDir() {
	return mkdtempSync(join(tmpdir(), "kstack-install-"));
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("applyPiDefaults merges managed preferences without removing existing config", () => {
	const agentDir = tempAgentDir();
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultModel: "example-model", hideThinkingBlock: false, packages: ["example"] }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "keybindings.json"),
		`${JSON.stringify({ "app.clear": "ctrl+u", "tui.input.submit": "enter" }, null, 2)}\n`,
	);

	applyPiDefaults({ agentDir, defaultsDir });

	assert.deepEqual(readJson(join(agentDir, "settings.json")), {
		defaultModel: "example-model",
		hideThinkingBlock: true,
		packages: ["example"],
		steeringMode: "all",
		followUpMode: "all",
	});
	assert.deepEqual(readJson(join(agentDir, "keybindings.json")), {
		"app.clear": "ctrl+u",
		"tui.input.submit": "enter",
		"app.message.followUp": "alt+enter",
	});
});

test("applyPiDefaults merges floor models without removing user models or providers", () => {
	const agentDir = tempAgentDir();
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					openrouter: {
						headers: { "X-Title": "Personal Pi" },
						models: [
							{ id: "custom/model", name: "Custom model" },
							{ id: "openai/gpt-5.6-sol:floor", name: "Stale floor model" },
						],
					},
					local: { baseUrl: "http://localhost:8080/v1", models: [] },
				},
			},
			null,
			2,
		)}\n`,
	);

	applyPiDefaults({ agentDir, defaultsDir });

	const models = readJson(join(agentDir, "models.json"));
	assert.deepEqual(models.providers.openrouter.headers, { "X-Title": "Personal Pi" });
	assert.equal(models.providers.openrouter.models[0].id, "custom/model");
	assert.equal(models.providers.openrouter.models[1].name, "OpenAI: GPT-5.6 Sol (Floor)");
	assert.deepEqual(
		models.providers.openrouter.models.slice(1).map((model) => model.id),
		["openai/gpt-5.6-sol:floor", "openai/gpt-5.6-sol-pro:floor", "google/gemini-3.8-flash:floor"],
	);
	assert.deepEqual(models.providers.local, { baseUrl: "http://localhost:8080/v1", models: [] });
});

test("install registers the package and global skills before merging Pi defaults", () => {
	const agentDir = tempAgentDir();
	const calls = [];

	install({
		repoRoot: "/example/kstack",
		agentDir,
		defaultsDir,
		installPackage(repoRoot) {
			calls.push(["package", repoRoot]);
			writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [repoRoot] }, null, 2)}\n`);
		},
		syncSkills(repoRoot) {
			calls.push(["skills", repoRoot]);
		},
	});

	assert.deepEqual(calls, [
		["package", "/example/kstack"],
		["skills", "/example/kstack"],
	]);
	assert.deepEqual(readJson(join(agentDir, "settings.json")), {
		packages: ["/example/kstack"],
		hideThinkingBlock: true,
		steeringMode: "all",
		followUpMode: "all",
	});
	assert.deepEqual(readJson(join(agentDir, "keybindings.json")), {
		"tui.input.submit": "enter",
		"app.message.followUp": "alt+enter",
	});
});

test("syncGlobalSkills links skills and removes stale managed links", () => {
	const root = mkdtempSync(join(tmpdir(), "kstack-repo-"));
	const globalSkillsDir = mkdtempSync(join(tmpdir(), "agent-skills-"));
	for (const name of ["alpha", "beta"]) {
		mkdirSync(join(root, "skills", name), { recursive: true });
		writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
	}

	syncGlobalSkills(root, globalSkillsDir);
	assert.equal(readlinkSync(join(globalSkillsDir, "alpha")), join(root, "skills", "alpha"));
	assert.equal(readlinkSync(join(globalSkillsDir, "beta")), join(root, "skills", "beta"));

	mkdirSync(join(root, "skills", "beta-renamed"));
	writeFileSync(join(root, "skills", "beta-renamed", "SKILL.md"), "---\nname: beta-renamed\ndescription: test\n---\n");
	rmSync(join(root, "skills", "beta"), { recursive: true });
	syncGlobalSkills(root, globalSkillsDir);

	assert.throws(() => readlinkSync(join(globalSkillsDir, "beta")), /ENOENT/);
	assert.equal(readlinkSync(join(globalSkillsDir, "beta-renamed")), join(root, "skills", "beta-renamed"));
});

test("syncGlobalSkills refuses all changes when an unmanaged skill conflicts", () => {
	const root = mkdtempSync(join(tmpdir(), "kstack-repo-"));
	const globalSkillsDir = mkdtempSync(join(tmpdir(), "agent-skills-"));
	for (const name of ["alpha", "beta"]) {
		mkdirSync(join(root, "skills", name), { recursive: true });
		writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
	}
	mkdirSync(join(globalSkillsDir, "beta"));

	assert.throws(() => syncGlobalSkills(root, globalSkillsDir), /Refusing to replace unmanaged skill/);
	assert.throws(() => readlinkSync(join(globalSkillsDir, "alpha")), /ENOENT/);
});

test("syncGlobalSkills repairs a managed link after the checkout moves", () => {
	const oldRoot = mkdtempSync(join(tmpdir(), "kstack-old-"));
	const newRoot = mkdtempSync(join(tmpdir(), "kstack-new-"));
	const globalSkillsDir = mkdtempSync(join(tmpdir(), "agent-skills-"));
	for (const root of [oldRoot, newRoot]) {
		mkdirSync(join(root, "skills", "alpha"), { recursive: true });
		writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: test\n---\n");
	}
	symlinkSync(join(oldRoot, "skills", "alpha"), join(globalSkillsDir, "alpha"));
	writeFileSync(
		join(globalSkillsDir, ".kstack-managed.json"),
		`${JSON.stringify({ alpha: join(oldRoot, "skills", "alpha") }, null, 2)}\n`,
	);

	syncGlobalSkills(newRoot, globalSkillsDir);
	assert.equal(readlinkSync(join(globalSkillsDir, "alpha")), join(newRoot, "skills", "alpha"));
});

test("install preserves the user-owned kstack backend selection", () => {
	const agentDir = tempAgentDir();
	const configPath = join(agentDir, "kstack.json");
	const config = '{"vcs":{"backend":"jj"},"custom":"keep"}\n';
	writeFileSync(configPath, config);

	install({
		repoRoot: "/example/kstack",
		agentDir,
		defaultsDir,
		installPackage() {},
		syncSkills() {},
	});

	assert.equal(readFileSync(configPath, "utf8"), config);
});

test("applyPiDefaults does not modify either file when existing JSON is malformed", () => {
	const agentDir = tempAgentDir();
	const settingsPath = join(agentDir, "settings.json");
	const keybindingsPath = join(agentDir, "keybindings.json");
	writeFileSync(settingsPath, "{ malformed\n");
	writeFileSync(keybindingsPath, '{"app.clear":"ctrl+u"}\n');

	assert.throws(() => applyPiDefaults({ agentDir, defaultsDir }), /Cannot read .*settings\.json/);
	assert.equal(readFileSync(settingsPath, "utf8"), "{ malformed\n");
	assert.equal(readFileSync(keybindingsPath, "utf8"), '{"app.clear":"ctrl+u"}\n');
});
