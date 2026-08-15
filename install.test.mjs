import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPiDefaults, install } from "./install.mjs";

const defaultsDir = join(import.meta.dirname, "config", "pi-defaults");

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

test("install registers the package before merging defaults into Pi's updated settings", () => {
	const agentDir = tempAgentDir();
	let installedRoot;

	install({
		repoRoot: "/example/kstack",
		agentDir,
		defaultsDir,
		installPackage(repoRoot) {
			installedRoot = repoRoot;
			writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [repoRoot] }, null, 2)}\n`);
		},
	});

	assert.equal(installedRoot, "/example/kstack");
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
