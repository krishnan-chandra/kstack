import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createVcsTestEnv } from "./vcs-test-env.ts";

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;

function runSync(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		code: result.status ?? 1,
		stdout: result.stdout?.trim() ?? "",
		stderr: result.stderr?.trim() || result.error?.message || "",
	};
}

describe("createVcsTestEnv", () => {
	it("fixture config paths stay beneath caller temporary directory", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-paths-"));
		try {
			const env = createVcsTestEnv(root);
			assert.ok(env.GIT_CONFIG_GLOBAL);
			assert.ok(env.JJ_CONFIG);
			assert.equal(dirname(resolve(env.GIT_CONFIG_GLOBAL)), resolve(root));
			assert.equal(dirname(resolve(env.JJ_CONFIG)), resolve(root));
			assert.equal(existsSync(env.GIT_CONFIG_GLOBAL), true);
			assert.equal(existsSync(env.JJ_CONFIG), true);
			assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("unchanged parent environment", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-immutability-"));
		const baseEnv: NodeJS.ProcessEnv = Object.freeze({
			PATH: process.env.PATH,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "commit.gpgsign",
			GIT_CONFIG_VALUE_0: "true",
			GIT_DIR: "/some/git/dir",
			JJ_REPO: "/some/jj/repo",
			CUSTOM_VAR: "preserve-me",
		});
		const processEnvSnapshot = { ...process.env };
		try {
			const env = createVcsTestEnv(root, baseEnv);
			assert.equal(env.CUSTOM_VAR, "preserve-me");
			assert.equal(baseEnv.GIT_CONFIG_COUNT, "1");
			assert.equal(baseEnv.GIT_DIR, "/some/git/dir");
			assert.deepEqual({ ...process.env }, processEnvSnapshot);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retained PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-path-"));
		const customPath = "/custom/bin:/usr/bin";
		try {
			const env = createVcsTestEnv(root, { PATH: customPath });
			assert.equal(env.PATH, customPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("inherited numbered Git overrides", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-numbered-"));
		const baseEnv: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			GIT_CONFIG: "/etc/forbidden-git-config",
			GIT_CONFIG_PARAMETERS: "'commit.gpgsign=true'",
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "commit.gpgsign",
			GIT_CONFIG_VALUE_0: "true",
			GIT_CONFIG_KEY_1: "user.name",
			GIT_CONFIG_VALUE_1: "Hostile",
			GIT_CONFIG_SYSTEM: "/etc/system-gitconfig",
			GIT_DIR: "/repo/.git",
			GIT_WORK_TREE: "/repo",
			GIT_INDEX_FILE: "/repo/.git/index",
			GIT_OBJECT_DIRECTORY: "/repo/.git/objects",
			GIT_ALTERNATE_OBJECT_DIRECTORIES: "/other/.git/objects",
			GIT_COMMON_DIR: "/repo/.git",
			GIT_PREFIX: "sub/",
			GIT_TEMPLATE_DIR: "/template/dir",
			JJ_REPO: "/repo/.jj",
			JJ_WORKSPACE: "/repo",
			JJ_WORKING_COPY: "/repo",
		};
		try {
			const env = createVcsTestEnv(root, baseEnv);
			assert.equal(env.GIT_CONFIG, undefined);
			assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
			assert.equal(env.GIT_CONFIG_COUNT, undefined);
			assert.equal(env.GIT_CONFIG_KEY_0, undefined);
			assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
			assert.equal(env.GIT_CONFIG_KEY_1, undefined);
			assert.equal(env.GIT_CONFIG_VALUE_1, undefined);
			assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
			assert.equal(env.GIT_DIR, undefined);
			assert.equal(env.GIT_WORK_TREE, undefined);
			assert.equal(env.GIT_INDEX_FILE, undefined);
			assert.equal(env.GIT_OBJECT_DIRECTORY, undefined);
			assert.equal(env.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
			assert.equal(env.GIT_COMMON_DIR, undefined);
			assert.equal(env.GIT_PREFIX, undefined);
			assert.equal(env.GIT_TEMPLATE_DIR, undefined);
			assert.equal(env.JJ_REPO, undefined);
			assert.equal(env.JJ_WORKSPACE, undefined);
			assert.equal(env.JJ_WORKING_COPY, undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hostile Git signing", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-hostile-git-"));
		const hostileRoot = mkdtempSync(join(tmpdir(), "vcs-env-hostile-git-cfg-"));
		const repo = join(root, "repo");
		try {
			const hostileConfig = join(hostileRoot, "hostile-gitconfig");
			writeFileSync(
				hostileConfig,
				"[user]\n\tname = Hostile\n\temail = hostile@example.com\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/fake-gpg\n",
				"utf8",
			);

			const hostileEnv: NodeJS.ProcessEnv = {
				...process.env,
				GIT_CONFIG_GLOBAL: hostileConfig,
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "commit.gpgsign",
				GIT_CONFIG_VALUE_0: "true",
			};

			const isolatedEnv = createVcsTestEnv(root, hostileEnv);

			const initRes = runSync(root, "git", ["init", "-q", repo], isolatedEnv);
			assert.equal(initRes.code, 0, initRes.stderr);

			writeFileSync(join(repo, "file.txt"), "content\n", "utf8");
			const addRes = runSync(repo, "git", ["add", "file.txt"], isolatedEnv);
			assert.equal(addRes.code, 0, addRes.stderr);

			const commitRes = runSync(repo, "git", ["commit", "-qm", "unsigned commit"], isolatedEnv);
			assert.equal(commitRes.code, 0, commitRes.stderr);

			const logRes = runSync(repo, "git", ["log", "-1", "--format=%G? %s"], isolatedEnv);
			assert.equal(logRes.code, 0, logRes.stderr);
			assert.equal(logRes.stdout, "N unsigned commit");
		} finally {
			rmSync(hostileRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hostile Git template directory", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-hostile-tpl-"));
		const hostileRoot = mkdtempSync(join(tmpdir(), "vcs-env-hostile-tpl-cfg-"));
		const repo = join(root, "repo");
		try {
			const hostileTemplateDir = join(hostileRoot, "templates");
			const hooksDir = join(hostileTemplateDir, "hooks");
			mkdirSync(hooksDir, { recursive: true });
			const hookPath = join(hooksDir, "pre-commit");
			writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", "utf8");
			chmodSync(hookPath, 0o755);
			writeFileSync(join(hostileTemplateDir, "hostile-marker.txt"), "polluted\n", "utf8");

			const hostileEnv: NodeJS.ProcessEnv = {
				...process.env,
				GIT_TEMPLATE_DIR: hostileTemplateDir,
			};

			const isolatedEnv = createVcsTestEnv(root, hostileEnv);
			assert.equal(isolatedEnv.GIT_TEMPLATE_DIR, undefined);

			const initRes = runSync(root, "git", ["init", "-q", repo], isolatedEnv);
			assert.equal(initRes.code, 0, initRes.stderr);
			assert.equal(existsSync(join(repo, ".git", "hostile-marker.txt")), false);
			assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false);

			writeFileSync(join(repo, "file.txt"), "clean content\n", "utf8");
			const addRes = runSync(repo, "git", ["add", "file.txt"], isolatedEnv);
			assert.equal(addRes.code, 0, addRes.stderr);

			const commitRes = runSync(repo, "git", ["commit", "-qm", "template-free commit"], isolatedEnv);
			assert.equal(commitRes.code, 0, commitRes.stderr);
		} finally {
			rmSync(hostileRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects configuring inside an existing Git repository", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-git-root-"));
		try {
			runSync(root, "git", ["init", "-q"]);
			assert.throws(() => createVcsTestEnv(root), /createVcsTestEnv root cannot be a Git repository/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hostile jj signing", { skip: !hasJj ? "jj is not installed" : false }, () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-hostile-jj-"));
		const hostileRoot = mkdtempSync(join(tmpdir(), "vcs-env-hostile-jj-cfg-"));
		const repo = join(root, "repo");
		try {
			const hostileJjConfig = join(hostileRoot, "hostile-jj.toml");
			writeFileSync(
				hostileJjConfig,
				'[signing]\nbackend = "gpg"\nbehavior = "force"\n[signing.backends.gpg]\nprogram = "/nonexistent/fake-gpg"\n',
				"utf8",
			);

			const hostileEnv: NodeJS.ProcessEnv = {
				...process.env,
				JJ_CONFIG: hostileJjConfig,
			};

			const isolatedEnv = createVcsTestEnv(root, hostileEnv);

			const gitInit = runSync(root, "git", ["init", "-q", repo], isolatedEnv);
			assert.equal(gitInit.code, 0, gitInit.stderr);

			const jjInit = runSync(repo, "jj", ["git", "init", "--colocate"], isolatedEnv);
			assert.equal(jjInit.code, 0, jjInit.stderr);

			writeFileSync(join(repo, "hello.txt"), "jj content\n", "utf8");
			const jjDesc = runSync(repo, "jj", ["describe", "-m", "initial jj commit"], isolatedEnv);
			assert.equal(jjDesc.code, 0, jjDesc.stderr);
		} finally {
			rmSync(hostileRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fixture directory cleanup", () => {
		const root = mkdtempSync(join(tmpdir(), "vcs-env-cleanup-"));
		createVcsTestEnv(root);
		assert.equal(existsSync(join(root, ".gitconfig")), true);
		assert.equal(existsSync(join(root, ".jjconfig.toml")), true);
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	});
});
