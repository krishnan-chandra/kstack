import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveGitHubRepository } from "../shared/github-repository.ts";
import { acquirePublicationLock, acquireRepositoryPublicationLock } from "../shared/publication-lock.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { execFromRunner } from "./github-gateway.ts";
import { createJjAdapter } from "./jj.ts";
import { planStack } from "./orchestrator.ts";
import { generateDeterministicPrMetadata } from "./pr-metadata.ts";
import { preflightJjStack } from "./preflight.ts";
import { createProcessRunner, type ProcessRunner } from "./process.ts";

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;

test("metadata handles large patches and rejects cancelling changes through real jj", { skip: !hasJj }, async () => {
	const root = mkdtempSync(join(tmpdir(), "jj-metadata-evidence-"));
	const env = createVcsTestEnv(root);
	const processRunner = createProcessRunner();
	const run: ProcessRunner = (argv, options) => processRunner(argv, { ...options, env });
	async function jj(...args: string[]): Promise<void> {
		const result = await run(["jj", ...args], { cwd: root });
		assert.equal(result.kind, "ok", JSON.stringify(result));
	}
	try {
		await jj("git", "init", "--no-colocate", ".");
		writeFileSync(join(root, "large.txt"), "base\n");
		await jj("describe", "-m", "Base");
		await jj("bookmark", "create", "main");
		await jj("new", "main");
		writeFileSync(join(root, "large.txt"), "x".repeat(3 * 1024 * 1024));
		await jj("describe", "-m", "Add large fixture\n\nPreserve full description words.");
		await jj("bookmark", "create", "feature");
		const request = { cwd: root, bookmark: "feature", baseRevset: "main", subject: "Add large fixture" };
		const metadata = await generateDeterministicPrMetadata(run, request);
		assert.match(metadata.body, /Preserve full description words/);
		assert.match(metadata.body, /large.txt/);
		await jj("new", "feature");
		writeFileSync(join(root, "large.txt"), "base\n");
		await jj("describe", "-m", "Revert fixture");
		await jj("bookmark", "move", "feature", "--to", "@");
		await assert.rejects(generateDeterministicPrMetadata(run, request), /empty diff/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const colocated of [true, false]) {
	test(`stack planning in ${colocated ? "colocated" : "non-colocated"} and secondary jj workspaces`, {
		skip: !hasJj,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "jj-stack-workspaces-"));
		const env = createVcsTestEnv(root);
		const primary = join(root, "primary");
		const secondary = join(root, "secondary");
		const processRunner = createProcessRunner();
		const run: ProcessRunner = (argv, options) => processRunner(argv, { ...options, env });
		async function jj(cwd: string, ...args: string[]): Promise<void> {
			const result = await run(["jj", ...args], { cwd, timeoutMs: 8_000 });
			assert.equal(result.kind, "ok", JSON.stringify(result));
		}
		try {
			await jj(root, "git", "init", colocated ? "--colocate" : "--no-colocate", primary);
			writeFileSync(join(primary, "base.txt"), "base\n");
			await jj(primary, "describe", "-m", "Base");
			await jj(primary, "bookmark", "create", "main");
			await jj(primary, "config", "set", "--repo", 'revset-aliases."trunk()"', "main");
			await jj(primary, "git", "remote", "add", "origin", "git@github.com:acme/widgets.git");
			await jj(primary, "new", "main");
			await jj(primary, "workspace", "add", "--name", "secondary", "-r", "main", secondary);
			assert.equal(existsSync(join(secondary, ".git")), false);
			const ambient = await run(["git", "rev-parse", "--show-toplevel"], { cwd: secondary });
			assert.equal(ambient.kind, "nonzero");

			const locksDir = join(root, "locks");
			const acquireLock: typeof acquirePublicationLock = (deps) => acquirePublicationLock({ ...deps, locksDir });
			const firstLock = await acquireRepositoryPublicationLock(execFromRunner(run), primary, {
				backend: colocated ? "git" : "jj",
				acquireLock,
			});
			assert.ok(firstLock.ok, JSON.stringify(firstLock));
			try {
				const secondLock = await acquireRepositoryPublicationLock(execFromRunner(run), secondary, {
					backend: "jj",
					acquireLock,
				});
				assert.equal(secondLock.ok, false);
				if (!secondLock.ok) assert.equal(secondLock.kind, "busy");
			} finally {
				assert.deepEqual(firstLock.lock.release(), { ok: true });
			}

			for (const cwd of [primary, secondary]) {
				const bookmark = cwd === primary ? "kstack/primary" : "kstack/secondary";
				writeFileSync(join(cwd, "feature.txt"), `${bookmark}\n`);
				await jj(cwd, "describe", "-m", "Add feature");
				await jj(cwd, "bookmark", "create", bookmark);
				const exec = execFromRunner(run);
				const preflight = await preflightJjStack(cwd, exec);
				assert.equal(preflight.ok, true, JSON.stringify(preflight));
				if (preflight.ok) assert.equal(preflight.workspaceRoot, realpathSync(cwd));
				assert.deepEqual(await resolveGitHubRepository(exec, cwd, "jj"), {
					ok: true,
					repository: "acme/widgets",
				});
				assert.deepEqual((await createJjAdapter(run).getRemote(cwd, "origin")).github, {
					owner: "acme",
					repo: "widgets",
				});

				const githubCalls: string[][] = [];
				const planningRun: ProcessRunner = async (argv, options) => {
					if (argv[0] !== "gh") return run(argv, options);
					githubCalls.push([...argv]);
					assert.equal(argv[1], "api");
					assert.ok(argv.includes("/repos/acme/widgets") || argv.includes("/repos/acme/widgets/pulls"));
					return { kind: "ok", code: 0, stdout: argv.includes("/repos/acme/widgets") ? "main\n" : "", stderr: "" };
				};
				const planned = await planStack(
					{ cwd, top: bookmark, remote: "origin" },
					{
						run: planningRun,
						ui: {
							hasUI: false,
							confirm: async () => false,
							select: async () => undefined,
							notify: () => {},
							setStatus: () => {},
						},
					},
				);
				assert.equal(planned.status, "ok", JSON.stringify(planned));
				assert.ok(githubCalls.length > 0);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
