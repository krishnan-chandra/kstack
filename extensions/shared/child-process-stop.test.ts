import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SpawnedProcess } from "./child-agent-runner.ts";
import {
	createChildProcessStopCoordinator,
	defaultProcessGroupSystem,
	type ProcessGroupSystem,
} from "./child-process-stop.ts";

class MockProcess implements SpawnedProcess {
	killed = false;
	kills: string[] = [];
	stdout = { on: () => {} };
	stderr = { on: () => {} };
	on(): void {}
	kill(signal = "SIGTERM"): boolean {
		this.killed = true;
		this.kills.push(signal);
		return true;
	}
}

class MockProcessGroupSystem implements ProcessGroupSystem {
	signals: Array<{ groupId: number; signal: "SIGTERM" | "SIGKILL" | 0 }> = [];
	handler: (groupId: number, signal: "SIGTERM" | "SIGKILL" | 0) => void = () => {};

	killGroup(groupId: number, signal: "SIGTERM" | "SIGKILL" | 0): void {
		this.signals.push({ groupId, signal });
		this.handler(groupId, signal);
	}
}

describe("child-process-stop", () => {
	it("completes immediately when group is already absent on initial SIGTERM", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		system.handler = () => {
			throw Object.assign(new Error("No such process"), { code: "ESRCH" });
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 50,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, true);
		assert.deepEqual(system.signals, [{ groupId: 42, signal: "SIGTERM" }]);
	});

	it("detects descendant exit during grace period without escalating to SIGKILL", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		let checkCount = 0;
		system.handler = (_pgid, signal) => {
			if (signal === 0) {
				checkCount++;
				if (checkCount >= 2) {
					throw Object.assign(new Error("No such process"), { code: "ESRCH" });
				}
			}
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 100,
			pollIntervalMs: 5,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, true);
		const killSignals = system.signals.filter((s) => s.signal === "SIGKILL");
		assert.equal(killSignals.length, 0, "Should not have escalated to SIGKILL");
		assert.ok(checkCount >= 2, "Should have polled existence");
	});

	it("escalates to SIGKILL when group survives grace period, then completes upon absence", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		let killedWithSigkill = false;
		system.handler = (_pgid, signal) => {
			if (signal === "SIGKILL") {
				killedWithSigkill = true;
			} else if (signal === 0 && killedWithSigkill) {
				throw Object.assign(new Error("No such process"), { code: "ESRCH" });
			}
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 20,
			postEscalationGraceMs: 50,
			pollIntervalMs: 5,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, true);
		assert.ok(killedWithSigkill, "Should have escalated to SIGKILL");
	});

	it("reports actionable failure when group remains active after post-escalation grace", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 10,
			postEscalationGraceMs: 15,
			pollIntervalMs: 5,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.match(outcome.cleanupError, /remained active after SIGKILL/);
			assert.match(outcome.cleanupError, /42/);
		}
	});

	it("reports actionable failure on initial SIGTERM permission error", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		system.handler = () => {
			throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.match(outcome.cleanupError, /Failed signaling process group 42 with SIGTERM/);
			assert.match(outcome.cleanupError, /EPERM|Operation not permitted/);
		}
	});

	it("reports actionable failure on inspection error during grace", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		system.handler = (_pgid, signal) => {
			if (signal === 0) {
				throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
			}
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 50,
			pollIntervalMs: 5,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.match(outcome.cleanupError, /Failed inspecting process group 42/);
			assert.match(outcome.cleanupError, /Permission denied/);
		}
	});

	it("reports actionable failure on escalation signaling error", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		system.handler = (_pgid, signal) => {
			if (signal === "SIGKILL") {
				throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
			}
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 10,
			pollIntervalMs: 5,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.match(outcome.cleanupError, /Failed signaling process group 42 with SIGKILL/);
		}
	});

	it("reports actionable failure on inspection error after SIGKILL", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		let sigkillSeen = false;
		system.handler = (_pgid, signal) => {
			if (signal === "SIGKILL") sigkillSeen = true;
			else if (signal === 0 && sigkillSeen) {
				throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
			}
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 10,
			postEscalationGraceMs: 20,
			pollIntervalMs: 5,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.match(outcome.cleanupError, /Failed inspecting process group 42 after SIGKILL/);
		}
	});

	it("never signals group ID again after absence is observed", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		let callCount = 0;
		system.handler = (_pgid, signal) => {
			callCount++;
			if (signal === 0) {
				throw Object.assign(new Error("No such process"), { code: "ESRCH" });
			}
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			killGraceMs: 30,
			pollIntervalMs: 5,
			system,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, true);
		const recordedCount = callCount;
		// Wait a bit to verify no lingering timer calls system
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(callCount, recordedCount, "Should not make any further calls after absence observed");
	});

	it("repeated stop calls return the same promise and do not duplicate signaling", async () => {
		const child = new MockProcess();
		const system = new MockProcessGroupSystem();
		system.handler = () => {
			throw Object.assign(new Error("No such process"), { code: "ESRCH" });
		};

		const coordinator = createChildProcessStopCoordinator({
			child,
			groupId: 42,
			system,
		});

		const [p1, p2] = [coordinator.stop(), coordinator.stop()];
		assert.equal(p1, p2);
		const outcome = await p1;
		assert.equal(outcome.ok, true);
		assert.equal(system.signals.length, 1);
	});

	it("fallback mode handles direct child close before grace without escalating", async () => {
		const child = new MockProcess();
		const coordinator = createChildProcessStopCoordinator({
			child,
			killGraceMs: 50,
		});

		const stopPromise = coordinator.stop();
		assert.deepEqual(child.kills, ["SIGTERM"]);
		coordinator.notifyClosed();
		const outcome = await stopPromise;
		assert.equal(outcome.ok, true);
		assert.deepEqual(child.kills, ["SIGTERM"]);
	});

	it("fallback mode escalates to SIGKILL if direct child does not close before grace", async () => {
		const child = new MockProcess();
		const coordinator = createChildProcessStopCoordinator({
			child,
			killGraceMs: 15,
		});

		const outcome = await coordinator.stop();
		assert.equal(outcome.ok, true);
		assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
	});

	it("defaultProcessGroupSystem calls process.kill with negative groupId", () => {
		// Validating defaultProcessGroupSystem delegates to process.kill
		// Attempting to check a non-existent group should throw ESRCH
		assert.throws(() => defaultProcessGroupSystem.killGroup(99999999, 0), { code: "ESRCH" });
	});
});
