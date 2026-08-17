import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runProbe, STARTUP_ARGUMENTS } from "./probe.mjs";
import { createScenarioProfiles } from "./profiles.mjs";
import { assessNoise, renderMarkdownReport, summarizeSamples } from "./report.mjs";

const REQUIRED_PI_ENVIRONMENT = {
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	PI_TIMING: "1",
};
const STARTUP_ENVIRONMENT_VARIABLES = [
	"PATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"DYLD_LIBRARY_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	"LD_LIBRARY_PATH",
];

function rotateProfiles(profiles, round) {
	const start = round % profiles.length;
	return [...profiles.slice(start), ...profiles.slice(0, start)];
}

function makeSchedule(profiles, count) {
	return Array.from({ length: count }, (_value, round) => ({
		round,
		scenarioIds: rotateProfiles(profiles, round).map((profile) => profile.id),
	}));
}

function createProbeEnvironment(baseEnvironment, { homeDir, agentDir }) {
	const environment = {};
	for (const [name, value] of Object.entries(baseEnvironment)) {
		if (!name.startsWith("PI_") && value !== undefined) environment[name] = value;
	}
	return {
		...environment,
		HOME: homeDir,
		PI_CODING_AGENT_DIR: agentDir,
		...REQUIRED_PI_ENVIRONMENT,
	};
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createIsolatedScenario(profile, baseEnvironment) {
	const root = await mkdtemp(join(tmpdir(), `kstack-startup-benchmark-${profile.id}-`));
	try {
		const homeDir = join(root, "home");
		const agentDir = join(homeDir, ".pi", "agent");
		await mkdir(agentDir, { recursive: true });
		await writeJson(join(agentDir, "settings.json"), {
			packages: profile.packages,
			defaultModel: "startup-benchmark/probe",
		});
		await writeJson(join(agentDir, "models.json"), {
			providers: {
				"startup-benchmark": {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "startup-benchmark-not-a-secret",
					models: [{ id: "probe" }],
				},
			},
		});
		return {
			root,
			env: createProbeEnvironment(baseEnvironment, { homeDir, agentDir }),
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function readCommandMetadata(command, args, { cwd, env }) {
	try {
		const result = spawnSync(command, args, {
			cwd,
			env,
			encoding: "utf8",
			windowsHide: true,
		});
		if (result.error) return { value: "unknown", error: result.error.message };
		if (result.status !== 0) {
			const detail = result.stderr.trim() || `exited with status ${result.status ?? "unknown"}`;
			return { value: "unknown", error: detail };
		}
		const value = result.stdout.trim();
		return value ? { value } : { value: "unknown", error: "command produced no output" };
	} catch (error) {
		return { value: "unknown", error: error instanceof Error ? error.message : String(error) };
	}
}

function startupEnvironmentFingerprint(baseEnvironment) {
	const entries = STARTUP_ENVIRONMENT_VARIABLES.filter((name) => baseEnvironment[name] !== undefined).map(
		(name) => `${name}=${baseEnvironment[name]}`,
	);
	return {
		algorithm: "sha256",
		fingerprint: createHash("sha256").update(entries.join("\0")).digest("hex"),
		variables: entries.map((entry) => entry.slice(0, entry.indexOf("="))),
	};
}

function metadataEnvironment(baseEnvironment) {
	const environment = {};
	for (const [name, value] of Object.entries(baseEnvironment)) {
		if (!name.startsWith("PI_") && value !== undefined) environment[name] = value;
	}
	return { ...environment, ...REQUIRED_PI_ENVIRONMENT };
}

function collectEnvironmentMetadata({ repoRoot, packageRoot, piPath, timestamp, baseEnvironment }) {
	const env = metadataEnvironment(baseEnvironment);
	const cpu = cpus();
	return {
		timestamp,
		repositoryRevision: readCommandMetadata("jj", ["log", "-r", "@", "--no-graph", "-T", 'commit_id ++ "\\n"'], {
			cwd: repoRoot,
			env,
		}),
		platform: process.platform,
		osRelease: release(),
		architecture: process.arch,
		cpu: {
			model: cpu[0]?.model ?? "unknown",
			cores: cpu.length,
		},
		nodeVersion: process.version,
		pi: {
			executable: piPath,
			version: readCommandMetadata(piPath, ["--version"], { cwd: repoRoot, env }),
		},
		packageRoot,
		startupEnvironment: startupEnvironmentFingerprint(baseEnvironment),
	};
}

function sampleRecord({ round, position, probe }) {
	return {
		round,
		position,
		wallMs: probe.wallMs,
		commands: probe.commandNames,
		timings: probe.timings,
	};
}

function scenarioResult(profile, state, emptySummary) {
	const summary = profile.id === "empty" ? emptySummary : summarizeSamples(state.samples);
	const withDelta = {
		...summary,
		medianDeltaFromEmptyMs: summary.medianMs - emptySummary.medianMs,
	};
	return {
		id: profile.id,
		purpose: profile.purpose,
		packages: profile.packages,
		commandInventory: {
			required: profile.requiredCommands,
			forbidden: profile.forbiddenCommands,
		},
		timingRequirements: profile.timingRequirements,
		warmups: state.warmups,
		samples: state.samples,
		summary: {
			...withDelta,
			noise: assessNoise(withDelta),
		},
	};
}

export async function runStartupBenchmark(options) {
	const repoRoot = resolve(options.repoRoot);
	const packageRoot = resolve(options.packageRoot);
	const piPath = resolve(options.piPath);
	const output = resolve(options.output);
	const baseEnvironment = process.env;
	const timestamp = new Date().toISOString();
	const { inventory, profiles } = await createScenarioProfiles(packageRoot);
	const warmupSchedule = makeSchedule(profiles, options.warmups);
	const measuredSchedule = makeSchedule(profiles, options.runs);
	const scenariosById = new Map();
	const temporaryRoots = [];

	try {
		for (const profile of profiles) {
			const isolated = await createIsolatedScenario(profile, baseEnvironment);
			temporaryRoots.push(isolated.root);
			scenariosById.set(profile.id, { profile, isolated, warmups: [], samples: [] });
		}

		for (const [phase, schedule] of [
			["warmup", warmupSchedule],
			["measured", measuredSchedule],
		]) {
			for (const round of schedule) {
				for (let position = 0; position < round.scenarioIds.length; position += 1) {
					const state = scenariosById.get(round.scenarioIds[position]);
					if (!state) throw new Error(`Scheduled unknown scenario: ${round.scenarioIds[position]}`);
					const probe = await runProbe({
						scenario: state.profile,
						piPath,
						cwd: repoRoot,
						env: state.isolated.env,
						timeoutMs: options.timeoutMs,
					});
					const sample = sampleRecord({ round: round.round, position, probe });
					if (phase === "warmup") state.warmups.push(sample);
					else state.samples.push(sample);
				}
			}
		}

		const emptyState = scenariosById.get("empty");
		if (!emptyState) throw new Error("The benchmark requires an empty scenario profile.");
		const emptySummary = summarizeSamples(emptyState.samples);
		const scenarios = profiles.map((profile) => {
			const state = scenariosById.get(profile.id);
			if (!state) throw new Error(`Missing scenario state: ${profile.id}`);
			return scenarioResult(profile, state, emptySummary);
		});
		const full = scenarios.find((scenario) => scenario.id === "full");
		if (!full) throw new Error("The benchmark requires a full scenario profile.");

		const artifacts = { json: `${output}.json`, markdown: `${output}.md` };
		const result = {
			schemaVersion: 1,
			environment: collectEnvironmentMetadata({ repoRoot, packageRoot, piPath, timestamp, baseEnvironment }),
			workload: {
				command: { executable: piPath, arguments: STARTUP_ARGUMENTS },
				environmentControls: {
					inheritedPiVariables: "removed",
					HOME: "isolated temporary home per scenario",
					PI_CODING_AGENT_DIR: "isolated temporary agent directory per scenario",
					...REQUIRED_PI_ENVIRONMENT,
				},
				warmupCount: options.warmups,
				measuredCount: options.runs,
				timeoutMs: options.timeoutMs,
				schedule: {
					declaredOrder: profiles.map((profile) => profile.id),
					warmupRounds: warmupSchedule,
					measuredRounds: measuredSchedule,
				},
			},
			inventory,
			scenarios,
			primaryMetric: {
				name: "full median - empty median",
				valueMs: full.summary.medianMs - emptySummary.medianMs,
			},
			comparisonGuidance:
				"Do not claim a startup win below 10 ms or twice the larger before-and-after MAD. Compare only matching inherited startup-environment fingerprints.",
			artifacts,
		};

		await mkdir(dirname(artifacts.json), { recursive: true });
		await writeJson(artifacts.json, result);
		await writeFile(artifacts.markdown, renderMarkdownReport(result));
		return result;
	} finally {
		for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
	}
}
