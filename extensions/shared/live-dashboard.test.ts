import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type DashboardPolicy,
	type DashboardTheme,
	LiveDashboardStore,
	renderDashboard,
	rowElapsedSeconds,
} from "./live-dashboard.ts";

const policy: DashboardPolicy = {
	copy: { title: "■ Test", help: " — inspect" },
	modelColor: () => "dim",
	clearPreviewOnComplete: true,
};

class TestStore extends LiveDashboardStore {
	add(id: string): void {
		this.addRow(id, id.toUpperCase(), `model/${id}`, "test", true);
	}
}

const theme: DashboardTheme = { fg: (_color, text) => text };

describe("LiveDashboardStore", () => {
	it("tracks add, progress, complete, and tick transitions", () => {
		let now = 1000;
		const store = new TestStore(policy, () => now);
		let emissions = 0;
		store.subscribe(() => emissions++);
		store.add("a");
		store.progress("a", { turns: 2, activity: "reading", preview: "draft" });
		assert.equal(store.getRows()[0].status, "running");
		assert.equal(store.getRows()[0].startedAt, 1000);
		now = 4000;
		store.complete("a", { status: "completed", turns: 3 });
		store.tick();
		assert.equal(store.getRows()[0].preview, undefined);
		assert.equal(rowElapsedSeconds(store.getRows()[0], now), 3);
		assert.deepEqual(store.summary(), { total: 1, completed: 1, failed: 0, aborted: 0, running: 0 });
		assert.equal(emissions, 4);
	});

	it("renders configured copy and bounded rows", () => {
		const store = new TestStore(policy, () => 1000);
		store.add("a");
		const lines = renderDashboard(store, 80, theme);
		assert.match(lines[0], /■ Test — 0\/1 done · 0s — inspect/);
		assert.match(lines[1], /A — queued \(model\/a\)/);
	});
});
