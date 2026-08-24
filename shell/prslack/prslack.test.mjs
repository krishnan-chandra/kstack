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
import { readFileSync } from "node:fs";
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
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write((scenario.defaultBranch ?? "main") + "\\n");
  process.exit(0);
}
if (args[0] !== "pr") fail("expected gh pr command");
if (args[1] === "view") {
  const selector = args[2]?.startsWith("-") || args[2] === undefined ? "__current__" : args[2];
  const fields = valueAfter("--json") ?? "";
  if (fields === "title,url,additions,deletions") {
    const rendered = scenario.rendered?.[selector];
    if (rendered === undefined) fail(\`no rendered PR for \${selector}\`);
    process.stdout.write(\`\${rendered}\\n\`);
    process.exit(0);
  }
  const view = scenario.views?.[selector];
  if (!view) fail(\`no PR for \${selector}\`);
  process.stdout.write(\`\${view.number}\\t\${view.base}\\t\${view.url}\\t\${view.additions ?? 0}\\t\${view.deletions ?? 0}\\t\${view.title ?? ""}\\n\`);
  process.exit(0);
}
if (args[1] === "list") {
  const head = valueAfter("--head");
  if (scenario.listErrors?.includes(head)) fail(\`could not list parents for \${head}\`);
  const parents = scenario.parents?.[head] ?? [];
  for (const parent of parents) {
    process.stdout.write(\`\${parent.number}\\t\${parent.base}\\t\${parent.url}\\t\${parent.additions ?? 0}\\t\${parent.deletions ?? 0}\\t\${parent.title ?? ""}\\n\`);
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
	return {
		dir,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			PRSLACK_SCENARIO: scenarioPath,
			...extraEnv,
		},
	};
}

function runFunction(name, args, env) {
	return spawnSync("/bin/sh", ["-c", `. "$1"; shift; ${name} "$@"`, "sh", FUNCTIONS, ...args], {
		encoding: "utf8",
		env,
	});
}

test("prslack formats one PR through gh", async (t) => {
	const h = await harness(t, {
		rendered: {
			"42": "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)",
		},
	});
	const result = runFunction("prslack", ["42", "--repo", "acme/widgets"], h.env);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n");
});

test("prslack and prstack resolve the current branch's PR without a selector", async (t) => {
	const h = await harness(t, {
		views: {
			__current__: {
				number: 55,
				base: "main",
				url: "https://github.com/acme/widgets/pull/55",
				title: "Current branch PR",
				additions: 7,
				deletions: 2,
			},
		},
		rendered: {
			__current__: "[Current branch PR](https://github.com/acme/widgets/pull/55) (widgets +7/-2)",
		},
	});
	const single = runFunction("prslack", [], h.env);
	assert.equal(single.status, 0, single.stderr);
	assert.equal(single.stdout, "[Current branch PR](https://github.com/acme/widgets/pull/55) (widgets +7/-2)\n");
	const stack = runFunction("prstack", [], h.env);
	assert.equal(stack.status, 0, stack.stderr);
	assert.equal(stack.stdout, "[Current branch PR](https://github.com/acme/widgets/pull/55) (widgets +7/-2)\n");
});

test("prslack treats -- after the selector as a no-op terminator", async (t) => {
	const h = await harness(t, {
		rendered: {
			"42": "[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)",
		},
	});
	const terminated = runFunction("prslack", ["42", "--"], h.env);
	assert.equal(terminated.status, 0, terminated.stderr);
	assert.equal(
		terminated.stdout,
		"[Keep titles compact](https://github.com/acme/widgets/pull/42) (widgets +19/-4)\n",
	);
	const extra = runFunction("prslack", ["--", "42", "43"], h.env);
	assert.equal(extra.status, 2);
	assert.match(extra.stderr, /expected one PR selector/);
});

test("prstack follows GitHub PR bases and prints base to top", async (t) => {
	const h = await harness(t, {
		views: {
			"102": {
				number: 102,
				base: "feature-one",
				url: "https://github.com/acme/widgets/pull/102",
				title: "Expose the command",
				additions: 12,
				deletions: 1,
			},
		},
		parents: {
			"feature-one": [
				{
					number: 101,
					base: "main",
					url: "https://github.com/acme/widgets/pull/101",
					title: "Add the model",
					additions: 30,
					deletions: 2,
				},
			],
		},
	});
	const result = runFunction("prstack", ["102", "--repo", "acme/widgets"], h.env);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout,
		"[Add the model](https://github.com/acme/widgets/pull/101) (widgets +30/-2)\n" +
			"[Expose the command](https://github.com/acme/widgets/pull/102) (widgets +12/-1)\n",
	);
});

test("prstack resolves an omitted selector from the nearest jj bookmark", async (t) => {
	const h = await harness(
		t,
		{
			views: {
				"top-bookmark": {
					number: 77,
					base: "main",
					url: "https://github.com/acme/widgets/pull/77",
					title: "Finish the stack",
					additions: 8,
					deletions: 3,
				},
			},
		},
		{ PRSLACK_JJ_TOP: "top-bookmark" },
	);
	const result = runFunction("prstack", [], h.env);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "[Finish the stack](https://github.com/acme/widgets/pull/77) (widgets +8/-3)\n");
});

test("prstack emits no partial stdout when stack discovery fails", async (t) => {
	const h = await harness(t, {
		views: {
			"102": {
				number: 102,
				base: "feature-one",
				url: "https://github.com/acme/widgets/pull/102",
				title: "Top",
				additions: 2,
				deletions: 1,
			},
		},
		listErrors: ["feature-one"],
	});
	const result = runFunction("prstack", ["102"], h.env);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /could not list parents for feature-one/);
});

test("standalone installer provides prslack and prstack commands", async (t) => {
	const h = await harness(t, {
		views: {
			"42": {
				number: 42,
				base: "main",
				url: "https://github.com/acme/widgets/pull/42",
				title: "Installed command",
				additions: 5,
				deletions: 1,
			},
		},
		rendered: {
			"42": "[Installed command](https://github.com/acme/widgets/pull/42) (widgets +5/-1)",
		},
	});
	const prefix = join(h.dir, "prefix");
	const install = spawnSync("/bin/sh", [INSTALLER, "--prefix", prefix], { encoding: "utf8", env: h.env });
	assert.equal(install.status, 0, install.stderr);
	assert.equal(await readFile(join(prefix, "lib/prslack/prslack.sh"), "utf8"), await readFile(FUNCTIONS, "utf8"));
	const command = spawnSync(join(prefix, "bin/prslack"), ["42"], { encoding: "utf8", env: h.env });
	assert.equal(command.status, 0, command.stderr);
	assert.match(command.stdout, /^\[Installed command\]/);
	const stack = spawnSync(join(prefix, "bin/prstack"), ["42"], { encoding: "utf8", env: h.env });
	assert.equal(stack.status, 0, stack.stderr);
	assert.match(stack.stdout, /^\[Installed command\]/);
});
