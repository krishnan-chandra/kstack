function median(values) {
	const middle = Math.floor(values.length / 2);
	if (values.length % 2 === 1) return values[middle];
	return (values[middle - 1] + values[middle]) / 2;
}

export function summarizeSamples(samples) {
	if (samples.length === 0) throw new Error("At least one wall-clock sample is required.");
	const values = samples.map((sample) => sample.wallMs);
	if (values.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new Error("Wall-clock samples must be finite non-negative numbers.");
	}

	const sorted = [...values].sort((left, right) => left - right);
	const medianMs = median(sorted);
	const deviations = values.map((value) => Math.abs(value - medianMs)).sort((left, right) => left - right);
	return {
		count: values.length,
		medianMs,
		p90Ms: sorted[Math.ceil(values.length * 0.9) - 1],
		meanMs: values.reduce((total, value) => total + value, 0) / values.length,
		madMs: median(deviations),
		minMs: sorted[0],
		maxMs: sorted.at(-1),
	};
}

export function assessNoise(summary) {
	const rangeMs = summary.maxMs - summary.minMs;
	const medianMs = summary.medianMs;
	const madRatio = medianMs === 0 ? Number.POSITIVE_INFINITY : summary.madMs / medianMs;
	const rangeRatio = medianMs === 0 ? Number.POSITIVE_INFINITY : rangeMs / medianMs;
	const reasons = [];
	if (madRatio > 0.05) reasons.push("MAD exceeds 5% of the median");
	if (rangeRatio > 0.2) reasons.push("range exceeds 20% of the median");
	return { noisy: reasons.length > 0, reasons, rangeMs, madRatio, rangeRatio };
}

function formatMilliseconds(value) {
	return `${value.toFixed(2)} ms`;
}

function formatSignedMilliseconds(value) {
	return `${value >= 0 ? "+" : ""}${formatMilliseconds(value)}`;
}

function formatMetadataValue(value) {
	if (!value || typeof value.value !== "string") return "unknown";
	return value.error ? `${value.value} (${value.error})` : value.value;
}

function environmentControlsLines(controls) {
	return Object.entries(controls)
		.filter(([name]) => name !== "inheritedPiVariables")
		.map(([name, value]) => `- \`${name}=${value}\``);
}

export function renderMarkdownReport(result) {
	const { environment, workload, scenarios, primaryMetric } = result;
	const noisyScenarios = scenarios.filter((scenario) => scenario.summary.noise.noisy);
	const lines = [
		"# Pi startup benchmark",
		"",
		"## Environment",
		"",
		`- Timestamp: \`${environment.timestamp}\``,
		`- Repository revision: \`${formatMetadataValue(environment.repositoryRevision)}\``,
		`- Platform: \`${environment.platform}\` \`${environment.osRelease}\` \`${environment.architecture}\``,
		`- CPU: \`${environment.cpu.model}\` (${environment.cpu.cores} cores)`,
		`- Node: \`${environment.nodeVersion}\``,
		`- Pi executable: \`${environment.pi.executable}\``,
		`- Pi version: \`${formatMetadataValue(environment.pi.version)}\``,
		`- Package root: \`${environment.packageRoot}\``,
		`- Inherited startup environment: \`${environment.startupEnvironment.algorithm}:${environment.startupEnvironment.fingerprint}\``,
		`- Fingerprinted variables present: ${environment.startupEnvironment.variables.length > 0 ? environment.startupEnvironment.variables.map((name) => `\`${name}\``).join(", ") : "none"}`,
		"",
		"## Workload",
		"",
		"The timer starts immediately before Pi is spawned and stops when the correlated RPC `get_commands` response succeeds.",
		"",
		"```text",
		`${workload.command.executable} ${workload.command.arguments.join(" ")}`,
		"```",
		"",
		`The harness runs ${workload.warmupCount} warmup rounds and ${workload.measuredCount} measured rounds. Each measured round rotates this order: ${workload.schedule.declaredOrder.join(", ")}.`,
		`It validates ${result.inventory.extensionCommands.length} package extension commands and ${result.inventory.skillCommands.length} package skills against each profile's filter.`,
		"",
		"The run removes inherited `PI_*` variables. It uses an isolated `HOME` and `PI_CODING_AGENT_DIR` for each profile, then sets:",
		"",
		...environmentControlsLines(workload.environmentControls),
		"",
		"## Results",
		"",
		"| Profile | Median | p90 | Mean | MAD | Min | Max | Median delta from empty | Noisy |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
		...scenarios.map((scenario) => {
			const summary = scenario.summary;
			const noise = summary.noise.noisy ? `yes (${summary.noise.reasons.join("; ")})` : "no";
			return `| ${scenario.id} | ${formatMilliseconds(summary.medianMs)} | ${formatMilliseconds(summary.p90Ms)} | ${formatMilliseconds(summary.meanMs)} | ${formatMilliseconds(summary.madMs)} | ${formatMilliseconds(summary.minMs)} | ${formatMilliseconds(summary.maxMs)} | ${formatSignedMilliseconds(summary.medianDeltaFromEmptyMs)} | ${noise} |`;
		}),
		"",
		`Primary Kstack metric, full median - empty median: **${formatSignedMilliseconds(primaryMetric.valueMs)}**.`,
		noisyScenarios.length > 0
			? `Noise warning: ${noisyScenarios.map((scenario) => scenario.id).join(", ")} exceeded a noise threshold. The harness records the run but does not fail it.`
			: "Noise warning: no profile exceeded the configured noise thresholds.",
		"",
		"## Limitations",
		"",
		"- This is a warm, offline, isolated, headless readiness benchmark.",
		"- It does not measure MCP, TUI paint, disk-cold startup, network work, or an LLM request.",
		"- Compare reports only when the machine, Pi executable and version, options, workload, and inherited startup-environment fingerprint match.",
		"- Treat a report as noisy when a profile's MAD exceeds 5% of its median or its range exceeds 20% of its median.",
		"- Do not claim a startup win below 10 ms or twice the larger before-and-after MAD.",
		"",
	];
	return lines.join("\n");
}

export function formatSummaryMilliseconds(value) {
	return formatMilliseconds(value);
}

export function formatSummaryDelta(value) {
	return formatSignedMilliseconds(value);
}
