import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REMOVED_ENV_KEYS = new Set([
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_SYSTEM",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_TEMPLATE_DIR",
	"JJ_REPO",
	"JJ_WORKSPACE",
	"JJ_WORKING_COPY",
]);

const NUMBERED_GIT_CONFIG_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

const GIT_CONFIG_CONTENT = `[user]
	name = Test
	email = test@example.com
[commit]
	gpgsign = false
[tag]
	gpgsign = false
	forceSignAnnotated = false
[init]
	defaultBranch = main
`;

const JJ_CONFIG_CONTENT = `[user]
name = "Test"
email = "test@example.com"

[signing]
backend = "none"
behavior = "drop"
`;

/**
 * Creates an isolated VCS environment for Git and Jujutsu integration tests.
 * Writes disposable Git and jj configuration files beneath `root`, sets
 * environment variables pointing to them, and strips inherited configuration
 * and repository selectors from the returned environment copy.
 *
 * The caller owns `root` and its cleanup. `baseEnv` and `process.env` remain unchanged.
 */
export function createVcsTestEnv(root: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (existsSync(join(root, ".git"))) {
		throw new Error(`createVcsTestEnv root cannot be a Git repository: ${root}`);
	}

	mkdirSync(root, { recursive: true });

	const gitConfigPath = resolve(root, ".gitconfig");
	const jjConfigPath = resolve(root, ".jjconfig.toml");

	writeFileSync(gitConfigPath, GIT_CONFIG_CONTENT, "utf8");
	writeFileSync(jjConfigPath, JJ_CONFIG_CONTENT, "utf8");

	const env: NodeJS.ProcessEnv = { ...baseEnv };

	for (const key of Object.keys(env)) {
		if (REMOVED_ENV_KEYS.has(key) || NUMBERED_GIT_CONFIG_RE.test(key)) {
			delete env[key];
		}
	}

	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = gitConfigPath;
	env.JJ_CONFIG = jjConfigPath;

	return env;
}
