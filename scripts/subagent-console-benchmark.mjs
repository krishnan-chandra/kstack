import { performance } from "node:perf_hooks";
import { SubagentConsoleComponent, wrapAndSanitizeText } from "../extensions/shared/subagent-console.ts";
import { fallbackTerminalText } from "../extensions/shared/terminal-text.ts";

const theme = { fg: (_color, text) => text };
const row = { id: "child", label: "child", model: "benchmark-model", status: "running", turns: 1 };
const dashboard = {
	getRows: () => [row],
	nowMs: () => 0,
	subscribe: () => () => {},
};

function transcript(text) {
	let tail;
	const listeners = new Set();
	return {
		getEntries: () => [{ kind: "text", text, turn: 1, at: 0 }],
		getLiveTail: () => tail,
		getTotalCost: () => 0,
		wasEvicted: () => false,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setTail: (value) => {
			tail = value;
			for (const listener of listeners) listener();
		},
	};
}

function median(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function measure(operation, warmups = 2, runs = 7) {
	for (let index = 0; index < warmups; index++) operation();
	const samples = [];
	for (let index = 0; index < runs; index++) {
		const started = performance.now();
		operation();
		samples.push(performance.now() - started);
	}
	return { samplesMs: samples, medianMs: median(samples) };
}

const wrap = {};
for (const kib of [8, 16, 32, 256]) {
	const input = "x".repeat(kib * 1024);
	wrap[`${kib}KiB`] = measure(() => wrapAndSanitizeText(input, 80, fallbackTerminalText));
}

const componentText = "x".repeat(32 * 1024);
const cold = measure(() => {
	const component = new SubagentConsoleComponent(
		dashboard,
		transcript(componentText),
		{ requestRender: () => {}, terminal: { rows: 30 } },
		theme,
		() => {},
	);
	component.render(120);
	component.dispose();
});
const repeatedTranscript = transcript(componentText);
const repeatedComponent = new SubagentConsoleComponent(
	dashboard,
	repeatedTranscript,
	{ requestRender: () => {}, terminal: { rows: 30 } },
	theme,
	() => {},
);
repeatedComponent.render(120);
const repeated = measure(() => repeatedComponent.render(120));
let tailRevision = 0;
const tailUpdate = measure(() => {
	tailRevision++;
	repeatedTranscript.setTail(`live tail ${tailRevision} ${"y".repeat(1024)}`);
	repeatedComponent.render(120);
});
repeatedComponent.dispose();

const result = {
	runtime: process.version,
	fixtures: { wrapWidth: 80, componentWidth: 120, componentTextBytes: componentText.length },
	wrap,
	component: { cold, repeated, oneTailUpdate: tailUpdate },
};
for (const group of [...Object.values(wrap), cold, repeated, tailUpdate]) {
	if (!Number.isFinite(group.medianMs) || group.samplesMs.some((sample) => !Number.isFinite(sample))) {
		throw new Error("benchmark produced a non-finite timing");
	}
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
