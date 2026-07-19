import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "write-policy.ts");

const {
  isSafeDirectWritePath,
  classifyContentClass,
  routeWritePolicy,
  buildWritePolicyGuidance,
  writePolicyMatrix,
  chooseWritePolicyTarget,
  normalizeMemoryPath,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

// --- normalizeMemoryPath ---
assert.equal(normalizeMemoryPath("/memory/log.md"), "memory/log.md");
assert.equal(normalizeMemoryPath("memory//log.md"), "memory/log.md");

// --- isSafeDirectWritePath ---
assert.equal(isSafeDirectWritePath("memory/log.md"), true);
assert.equal(isSafeDirectWritePath("memory/working-context.md"), true);
assert.equal(isSafeDirectWritePath("memory/projects/dotfiles/active-context.md", "dotfiles"), true);
assert.equal(isSafeDirectWritePath("memory/projects/dotfiles/progress.md", "dotfiles"), true);
assert.equal(isSafeDirectWritePath("memory/sessions/dotfiles/2026-04-15.md", "dotfiles"), true);

assert.equal(isSafeDirectWritePath("memory/glossary.md"), false, "glossary is not safe direct");
assert.equal(isSafeDirectWritePath("memory/projects/dotfiles/system-patterns.md", "dotfiles"), false);
assert.equal(isSafeDirectWritePath("memory/projects/dotfiles/decisions/DEC-001 - Foo.md", "dotfiles"), false);
assert.equal(isSafeDirectWritePath("sources/media/x.md"), false);
assert.equal(isSafeDirectWritePath("README.md"), false);

// --- classifyContentClass ---
assert.equal(classifyContentClass({ path: "memory/log.md" }), "log");
assert.equal(classifyContentClass({ path: "memory/working-context.md" }), "working_context");
assert.equal(classifyContentClass({ path: "memory/projects/p/active-context.md" }), "active_context");
assert.equal(classifyContentClass({ path: "memory/projects/p/progress.md" }), "progress");
assert.equal(classifyContentClass({ path: "memory/sessions/p/2026-01-01.md" }), "session_chronology");
assert.equal(classifyContentClass({ path: "memory/glossary.md" }), "glossary");
assert.equal(classifyContentClass({ hasSource: true }), "source");
assert.equal(classifyContentClass({ text: "I prefer shorter answers from now on" }), "preference");
assert.equal(classifyContentClass({ text: "Our rule: we always run tests before merge" }), "doctrine");
assert.equal(classifyContentClass({ text: "Alex works at Acme and is the lead" }), "people_fact");
assert.equal(classifyContentClass({ text: "Add alias for vault: also known as knowledge store" }), "glossary");
assert.equal(
  classifyContentClass({ text: "We decided to use QMD because retrieval is sparse", hasCompleteDecision: true }),
  "decision",
);
assert.equal(classifyContentClass({ text: "Finished the core pack wiring and shipped it" }), "progress");

// --- routeWritePolicy: direct Write for safe chronology ---
{
  const route = routeWritePolicy({ path: "memory/log.md", text: "ingested foo" });
  assert.equal(route.action, "write");
  assert.equal(route.tool, "memory_write");
  assert.equal(route.safeDirect, true);
  assert.equal(route.contentClass, "log");
}

{
  const route = routeWritePolicy({
    path: "memory/projects/dotfiles/progress.md",
    project: "dotfiles",
    text: "Completed issue #3",
  });
  assert.equal(route.action, "write");
  assert.equal(route.tool, "memory_write");
  assert.equal(route.safeDirect, true);
}

// --- routeWritePolicy: preferences / doctrine / people / glossary → Proposal ---
for (const input of [
  { text: "I prefer dark mode in the TUI", project: "dotfiles" },
  { text: "Project rule: we never commit secrets", project: "dotfiles" },
  { text: "Sam reports to Jordan on this team", project: "dotfiles" },
  { text: "Glossary: Memory means the product capability", project: "dotfiles" },
]) {
  const route = routeWritePolicy(input);
  assert.equal(route.action, "propose", `expected propose for: ${input.text}`);
  assert.equal(route.tool, "memory_propose_write");
  assert.equal(route.safeDirect, false);
}

// --- routeWritePolicy: complete Decision → decision tool ---
{
  const route = routeWritePolicy({
    text: "Title: Use QMD. Summary: we will use QMD for search. Rationale: because sparse retrieval.",
    hasCompleteDecision: true,
    project: "dotfiles",
  });
  assert.equal(route.action, "decision");
  assert.equal(route.tool, "memory_record_decision");
  assert.equal(route.contentClass, "decision");
}

// Incomplete decision language → propose
{
  const route = routeWritePolicy({
    text: "We decided something about storage but rationale is unclear",
    project: "dotfiles",
  });
  assert.equal(route.action, "propose");
  assert.equal(route.tool, "memory_propose_write");
}

// --- routeWritePolicy: Source → ingest ---
{
  const route = routeWritePolicy({
    hasSource: true,
    text: "ingest https://example.com/doc.pdf",
    project: "dotfiles",
  });
  assert.equal(route.action, "ingest");
  assert.equal(route.tool, "memory_ingest_source");
}

// --- buildWritePolicyGuidance ---
{
  const route = routeWritePolicy({ text: "I prefer concise answers" });
  const guidance = buildWritePolicyGuidance(route);
  assert.match(guidance, /memory_propose_write/);
  assert.doesNotMatch(guidance, /Prefer memory_write for this chronological/);
}

{
  const route = routeWritePolicy({ path: "memory/log.md" });
  const guidance = buildWritePolicyGuidance(route, { targetPath: "memory/log.md" });
  assert.match(guidance, /memory_write/);
  assert.match(guidance, /memory\/log\.md/);
}

{
  const route = routeWritePolicy({ hasCompleteDecision: true, text: "Title X. Summary we will. Rationale because." });
  const guidance = buildWritePolicyGuidance(route);
  assert.match(guidance, /memory_record_decision/);
}

{
  const route = routeWritePolicy({ hasSource: true });
  const guidance = buildWritePolicyGuidance(route);
  assert.match(guidance, /memory_ingest_source/);
}

// --- matrix is exhaustive and stable ---
{
  const matrix = writePolicyMatrix();
  assert.ok(matrix.length >= 12);
  const classes = new Set(matrix.map((row) => row.contentClass));
  for (const required of [
    "session_chronology",
    "progress",
    "log",
    "preference",
    "doctrine",
    "people_fact",
    "glossary",
    "decision",
    "source",
    "uncertain_durable",
  ]) {
    assert.ok(classes.has(required), `matrix missing ${required}`);
  }
  const pref = matrix.find((row) => row.contentClass === "preference");
  assert.equal(pref.defaultAction, "propose");
  const log = matrix.find((row) => row.contentClass === "log");
  assert.equal(log.defaultAction, "write");
  const dec = matrix.find((row) => row.contentClass === "decision");
  assert.equal(dec.defaultAction, "decision");
}

// --- chooseWritePolicyTarget ---
assert.equal(
  chooseWritePolicyTarget({ text: "I prefer shorter replies", project: "dotfiles" }),
  "memory/projects/dotfiles/active-context.md",
);
assert.equal(chooseWritePolicyTarget({ path: "memory/log.md" }), "memory/log.md");
assert.equal(
  chooseWritePolicyTarget({ text: "for future answers default to bullet lists" }),
  "memory/working-context.md",
);

console.log("write-policy.test.mjs: all assertions passed");
