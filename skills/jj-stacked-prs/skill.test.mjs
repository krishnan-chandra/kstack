/**
 * Static tests for the jj-stacked-prs skill.
 *
 * Verifies:
 * - The stable skill identity (name: jj-stacked-prs) is present in SKILL.md.
 * - plan / apply contract is documented.
 * - No operational references to the removed npm package (jj-stack / jst).
 * - Python scripts and unit tests are present.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const TESTS_DIR = join(SKILL_DIR, "tests");
const REPO_ROOT = join(SKILL_DIR, "..", "..");

test("SKILL.md exists", () => {
  assert.ok(existsSync(SKILL_MD));
});

test("SKILL.md contains stable skill identity (name: jj-stacked-prs)", () => {
  const content = readFileSync(SKILL_MD, "utf8");
  assert.ok(content.includes("name: jj-stacked-prs"), "Missing skill identity");
});

test("SKILL.md references the bundled publisher (publish_stack.py)", () => {
  const content = readFileSync(SKILL_MD, "utf8");
  assert.ok(content.includes("publish_stack.py"), "Missing publish_stack.py reference");
});

test("SKILL.md references the two-phase plan/apply contract", () => {
  const content = readFileSync(SKILL_MD, "utf8");
  assert.ok(content.includes("plan"), "Missing plan reference");
});

test("stack advancement uses the merged bookmark as its abandon boundary", () => {
  const content = readFileSync(join(SKILL_DIR, "references", "workflows.md"), "utf8");
  assert.ok(content.includes("jj abandon 'trunk()..<merged-bookmark>'"), "Missing safe merged-bookmark revset");
  assert.ok(!content.includes("jj abandon 'trunk()..<next-bookmark>-'"), "Unsafe next-bookmark revset returned");
});

test("No references to removed npm package (jst submit) in non-sources files", () => {
  const files = [
    SKILL_MD,
    join(SKILL_DIR, "references", "workflows.md"),
    join(SKILL_DIR, "references", "safety-and-recovery.md"),
    join(REPO_ROOT, "README.md"),
    join(REPO_ROOT, "extensions", "plan-implement", "README.md"),
    join(REPO_ROOT, "extensions", "plan-implement", "prompts", "planner.md"),
    join(REPO_ROOT, "extensions", "plan-implement", "prompts", "implementer.md"),
    join(REPO_ROOT, "extensions", "plan-implement", "prompts", "publisher.md"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    assert.ok(
      !content.toLowerCase().includes("jst submit"),
      `${file} should not reference "jst submit"`,
    );
  }
});

test("sources.md does not contain npm install instructions", () => {
  const sourcesPath = join(SKILL_DIR, "references", "sources.md");
  if (existsSync(sourcesPath)) {
    const content = readFileSync(sourcesPath, "utf8");
    assert.ok(!content.includes("npm install"), "sources.md should not contain npm install");
  }
});

test("Python scripts exist", () => {
  const scripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".py"));
  assert.ok(scripts.length >= 4, "Expected at least 4 Python scripts");
  assert.ok(scripts.includes("stack_model.py"), "Missing stack_model.py");
  assert.ok(scripts.includes("inspect_stack.py"), "Missing inspect_stack.py");
  assert.ok(scripts.includes("github_stack.py"), "Missing github_stack.py");
  assert.ok(scripts.includes("publish_stack.py"), "Missing publish_stack.py");
});

test("Python test files exist", () => {
  const tests = readdirSync(TESTS_DIR).filter((f) => f.startsWith("test_") && f.endsWith(".py"));
  assert.ok(tests.length >= 3, "Expected at least 3 test files");
  assert.ok(tests.includes("test_stack_model.py"), "Missing test_stack_model.py");
  assert.ok(tests.includes("test_github_stack.py"), "Missing test_github_stack.py");
  assert.ok(tests.includes("test_publish_stack.py"), "Missing test_publish_stack.py");
});