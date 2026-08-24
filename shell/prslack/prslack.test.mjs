import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const FUNCTIONS = join(ROOT, "shell/prslack/prslack.sh");
const INSTALLER = join(ROOT, "shell/prslack/install.sh");

const FAKE_GH = `#!/usr/bin/env node
import { fstatSync, readFileSync } from "node:fs";
const scenario = JSON.parse(readFileSync(process.env.PRSLACK_SCENARIO, "utf8"));
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (scenario.requireCapturedStdout) {
  const stdout = fstatSync(1);
  const finalStdout = fstatSync(3);
  if (stdout.dev === finalStdout.dev && stdout.ino === finalStdout.ino) {
    fail("gh wrote directly to final stdout");
  }
}
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write((scenario.defaultBranch ?? "main") + "\\n");
  process.exit(0);
}
if (args[0] !== "pr") fail("expected gh pr command");
const jq = valueAfter("--jq");
if (jq === undefined) fail("expected gh --jq output");
const includeFiles = (valueAfter("--json") ?? "").split(",").includes("files");
if (includeFiles && !["group_by(.)", "sort_by(-.count, .name)", "tojson"].every((part) => jq.includes(part))) {
  fail("expected directory labels to be computed from structured files");
}
const repoName = (url) => url.split("/").at(-3);
const dirLabel = (pr) => {
  if (!includeFiles || (pr.files ?? []).length === 0) return repoName(pr.url);
  const counts = new Map();
  for (const path of pr.files) {
    const slash = path.indexOf("/");
    const rawDir = slash === -1 ? "root" : path.slice(0, slash);
    const dir = JSON.stringify(rawDir).slice(1, -1);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const dirs = [...counts].sort(([left, leftCount], [right, rightCount]) => {
    if (leftCount !== rightCount) return rightCount - leftCount;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  const shown = dirs.slice(0, 3).map(([dir]) => dir);
  const hidden = dirs.length - shown.length;
  if (hidden > 0) shown.push(\`+\${hidden} \${hidden === 1 ? "other" : "others"}\`);
  return shown.join(",");
};
const formatRecord = (pr) =>
  \`\${pr.number}\\u001f\${pr.base}\\u001f\${pr.url}\\u001f\${pr.additions ?? 0}\\u001f\${pr.deletions ?? 0}\\u001f\${pr.title ?? ""}\\u001f\${dirLabel(pr)}\\n\`;
if (args[1] === "view") {
  const selector = args[2]?.startsWith("-") || args[2] === undefined ? "__current__" : args[2];
  const view = scenario.views?.[selector];
  if (!view) fail(\`no PR for \${selector}\`);
  process.stdout.write(formatRecord(view));
  process.exit(0);
}
if (args[1] === "list") {
  const head = valueAfter("--head");
  if (scenario.listErrors?.includes(head)) fail(\`could not list parents for \${head}\`);
  for (const parent of scenario.parents?.[head] ?? []) {
    process.stdout.write(formatRecord(parent));
  }
  process.exit(0);
}
fail("unsupported gh invocation");
`;

const FAKE_JJ = `#!/bin/sh
if [ -n "\${PRSLACK_JJ_TOP-}" ]; then
  printf '%s\\n' "$PRSLACK_JJ_TOP"
fi
`;

function compactPr(overrides = {}) {
	return {
		number: 42,
		base: "main",
		url: "https://github.com/acme/widgets/pull/42",
		title: "Keep titles compact",
		additions: 19,
		deletions: 4,
		...overrides,
	};
}

async function harness(t, scenario, extraEnv = {}) {
	const dir = await mkdtemp(join(tmpdir(), "prslack-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "gh"), FAKE_GH);
	await writeFile(join(bin, "jj"), FAKE_JJ);
	await chmod(join(bin, "gh"), 0o755);
	await chmod(join(bin, "jj"), 0o755);
	const scenarioPath = join(dir, "scenario.json");
	await writeFile(scenarioPath, JSON.stringify(scenario));
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		PRSLACK_SCENARIO: scenarioPath,
	};
	delete env.PRSLACK_LABEL;
	Object.assign(env, extraEnv);
	return { dir, env };
}

function runFunction(name, args, env, cwd) {
	return spawnSync("/bin/sh", ["-c", `exec 3>&1; . "$1"; shift; ${name} "$@"`, "sh", FUNCTIONS, ...args], {
		encoding: "utf8",
		env,
		cwd,
	});
}

function readRecordQuery(mode, env, cwd) {
	return spawnSync("/bin/sh", ["-c", '. "$1"; _prslack_record_query "$2"', "sh", FUNCTIONS, mode], {
		encoding: "utf8",
		env,
		cwd,
	});
}

test("prslack captures gh output for an explicit PR number", async (t) => {
	const h = await harness(t, {
		requireCapturedStdout: true,
		views: {
			42: compactPr(),
		},
	});
	const result = runFunction("prslack", ["42", "--repo", "acme/widgets"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n");
});

test("prslack accepts a PR URL", async (t) => {
	const url = "https://github.com/acme/widgets/pull/42";
	const h = await harness(t, {
		requireCapturedStdout: true,
		views: {
			[url]: compactPr(),
		},
	});
	const result = runFunction("prslack", [url], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n");
});

test("prslack captures gh output for the current branch's PR", async (t) => {
	const h = await harness(t, {
		requireCapturedStdout: true,
		views: {
			__current__: compactPr({
				number: 55,
				url: "https://github.com/acme/widgets/pull/55",
				title: "Current branch PR",
				additions: 7,
				deletions: 2,
			}),
		},
	});
	const result = runFunction("prslack", [], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Current branch PR](https://github.com/acme/widgets/pull/55) (widgets +7/-2)\n");
});

test("prstack resolves the current branch's PR without a selector", async (t) => {
	const h = await harness(t, {
		views: {
			__current__: compactPr({
				number: 55,
				url: "https://github.com/acme/widgets/pull/55",
				title: "Current branch PR",
				additions: 7,
				deletions: 2,
			}),
		},
	});
	const result = runFunction("prstack", [], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Current branch PR](https://github.com/acme/widgets/pull/55) (widgets +7/-2)\n");
});

test("prslack treats -- after the selector as a no-op terminator", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr(),
		},
	});
	const terminated = runFunction("prslack", ["42", "--"], h.env, h.dir);
	assert.equal(terminated.status, 0, terminated.stderr);
	assert.equal(
		terminated.stdout,
		"[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n",
	);
	const extra = runFunction("prslack", ["--", "42", "43"], h.env, h.dir);
	assert.equal(extra.status, 2);
	assert.match(extra.stderr, /expected one PR selector/);
});

test("prstack prints only the prefix through a PR-number- or branch-selected layer", async (t) => {
	const selected = compactPr({
		number: 102,
		base: "feature-one",
		url: "https://github.com/acme/widgets/pull/102",
		title: "Expose the command",
		additions: 12,
		deletions: 1,
	});
	const h = await harness(t, {
		views: {
			102: selected,
			103: compactPr({
				number: 103,
				base: "feature-two",
				url: "https://github.com/acme/widgets/pull/103",
				title: "Layer above the selection",
				additions: 4,
				deletions: 0,
			}),
			"feature-two": selected,
		},
		parents: {
			"feature-one": [
				compactPr({
					number: 101,
					url: "https://github.com/acme/widgets/pull/101",
					title: "Add the model",
					additions: 30,
					deletions: 2,
				}),
			],
		},
	});
	const expected =
		"[Add the model](https://github.com/acme/widgets/pull/101) (widgets +30/-2)\n" +
		"[Expose the command](https://github.com/acme/widgets/pull/102) (widgets +12/-1)\n";
	const byNumber = runFunction("prstack", ["102", "--repo", "acme/widgets"], h.env, h.dir);
	assert.equal(byNumber.status, 0, byNumber.stderr);
	assert.equal(byNumber.stdout, expected);
	assert.doesNotMatch(byNumber.stdout, /Layer above the selection/);

	const byBranch = runFunction("prstack", ["feature-two", "--repo", "acme/widgets"], h.env, h.dir);
	assert.equal(byBranch.status, 0, byBranch.stderr);
	assert.equal(byBranch.stdout, expected);
	assert.doesNotMatch(byBranch.stdout, /Layer above the selection/);
});

test("prslack captures gh output after resolving a jj bookmark", async (t) => {
	const h = await harness(
		t,
		{
			requireCapturedStdout: true,
			views: {
				"top-bookmark": compactPr({
					number: 77,
					url: "https://github.com/acme/widgets/pull/77",
					title: "Finish the stack",
					additions: 8,
					deletions: 3,
				}),
			},
		},
		{ PRSLACK_JJ_TOP: "top-bookmark" },
	);
	const result = runFunction("prslack", [], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Finish the stack](https://github.com/acme/widgets/pull/77) (widgets +8/-3)\n");
});

test("prstack rejects a chain that cannot reach the default branch", async (t) => {
	const h = await harness(t, {
		views: {
			102: compactPr({
				number: 102,
				base: "feature-one",
				url: "https://github.com/acme/widgets/pull/102",
				title: "Top",
				additions: 2,
				deletions: 1,
			}),
		},
	});
	const result = runFunction("prstack", ["102"], h.env, h.dir);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /no open PR has head branch feature-one.*default branch main/);
});

test("prstack rejects a PR record with an empty base branch", async (t) => {
	const h = await harness(t, {
		views: {
			102: compactPr({
				number: 102,
				base: "",
				url: "https://github.com/acme/widgets/pull/102",
				title: "Top",
				additions: 2,
				deletions: 1,
			}),
		},
	});
	const result = runFunction("prstack", ["102"], h.env, h.dir);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /incomplete PR record/);
});

test("prstack rejects an incomplete ancestor PR record", async (t) => {
	const h = await harness(t, {
		views: {
			102: compactPr({
				number: 102,
				base: "feature-one",
				url: "https://github.com/acme/widgets/pull/102",
				title: "Top",
				additions: 2,
				deletions: 1,
			}),
		},
		parents: {
			"feature-one": [
				compactPr({
					number: 101,
					base: "",
					url: "https://github.com/acme/widgets/pull/101",
					title: "Incomplete base",
					additions: 3,
					deletions: 1,
				}),
			],
		},
	});
	const result = runFunction("prstack", ["102"], h.env, h.dir);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /incomplete PR record/);
});

test("prstack emits no partial stdout when GitHub stack discovery fails", async (t) => {
	const h = await harness(t, {
		views: {
			102: compactPr({
				number: 102,
				base: "feature-one",
				url: "https://github.com/acme/widgets/pull/102",
				title: "Top",
				additions: 2,
				deletions: 1,
			}),
		},
		listErrors: ["feature-one"],
	});
	const result = runFunction("prstack", ["102"], h.env, h.dir);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /could not list parents for feature-one/);
});

test("standalone installer provides prslack and prstack commands", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				title: "Installed command",
				additions: 5,
				deletions: 1,
			}),
		},
	});
	const prefix = join(h.dir, "prefix");
	const install = spawnSync("/bin/sh", [INSTALLER, "--prefix", prefix], {
		encoding: "utf8",
		env: h.env,
		cwd: h.dir,
	});
	assert.equal(install.status, 0, install.stderr);
	assert.equal(await readFile(join(prefix, "lib/prslack/prslack.sh"), "utf8"), await readFile(FUNCTIONS, "utf8"));
	const command = spawnSync(join(prefix, "bin/prslack"), ["42"], {
		encoding: "utf8",
		env: h.env,
		cwd: h.dir,
	});
	assert.equal(command.status, 0, command.stderr);
	assert.match(command.stdout, /^\[Installed command\]/);
	const stack = spawnSync(join(prefix, "bin/prstack"), ["42"], {
		encoding: "utf8",
		env: h.env,
		cwd: h.dir,
	});
	assert.equal(stack.status, 0, stack.stderr);
	assert.match(stack.stdout, /^\[Installed command\]/);
});

test("directory labels stay repo names unless dirs mode is selected", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				files: ["backend/retry.ts", "frontend/retry.ts"],
			}),
		},
	});
	const result = runFunction("prslack", ["42"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n");
});

test("prslack --label dirs uses a single top-level directory", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				files: ["backend/retry.ts", "backend/client.ts"],
			}),
		},
	});
	const result = runFunction("prslack", ["42", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (backend +19/-4)\n");
});

test("prslack --label dirs joins unique directories without spaces", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				files: ["frontend/app.ts", "backend/retry.ts", "backend/client.ts"],
			}),
		},
	});
	const result = runFunction("prslack", ["42", "--label=dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout,
		"[Keep titles compact](https://github.com/acme/widgets/pull/42) (backend,frontend +19/-4)\n",
	);
});

test("prslack --label dirs ranks by file count and caps at three directories", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				files: [
					"zzz/one.ts",
					"zzz/two.ts",
					"zzz/three.ts",
					"aaa/one.ts",
					"mmm/one.ts",
					"infra/one.ts",
					"docs/one.ts",
				],
			}),
		},
	});
	const result = runFunction("prslack", ["42", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout,
		"[Keep titles compact](https://github.com/acme/widgets/pull/42) (zzz,aaa,docs,+2 others +19/-4)\n",
	);
});

test("prslack --label dirs uses singular overflow for one extra directory", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				files: ["a/one.ts", "b/one.ts", "c/one.ts", "d/one.ts"],
			}),
		},
	});
	const result = runFunction("prslack", ["42", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (a,b,c,+1 other +19/-4)\n");
});

test("prslack --label dirs maps root-level files to root", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				files: ["README.md", "LICENSE", "backend/retry.ts"],
			}),
		},
	});
	const result = runFunction("prslack", ["42", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (root,backend +19/-4)\n");
});

test("prslack --label dirs escapes control characters in directory names", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({ files: ["odd\nname/file.ts"] }),
		},
	});
	const result = runFunction("prslack", ["42", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout,
		"[Keep titles compact](https://github.com/acme/widgets/pull/42) (odd\\nname +19/-4)\n",
	);
});

test("prslack --label dirs falls back to the repo name when GitHub returns no files", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({ files: [] }),
		},
	});
	const result = runFunction("prslack", ["42", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n");
});

test("a checked-in .prslack file enables dirs mode from a subdirectory", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr({
				files: ["backend/retry.ts", "frontend/app.ts"],
			}),
		},
	});
	await writeFile(join(h.dir, ".prslack"), "label=dirs\n");
	const nested = join(h.dir, "packages", "api");
	await mkdir(nested, { recursive: true });
	const result = runFunction("prslack", ["42"], h.env, nested);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout,
		"[Keep titles compact](https://github.com/acme/widgets/pull/42) (backend,frontend +19/-4)\n",
	);
});

test("PRSLACK_LABEL overrides a checked-in .prslack file", async (t) => {
	const h = await harness(
		t,
		{
			views: {
				42: compactPr({
					files: ["backend/retry.ts"],
				}),
			},
		},
		{ PRSLACK_LABEL: "repo" },
	);
	await writeFile(join(h.dir, ".prslack"), "label=dirs\n");
	const result = runFunction("prslack", ["42"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n");
});

test("--label overrides PRSLACK_LABEL and .prslack", async (t) => {
	const h = await harness(
		t,
		{
			views: {
				42: compactPr({
					files: ["backend/retry.ts"],
				}),
			},
		},
		{ PRSLACK_LABEL: "repo" },
	);
	await writeFile(join(h.dir, ".prslack"), "label=repo\n");
	const result = runFunction("prslack", ["42", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (backend +19/-4)\n");
});

test("invalid label modes are rejected with their source", async (t) => {
	const h = await harness(t, {
		views: {
			42: compactPr(),
		},
	});
	const fromFlag = runFunction("prslack", ["42", "--label", "packages"], h.env, h.dir);
	assert.equal(fromFlag.status, 1);
	assert.match(fromFlag.stderr, /invalid label mode from --label: packages/);

	const fromEnv = runFunction("prslack", ["42"], { ...h.env, PRSLACK_LABEL: "nope" }, h.dir);
	assert.equal(fromEnv.status, 1);
	assert.match(fromEnv.stderr, /invalid label mode from PRSLACK_LABEL: nope/);

	await writeFile(join(h.dir, ".prslack"), "label=folders\n");
	const fromFile = runFunction("prslack", ["42"], h.env, h.dir);
	assert.equal(fromFile.status, 1);
	assert.match(fromFile.stderr, /invalid label mode from \.prslack: folders/);
});

test("prstack applies directory labels per layer", async (t) => {
	const selected = compactPr({
		number: 102,
		base: "feature-one",
		url: "https://github.com/acme/widgets/pull/102",
		title: "Expose the command",
		additions: 12,
		deletions: 1,
		files: ["frontend/command.ts", "frontend/help.ts"],
	});
	const h = await harness(t, {
		views: {
			102: selected,
		},
		parents: {
			"feature-one": [
				compactPr({
					number: 101,
					url: "https://github.com/acme/widgets/pull/101",
					title: "Add the model",
					additions: 30,
					deletions: 2,
					files: ["backend/model.ts", "infra/schema.sql", "docs/model.md"],
				}),
			],
		},
	});
	const result = runFunction("prstack", ["102", "--label", "dirs"], h.env, h.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout,
		"[Add the model](https://github.com/acme/widgets/pull/101) (backend,docs,infra +30/-2)\n" +
			"[Expose the command](https://github.com/acme/widgets/pull/102) (frontend +12/-1)\n",
	);
});

test("_prslack_record_query computes labels from structured changed paths", async (t) => {
	const h = await harness(t, {});
	const query = readRecordQuery("dirs", h.env, h.dir);
	assert.equal(query.status, 0, query.stderr);
	assert.match(query.stdout, /\.files\[\]\.path/);
	assert.match(query.stdout, /group_by\(\.\)/);
	assert.match(query.stdout, /sort_by\(-\.count, \.name\)/);
	assert.match(query.stdout, /tojson/);
	assert.match(query.stdout, /\$dirs\[0:3\]/);
	assert.doesNotMatch(query.stdout, /\\u001e/);
});
