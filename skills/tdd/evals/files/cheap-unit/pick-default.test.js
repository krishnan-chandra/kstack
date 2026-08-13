import assert from "node:assert/strict";
import { test } from "node:test";
import { pickDefault } from "./pick-default.js";

test("uses the fallback for null", () => {
  assert.equal(pickDefault(null, "x"), "x");
});

test("uses the fallback for undefined", () => {
  assert.equal(pickDefault(undefined, "x"), "x");
});

test("keeps a present value", () => {
  assert.equal(pickDefault("hello", "x"), "hello");
});
