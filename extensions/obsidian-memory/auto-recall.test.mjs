import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "auto-recall.ts");

const {
  classifyRecallIntent,
  scopesForIntent,
  planAutoRecall,
  buildRecallScopePrefixes,
  rankRecallResults,
  preferPathsForIntent,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

// --- classifyRecallIntent ---
assert.equal(classifyRecallIntent("continue where we left off").intent, "continuity");
assert.equal(classifyRecallIntent("catch up on last session").intent, "continuity");
assert.equal(classifyRecallIntent("what did we decide about QMD").intent, "decision");
assert.equal(classifyRecallIntent("why did we choose markdown").intent, "decision");
assert.equal(classifyRecallIntent("what is my preference for tone").intent, "preference");
assert.equal(classifyRecallIntent("project status please").intent, "status");
assert.equal(classifyRecallIntent("what's next on this project").intent, "status");
assert.equal(classifyRecallIntent("hello world").intent, "none");
assert.equal(classifyRecallIntent("/memory-status").intent, "none");

// --- scopesForIntent (acceptance matrix) ---
assert.deepEqual(scopesForIntent("continuity"), ["session", "project"]);
assert.deepEqual(scopesForIntent("decision"), ["project", "global"]);
assert.deepEqual(scopesForIntent("preference"), ["global", "project"]);
assert.deepEqual(scopesForIntent("status"), ["project"]);
assert.deepEqual(scopesForIntent("general"), ["project"]);

// --- planAutoRecall ---
{
  const plan = planAutoRecall("continue from last session", {
    config: { enabled: true, maxResults: 4, triggerPatterns: ["remember"] },
    project: "demo",
  });
  assert.equal(plan.shouldRecall, true);
  assert.equal(plan.intent, "continuity");
  assert.deepEqual(plan.scopes, ["session", "project"]);
}

{
  const plan = planAutoRecall("what did we decide about storage", {
    config: { enabled: true, maxResults: 4, triggerPatterns: [] },
    project: "demo",
  });
  assert.equal(plan.intent, "decision");
  assert.deepEqual(plan.scopes, ["project", "global"]);
}

{
  const plan = planAutoRecall("I prefer shorter answers — check my preference", {
    config: { enabled: true, maxResults: 4, triggerPatterns: [] },
  });
  assert.equal(plan.intent, "preference");
  assert.deepEqual(plan.scopes, ["global", "project"]);
}

{
  const plan = planAutoRecall("project status", {
    config: { enabled: true, maxResults: 4, triggerPatterns: [] },
    project: "demo",
  });
  assert.equal(plan.intent, "status");
  assert.ok(plan.preferPathSubstrings.some((p) => p.includes("active-context")));
}

// Backward-compatible flat trigger → general / project
{
  const plan = planAutoRecall("please remember the architecture context", {
    config: { enabled: true, maxResults: 4, triggerPatterns: ["remember", "context"] },
  });
  assert.equal(plan.shouldRecall, true);
  assert.equal(plan.intent, "general");
  assert.deepEqual(plan.scopes, ["project"]);
  assert.ok(plan.matchedPattern);
}

// First-turn light Recall without trigger phrase
{
  const plan = planAutoRecall("Ship the next PR.", {
    config: { enabled: true, maxResults: 3, triggerPatterns: ["continue"], firstTurnRecall: true },
    project: "demo",
    isFirstTurn: true,
  });
  assert.equal(plan.shouldRecall, true);
  assert.equal(plan.reason, "firstTurnRecall");
  assert.equal(plan.intent, "status");
}

{
  const plan = planAutoRecall("Ship the next PR.", {
    config: { enabled: true, maxResults: 3, triggerPatterns: ["continue"], firstTurnRecall: true },
    project: "demo",
    isFirstTurn: false,
  });
  assert.equal(plan.shouldRecall, false);
}

{
  const plan = planAutoRecall("anything", {
    config: { enabled: false, maxResults: 4, triggerPatterns: ["continue"], firstTurnRecall: true },
    isFirstTurn: true,
  });
  assert.equal(plan.shouldRecall, false);
}

// --- buildRecallScopePrefixes: precise, no accidental global on project-only ---
{
  const prefixes = buildRecallScopePrefixes(["project"], {
    globalPrefixes: ["memory/working-context.md", "memory/glossary.md"],
    projectTemplate: "memory/projects/{project}/",
    sessionTemplate: "memory/sessions/{project}/",
    project: "demo",
  });
  assert.deepEqual(prefixes, ["memory/projects/demo/"]);
}

{
  const prefixes = buildRecallScopePrefixes(["session", "project"], {
    globalPrefixes: ["memory/working-context.md"],
    projectTemplate: "memory/projects/{project}/",
    sessionTemplate: "memory/sessions/{project}/",
    project: "demo",
  });
  assert.deepEqual(prefixes, ["memory/sessions/demo/", "memory/projects/demo/"]);
}

{
  const prefixes = buildRecallScopePrefixes(["project", "global"], {
    globalPrefixes: ["memory/working-context.md", "memory/glossary.md"],
    projectTemplate: "memory/projects/{project}/",
    sessionTemplate: "memory/sessions/{project}/",
    project: "demo",
  });
  assert.ok(prefixes.includes("memory/projects/demo/"));
  assert.ok(prefixes.includes("memory/working-context.md"));
  assert.ok(prefixes.includes("memory/glossary.md"));
}

// --- rankRecallResults boosts active-context for status ---
{
  const ranked = rankRecallResults(
    [
      { file: "memory/projects/demo/overview.md", score: 0.9 },
      { file: "memory/projects/demo/active-context.md", score: 0.5 },
      { file: "memory/projects/demo/progress.md", score: 0.8 },
    ],
    preferPathsForIntent("status", "demo"),
  );
  assert.equal(ranked[0].file, "memory/projects/demo/active-context.md");
}

console.log("auto-recall.test.mjs: all assertions passed");
