import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRunRoot, ompRpcArgs, resolveOmpHost, runIsolated } from "./harness.mjs";

export function rpcInput(commands) {
	return `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
}

export function parseFrames(stdout) {
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { type: "unparsed", line };
			}
		});
}

function responseFor(frames, id) {
	return frames.find((frame) => frame.type === "response" && frame.id === id);
}

async function writePackage(root, manifest, entries, skills = {}) {
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "package.json"),
		`${JSON.stringify({ name: "omp-compat-fixture", private: true, ...manifest }, null, 2)}\n`,
	);
	for (const [name, source] of Object.entries(entries)) {
		const path = join(root, name);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, source);
	}
	for (const [name, source] of Object.entries(skills)) {
		const path = join(root, "skills", name, "SKILL.md");
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, source);
	}
}

const commandEntry = (name) => `export default function (pi) {
	pi.registerCommand(${JSON.stringify(name)}, { description: "compat fixture", handler() {} });
}\n`;

const KSTACK_FACTORIES = [
	"graphite-stacked-prs",
	"github-stacked-prs",
	"handoff",
	"jj-stacked-prs",
	"kstack-router",
	"land",
	"panel-review",
	"parallel-agents",
	"plan-implement",
	"pr-autopilot",
	"session-archive",
	"steering-swap",
];

export async function writeFixtureModel(runRoot) {
	await mkdir(join(runRoot, "agent"), { recursive: true });
	await writeFile(
		join(runRoot, "agent", "models.yml"),
		`providers:
  compat:
    baseUrl: http://127.0.0.1:9/v1
    auth: none
    api: openai-completions
    models:
      - id: fixture-model
        name: Compatibility Fixture
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 4096
        maxTokens: 1024
`,
	);
}

export async function runPackageProbe({ ompCheckout, kind }) {
	const host = await resolveOmpHost(ompCheckout);
	const runRoot = await createRunRoot(`package-${kind}`);
	const packageRoot = join(runRoot, "fixture-package");
	const cwd = join(runRoot, "workspace");
	const sessionDir = join(runRoot, "sessions");
	await writeFixtureModel(runRoot);
	let expectedCommands;

	if (kind === "pi-manifest") {
		await writePackage(
			packageRoot,
			{ pi: { extensions: ["./pi.ts"], skills: ["./skills"] } },
			{ "pi.ts": commandEntry("fixture-pi") },
			{
				fixture: "---\nname: fixture\ndescription: Compatibility fixture.\n---\n\n# Fixture\n",
			},
		);
		expectedCommands = ["fixture-pi"];
	} else if (kind === "omp-manifest") {
		await writePackage(packageRoot, { omp: { extensions: ["./omp.ts"] } }, { "omp.ts": commandEntry("fixture-omp") });
		expectedCommands = ["fixture-omp"];
	} else if (kind === "manifest-precedence") {
		await writePackage(
			packageRoot,
			{ omp: { extensions: ["./omp.ts"] }, pi: { extensions: ["./pi.ts"] } },
			{ "omp.ts": commandEntry("fixture-omp"), "pi.ts": commandEntry("fixture-pi") },
		);
		expectedCommands = ["fixture-omp"];
	} else if (kind === "aggregate") {
		await writePackage(
			packageRoot,
			{ omp: { extensions: ["./index.ts"] } },
			{
				"index.ts": `export default async function (pi) {
	pi.registerCommand("fixture-aggregate", { description: "compat fixture", handler() {} });
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "fixture_tool",
		label: "Fixture",
		description: "compat fixture",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, params) { return { content: [{ type: "text", text: params.value }], details: {} }; },
	});
	pi.on("session_start", async () => {});
	pi.registerShortcut("ctrl+shift+k", { description: "compat fixture", handler() {} });
}\n`,
			},
		);
		expectedCommands = ["fixture-aggregate"];
	} else if (kind === "schema") {
		await writePackage(
			packageRoot,
			{ omp: { extensions: ["./index.ts"] } },
			{
				"index.ts": `export default function (pi) {
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "fixture_schema",
		label: "Fixture schema",
		description: "compat fixture",
		parameters: Type.Object({
			requiredEnum: Type.Union([Type.Literal("one"), Type.Literal("two")], { description: "Required enum" }),
			optionalEnum: Type.Optional(Type.Union([Type.Literal("one"), Type.Literal("two")])),
			values: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
			count: Type.Integer({ minimum: 1, maximum: 5 }),
		}),
		async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
	});
}\n`,
			},
		);
		expectedCommands = [];
	} else if (kind === "models") {
		await writePackage(
			packageRoot,
			{ omp: { extensions: ["./index.ts"] } },
			{
				"index.ts": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
	pi.registerCommand("compat-models", {
		description: "model resolver probe",
		handler(_args, ctx) {
			const current = ctx.models.current();
			const explicit = ctx.models.resolve("compat/fixture-model");
			const bare = ctx.models.resolve("fixture-model");
			const role = ctx.models.resolve("@smol");
			const missing = ctx.models.resolve("missing-model");
			writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-results.json"), JSON.stringify({
				list: ctx.models.list().map((model) => ({ provider: model.provider, id: model.id })),
				current: current && { provider: current.provider, id: current.id },
				explicit: explicit && { provider: explicit.provider, id: explicit.id },
				bare: bare && { provider: bare.provider, id: bare.id },
				role: role && { provider: role.provider, id: role.id },
				missing: missing && { provider: missing.provider, id: missing.id },
				sameFamily: Boolean(current && explicit && ctx.models.family(current) === ctx.models.family(explicit)),
			}));
		},
	});
}\n`,
			},
		);
		expectedCommands = ["compat-models"];
	} else if (kind === "legacy-imports") {
		await writePackage(
			packageRoot,
			{ pi: { extensions: ["./index.ts"] } },
			{
				"index.ts": `import { Type } from "@earendil-works/pi-ai";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
export default function (pi) {
	if (!Type || !truncateHead || !Text) throw new Error("legacy symbol missing");
	pi.registerCommand("fixture-legacy-imports", { description: "compat fixture", handler() {} });
}\n`,
			},
		);
		expectedCommands = ["fixture-legacy-imports"];
	} else if (kind === "aggregate-failure") {
		await writePackage(
			packageRoot,
			{ omp: { extensions: ["./index.ts"] } },
			{
				"index.ts": `const factories = [
	function first(pi) { pi.registerCommand("fixture-before-failure", { description: "compat fixture", handler() {} }); },
	function middle() { throw new Error("intentional aggregate failure"); },
	function last(pi) { pi.registerCommand("fixture-after-failure", { description: "compat fixture", handler() {} }); },
];
export default async function (pi) { for (const factory of factories) await factory(pi); }\n`,
			},
		);
		expectedCommands = [];
	} else {
		throw new Error(`Unknown package probe: ${kind}`);
	}

	const rpcCommands = [
		{ id: "commands", type: "get_available_commands" },
		{ id: "state", type: "get_state" },
	];
	if (kind === "models") rpcCommands.push({ id: "model-probe", type: "prompt", message: "/compat-models" });
	const hostArguments = ompRpcArgs({ hostArgs: host.hostArgs, extensionPath: packageRoot, cwd, sessionDir });
	const result = await runIsolated({
		command: host.command,
		args: [...hostArguments, "--smol", "compat/fixture-model"],
		runRoot,
		cwd,
		input: rpcInput(rpcCommands),
		label: kind,
		timeoutMs: 30_000,
	});
	const frames = parseFrames(result.stdout);
	const commandsResponse = responseFor(frames, "commands");
	const stateResponse = responseFor(frames, "state");
	const commandNames = (commandsResponse?.data?.commands ?? []).map((command) => command.name);
	const toolNames = (stateResponse?.data?.dumpTools ?? []).map((tool) => tool.name);
	let modelResults;
	if (kind === "models") {
		try {
			modelResults = JSON.parse(await readFile(join(runRoot, "agent", "model-results.json"), "utf8"));
		} catch {
			modelResults = undefined;
		}
	}
	return { host, runRoot, result, frames, commandNames, toolNames, modelResults, expectedCommands };
}

export async function runRealAggregateProbe({ ompCheckout, kstackCheckout = process.cwd(), splitFactories = false }) {
	const host = await resolveOmpHost(ompCheckout);
	const runRoot = await createRunRoot(splitFactories ? "real-split" : "real-aggregate");
	const packageRoot = join(runRoot, "fixture-package");
	const cwd = join(runRoot, "workspace");
	const sessionDir = join(runRoot, "sessions");
	await writeFixtureModel(runRoot);
	const entries = {};
	const manifestEntries = [];
	const excluded = new Map();
	if (splitFactories) {
		for (const name of KSTACK_FACTORIES) {
			if (name === "session-archive" || name === "steering-swap") {
				excluded.set(
					name,
					name === "session-archive" ? "Pi-specific storage and node:sqlite gate" : "host editor wrapper",
				);
				continue;
			}
			const entry = `${name}.ts`;
			const moduleUrl = pathToFileURL(resolve(kstackCheckout, "extensions", name, "index.ts")).href;
			entries[entry] =
				`import factory from ${JSON.stringify(moduleUrl)};\nexport default async function (pi) { await factory(pi); pi.registerCommand(${JSON.stringify(`compat-loaded-${name}`)}, { description: "probe marker", handler() {} }); }\n`;
			manifestEntries.push(`./${entry}`);
		}
	} else {
		const moduleUrl = pathToFileURL(resolve(kstackCheckout, "kstack.ts")).href;
		entries["index.ts"] = `export { default } from ${JSON.stringify(moduleUrl)};\n`;
		manifestEntries.push("./index.ts");
	}
	await writePackage(packageRoot, { omp: { extensions: manifestEntries } }, entries);
	const result = await runIsolated({
		command: host.command,
		args: ompRpcArgs({ hostArgs: host.hostArgs, extensionPath: packageRoot, cwd, sessionDir }),
		runRoot,
		cwd,
		input: rpcInput([{ id: "commands", type: "get_available_commands" }]),
		label: splitFactories ? "real-split" : "real-aggregate",
		timeoutMs: 60_000,
	});
	const frames = parseFrames(result.stdout);
	const commandsResponse = responseFor(frames, "commands");
	const commandNames = (commandsResponse?.data?.commands ?? []).map((command) => command.name);
	const factories = KSTACK_FACTORIES.map((name) => {
		if (excluded.has(name)) return { name, status: "EXCLUDED", reason: excluded.get(name) };
		const loaded = commandNames.includes(`compat-loaded-${name}`);
		return { name, status: loaded ? "PASS" : "FAIL" };
	});
	return { host, runRoot, result, frames, commandNames, factories };
}
