import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "./slugify.js";

test("lowercases and replaces spaces", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});
