import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectSessionToggle } from "./sessions-picker.ts";

describe("selectSessionToggle", () => {
  it("uses one RPC selection and returns a typed action", async () => {
    const row = { kind: "active" as const, id: "id", path: "/s", cwd: "/repo", modified: new Date(), created: new Date(), current: false, label: "Task" };
    const result = await selectSessionToggle({ hasUI: true, mode: "rpc", ui: { select: async () => "[active] Task — /repo", notify() {} } } as never, [row]);
    assert.deepEqual(result, { id: "id", kind: "active", current: false });
  });
});
