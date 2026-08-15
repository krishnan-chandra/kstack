import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	codePointWidth,
	type DashboardTheme,
	mountPanelDashboard,
	PanelDashboardComponent,
	PanelDashboardStore,
	renderDashboard,
	sanitizeDisplayText,
} from "./live-dashboard.ts";

const ESC = "\u001b";
const BEL = "\u0007";

/** Identity theme: strips color markup so width assertions measure visible text. */
const theme: DashboardTheme = { fg: (_color, text) => text };

/** Tagged theme: proves no child output leaks terminal control bytes into tagged output. */
const taggedTheme: DashboardTheme = { fg: (color, text) => `<${color}>${text}</>` };

// Matches any C0/C1 control character or ESC left in a rendered line.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control bytes is the point
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

function makeStore(startMs = 1_000_000) {
	let now = startMs;
	const store = new PanelDashboardStore(() => now);
	return { store, advance: (ms: number) => (now += ms) };
}

describe("PanelDashboardStore", () => {
	it("seeds queued reviewers and tracks queued → running → terminal transitions", () => {
		const { store, advance } = makeStore();
		store.addReviewer("a", "A", "prov/ma");
		store.addReviewer("b", "B", "prov/mb");
		store.addReviewer("c", "C", "prov/mc");
		assert.deepEqual(
			store.getRows().map((r) => r.status),
			["queued", "queued", "queued"],
		);
		// maxConcurrency = 2: A and B run, C stays queued.
		store.markRunning("a");
		store.markRunning("b");
		advance(5000);
		store.progress("a", { turns: 2, activity: "read bundle.md" });
		store.complete("a", { status: "completed", turns: 3 });
		// C only starts when a slot frees.
		store.markRunning("c");
		const rows = store.getRows();
		assert.equal(rows[0].status, "completed");
		assert.equal(rows[1].status, "running");
		assert.equal(rows[2].status, "running");
		assert.equal(rows[0].turns, 3);
		assert.ok(store.summary().completed === 1 && store.summary().running === 2);
	});

	it("keeps per-reviewer progress independent", () => {
		const { store } = makeStore();
		store.addReviewer("a", "A", "m1");
		store.addReviewer("b", "B", "m2");
		store.markRunning("a");
		store.markRunning("b");
		store.progress("a", { turns: 4, activity: "grep find", preview: "alpha text" });
		store.progress("b", { turns: 1, activity: "thinking", preview: "beta text" });
		const [a, b] = store.getRows();
		assert.equal(a.turns, 4);
		assert.equal(a.preview, "alpha text");
		assert.equal(b.turns, 1);
		assert.equal(b.preview, "beta text");
	});

	it("records failure error, abort, and per-row elapsed", () => {
		const { store, advance } = makeStore();
		store.addReviewer("a", "A", "m1");
		store.addReviewer("b", "B", "m2");
		store.markRunning("a");
		advance(10_000);
		store.markRunning("b");
		advance(20_000);
		store.complete("a", { status: "failed", error: "idle timeout" });
		store.complete("b", { status: "aborted" });
		const [a, b] = store.getRows();
		assert.equal(a.error, "idle timeout");
		assert.equal(b.status, "aborted");
		// finishedAt freezes elapsed: a ran 30s, b ran 20s.
		advance(60_000);
		store.addLead("lead", "lead", "m3");
		store.markRunning("lead");
		advance(3000);
		const lines = renderDashboard(store, 100, theme).join("\n");
		assert.match(lines, /A — failed \(m1\) · 30s · idle timeout/);
		assert.match(lines, /B — aborted \(m2\) · 20s/);
		assert.match(lines, /lead — running \(m3\) · 3s/);
	});

	it("notifies subscribers on every mutation including tick", () => {
		const { store } = makeStore();
		let n = 0;
		const unsub = store.subscribe(() => n++);
		store.addReviewer("a", "A", "m1");
		store.markRunning("a");
		store.progress("a", { turns: 1 });
		store.complete("a", { status: "completed" });
		store.tick();
		assert.equal(n, 5);
		unsub();
		store.tick();
		assert.equal(n, 5);
	});
});

describe("renderDashboard", () => {
	it("renders every reviewer including queued ones and a header summary", () => {
		const { store } = makeStore();
		for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) {
			store.addReviewer(id, `R${i}`, `model-${i}`);
		}
		store.markRunning("a");
		store.markRunning("b");
		const lines = renderDashboard(store, 100, theme);
		assert.match(lines[0], /Panel review — 0\/5 done · 0s — \^⇧V inspect · \^⇧X abort/);
		const body = lines.slice(1).join("\n");
		for (let i = 0; i < 5; i++) assert.match(body, new RegExp(`R${i} — `));
		assert.match(body, /R0 — running/);
		assert.match(body, /R4 — queued/);
	});

	it("shows the lead model in a distinct synthesis row after reviewers finish", () => {
		const { store } = makeStore();
		store.addReviewer("a", "A", "m1");
		store.markRunning("a");
		store.complete("a", { status: "completed" });
		store.addLead("lead", "lead", "synth-model");
		store.markRunning("lead");
		const lines = renderDashboard(store, 100, theme);
		// Reviewer row stays visible during synthesis.
		assert.ok(lines.some((l) => l.includes("A — completed")));
		const leadLine = lines.find((l) => l.includes("lead — running"));
		assert.ok(leadLine);
		assert.match(leadLine, /\(synth-model\)/);
	});

	it("never emits a line wider than the terminal, wide chars included", () => {
		const { store } = makeStore();
		store.addReviewer("a", "wide-語句-label", "model-with-a-rather-long-identifier/x:y");
		store.markRunning("a");
		store.progress("a", {
			turns: 9,
			activity: "read a/very/long/path/that/keeps/going/src/extensions/panel-review/reviewer-runner.ts",
			preview: `語句テスト ${"lorem ipsum ".repeat(40)}`,
		});
		// Use the renderer's own cell-width function to verify containment.
		for (const width of [100, 42, 30, 24, 12]) {
			for (const line of renderDashboard(store, width, theme)) {
				let w = 0;
				for (const ch of line) w += codePointWidth(ch.codePointAt(0) ?? 0);
				assert.ok(w <= width, `width ${width}: ${JSON.stringify(line)} has width ${w}`);
			}
		}
	});

	it("on narrow terminals keeps label and state while dropping secondary metadata", () => {
		const { store } = makeStore();
		store.addReviewer("a", "alpha", "very/long-model:name");
		store.markRunning("a");
		store.progress("a", { turns: 7, activity: "read x.ts", preview: "some preview text here" });
		const narrow = renderDashboard(store, 30, theme).join("\n");
		assert.match(narrow, /alpha — running/);
		assert.ok(!narrow.includes("very/long-model:name"), "model hidden at narrow width");
		const wide = renderDashboard(store, 100, theme).join("\n");
		assert.match(wide, /alpha — running \(very\/long-model:name\) · 7t · read x\.ts/);
	});
});

describe("sanitizeDisplayText", () => {
	it("strips CSI, OSC, APC sequences and control characters", () => {
		assert.equal(sanitizeDisplayText(`${ESC}[31mred${ESC}[0m`), "red");
		assert.equal(sanitizeDisplayText(`${ESC}]8;;http://evil${BEL}link${ESC}]8;;${BEL}`), "link");
		assert.equal(sanitizeDisplayText(`before ${ESC}_Pmalicious${ESC}\\ after`), "before after");
		assert.equal(sanitizeDisplayText("a\x01b\x07c\x08d\x1fe"), "a b c d e");
	});

	it("collapses newlines and whitespace into one line", () => {
		assert.equal(sanitizeDisplayText("line one\nline two\r\n  line   three\t"), "line one line two line three");
	});

	it("preserves Unicode text", () => {
		assert.equal(sanitizeDisplayText("héllo 語 🤖"), "héllo 語 🤖");
	});
});

describe("dashboard rendering sanitation", () => {
	it("strips terminal control sequences from all displayed untrusted fields", () => {
		const { store } = makeStore();
		store.addReviewer("a", `${ESC}[2Jevil-label`, "m1");
		store.markRunning("a");
		store.progress("a", {
			turns: 1,
			activity: `read ${ESC}[7mhighlight.ts${ESC}[0m`,
			preview: `click ${ESC}]8;;http://x${BEL}here ${ESC}]8;;${BEL} done\nnext line`,
		});
		// Running state: sanitized activity and preview are shown.
		const running = renderDashboard(store, 120, theme).join("\n");
		assert.match(running, /read highlight\.ts/);
		assert.match(running, /click here done next line/);
		store.complete("a", { status: "failed", error: `${ESC}[31mboom${ESC}[0m` });
		for (const line of renderDashboard(store, 120, taggedTheme)) {
			// No raw terminal control bytes survive; only the tagged theme's <...> markup.
			assert.ok(!CONTROL_RE.test(line), `raw control byte in ${JSON.stringify(line)}`);
			assert.ok(!line.includes("]8;;"), `OSC payload leaked in ${JSON.stringify(line)}`);
		}
		const plain = renderDashboard(store, 120, theme).join("\n");
		assert.match(plain, /evil-label — failed/);
		assert.match(plain, /boom/); // error text survives, escape bytes do not
	});

	it("bounds oversized previews to a single line", () => {
		const { store } = makeStore();
		store.addReviewer("a", "A", "m1");
		store.markRunning("a");
		store.progress("a", { turns: 1, preview: "x".repeat(5000) });
		const lines = renderDashboard(store, 80, theme);
		const previewLines = lines.filter((l) => l.startsWith("  ›"));
		assert.equal(previewLines.length, 1);
		assert.ok(previewLines[0].length <= 80);
	});
});

describe("PanelDashboardComponent + mountPanelDashboard", () => {
	it("requests a render on store updates and stops after dispose", () => {
		const { store } = makeStore();
		store.addReviewer("a", "A", "m1");
		let renders = 0;
		const component = new PanelDashboardComponent(store, { requestRender: () => renders++ }, theme);
		store.markRunning("a");
		store.progress("a", { turns: 1 });
		assert.equal(renders, 2);
		assert.ok(component.render(80)[0].includes("Panel review"));
		component.invalidate(); // must not throw
		component.dispose();
		component.dispose(); // idempotent
		store.progress("a", { turns: 2 });
		assert.equal(renders, 2);
	});

	it("mounts a widget, returns an idempotent disposer that clears it", () => {
		const widgets = new Map<string, unknown>();
		const ui = {
			setWidget(key: string, content: unknown) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, content);
			},
		};
		const { store } = makeStore();
		store.addReviewer("a", "A", "m1");
		const dispose = mountPanelDashboard(ui, store);
		assert.ok(widgets.has("panel-review"));
		const factory = widgets.get("panel-review") as (
			tui: { requestRender(): void },
			th: DashboardTheme,
		) => PanelDashboardComponent;
		let renders = 0;
		const component = factory({ requestRender: () => renders++ }, theme);
		assert.ok(component);
		store.markRunning("a");
		assert.equal(renders, 1);
		dispose();
		dispose(); // idempotent
		assert.ok(!widgets.has("panel-review"));
		store.progress("a", { turns: 2 });
		assert.equal(renders, 1, "component unsubscribed after dispose");
	});
});
