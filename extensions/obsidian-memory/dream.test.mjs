import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "dream.ts");

const {
  extractSessionCandidates,
  classifyDreamCandidate,
  shouldPromoteDreamCandidate,
  planDreamPass,
  dreamLookbackDates,
  sessionNotePath,
  buildActiveContextDreamBody,
  buildMemoryIndexDreamBody,
  withDreamDefaults,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

// --- extractSessionCandidates ---
{
  const content = [
    "# Session notes",
    "",
    "## [10:00] turn",
    "",
    "- User: We finished the core pack and shipped it",
    "- Assistant: Great progress on MEMORY index",
    "- Tools: memory_search",
    "",
    "- I prefer shorter answers from now on",
    "",
  ].join("\n");
  const cands = extractSessionCandidates("memory/sessions/demo/2026-04-15.md", content);
  assert.ok(cands.length >= 2);
  assert.ok(cands.some((c) => /shipped/i.test(c.text)));
}

// --- classifyDreamCandidate ---
assert.equal(classifyDreamCandidate("I prefer dark mode", "demo").action, "propose");
assert.equal(classifyDreamCandidate("I prefer dark mode", "demo").kind, "preference");
assert.equal(classifyDreamCandidate("We decided to use QMD", "demo").action, "propose");
assert.equal(classifyDreamCandidate("We shipped the feature", "demo").action, "write");
assert.equal(classifyDreamCandidate("We shipped the feature", "demo").kind, "progress");
assert.equal(classifyDreamCandidate("Next step is wire Dream", "demo").kind, "active_focus");
assert.equal(classifyDreamCandidate("Project rule: we always run tests", "demo").kind, "doctrine");
assert.equal(classifyDreamCandidate("Project rule: we always run tests", "demo").action, "propose");

// --- budgets ---
{
  const body = buildActiveContextDreamBody(undefined, ["a".repeat(5000)], { maxChars: 500, date: "2026-04-15" });
  assert.ok(body.length <= 500);
  assert.match(body, /truncated for Dream budget|Active context/);
}

{
  const body = buildMemoryIndexDreamBody(undefined, {
    maxChars: 400,
    date: "2026-04-15",
    focusBullets: ["Ship Dream"],
    decisionPointers: ["Use QMD"],
    riskBullets: [],
  });
  assert.match(body, /MEMORY index/);
  assert.match(body, /Ship Dream/);
  assert.ok(body.length <= 400 || body.includes("truncated"));
}

// --- planDreamPass ---
{
  const plan = planDreamPass({
    project: "demo",
    date: "2026-04-15",
    sessionNotes: [
      {
        path: "memory/sessions/demo/2026-04-15.md",
        content: [
          "- User: We shipped core pack",
          "- User: I prefer concise replies from now on",
          "- User: We decided something about storage",
          "- User: Next step is implement Dream",
        ].join("\n"),
      },
    ],
    config: { maxProposals: 5, maxContextChars: 4000 },
  });

  assert.equal(plan.project, "demo");
  assert.ok(plan.directWrites.some((w) => w.path.endsWith("active-context.md") && w.mode === "write_file"));
  assert.ok(plan.directWrites.some((w) => w.path.endsWith("MEMORY.md")));
  assert.ok(plan.directWrites.some((w) => w.path.endsWith("progress.md") && w.mode === "append_file"));
  assert.ok(plan.directWrites.some((w) => w.path === "memory/log.md"));
  assert.ok(plan.proposals.some((p) => p.sourceTag === "dream" && p.kind === "preference"));
  assert.ok(plan.proposals.some((p) => p.kind === "decision"));
  // No delete actions exist on the plan type — only write/propose.
  assert.ok(plan.proposals.every((p) => p.action === "append_file"));
  assert.match(plan.logEntry, /dream \| manual/);
  assert.match(plan.summary, /Dream \(manual\)/);
}

// Empty sessions → minimal plan still logs
{
  const plan = planDreamPass({
    project: "demo",
    sessionNotes: [],
    date: "2026-04-15",
  });
  assert.equal(plan.sessionPaths.length, 0);
  assert.ok(plan.directWrites.some((w) => w.path === "memory/log.md"));
}

assert.equal(sessionNotePath("demo", "2026-04-15"), "memory/sessions/demo/2026-04-15.md");
{
  const dates = dreamLookbackDates(3, new Date("2026-04-15T12:00:00.000Z"));
  assert.equal(dates.length, 3);
  assert.equal(dates[0], "2026-04-15");
}
assert.equal(withDreamDefaults({ lookbackDays: 7 }).lookbackDays, 7);

assert.equal(shouldPromoteDreamCandidate("preference"), true);
assert.equal(shouldPromoteDreamCandidate("other"), false);
assert.equal(shouldPromoteDreamCandidate("progress"), true);

// YAML frontmatter and meta keys are not Dream candidates
{
  const content = [
    "---",
    "type: context",
    "scope: session",
    "project: demo",
    "relevance: low",
    "last_reviewed: 2026-08-16",
    "---",
    "# Session notes",
    "",
    "- User: We shipped the core pack",
    "- Assistant: Great progress on MEMORY index",
  ].join("\n");
  const cands = extractSessionCandidates("memory/sessions/demo/2026-08-16.md", content);
  assert.ok(cands.some((c) => /shipped the core pack/i.test(c.text)));
  assert.ok(!cands.some((c) => /^(type|scope|project|relevance|last_reviewed):/i.test(c.text)));
}

// Residual "other" does not become a Dream Proposal
{
  const plan = planDreamPass({
    project: "demo",
    date: "2026-08-16",
    sessionNotes: [
      {
        path: "memory/sessions/demo/2026-08-16.md",
        content: [
          "---",
          "type: context",
          "scope: session",
          "project: demo",
          "---",
          "- User: hello there today",
        ].join("\n"),
      },
    ],
    config: { maxProposals: 5 },
  });
  assert.equal(plan.proposals.length, 0);
  assert.ok(!plan.proposals.some((p) => p.kind === "other"));
  assert.ok(!plan.directWrites.some((w) => w.path.endsWith("active-context.md")));
  assert.ok(!plan.directWrites.some((w) => w.path.endsWith("MEMORY.md")));
}

console.log("dream.test.mjs: all assertions passed");
