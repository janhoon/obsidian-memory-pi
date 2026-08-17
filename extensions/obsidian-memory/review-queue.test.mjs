import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "review-queue.ts");

const {
  getPendingReviewProposals,
  countCurrentProjectPending,
  findReviewProposal,
  planReviewResolve,
  handleTriageKey,
  buildTriageViewModel,
  formatTriageLines,
  formatReviewList,
  formatReviewWidgetCue,
  formatResolveResult,
  resolveProposalTarget,
  TRIAGE_SHORTCUT,
  TRIAGE_PREVIEW_LINES,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

function proposal(partial) {
  return {
    id: "aaaa1111",
    createdAt: "2026-08-16T10:00:00.000Z",
    project: "obsidian-memory-pi",
    source: "auto",
    rationale: "Extract capture",
    action: "append_file",
    path: "memory/projects/obsidian-memory-pi/progress.md",
    title: "extract-milestone",
    content: "line one\nline two\nline three",
    status: "pending",
    ...partial,
  };
}

const olderForeign = proposal({
  id: "5c20015a",
  createdAt: "2026-08-16T18:00:00.000Z",
  project: "meepo",
  path: "memory/projects/meepo/progress.md",
  rationale: "Extract capture: milestone",
});
const newerForeign = proposal({
  id: "f5e0ff78",
  createdAt: "2026-08-16T19:00:00.000Z",
  project: "pi-desktop",
  path: "memory/projects/pi-desktop/active-context.md",
  rationale: "Extract capture: preference",
});
const olderHere = proposal({
  id: "aa000001",
  createdAt: "2026-08-16T18:30:00.000Z",
  project: "obsidian-memory-pi",
  path: "memory/projects/obsidian-memory-pi/progress.md",
});
const newerHere = proposal({
  id: "aa000002",
  createdAt: "2026-08-16T20:00:00.000Z",
  project: "obsidian-memory-pi",
  path: "memory/projects/obsidian-memory-pi/active-context.md",
});
const discardedHere = proposal({
  id: "deadbeef",
  createdAt: "2026-08-16T17:00:00.000Z",
  project: "obsidian-memory-pi",
  status: "discarded",
});
const appliedForeign = proposal({
  id: "cafe0001",
  createdAt: "2026-08-16T16:00:00.000Z",
  project: "meepo",
  status: "applied",
});

const queue = [newerHere, newerForeign, discardedHere, olderForeign, olderHere, appliedForeign];

// --- order: current project oldest first, then rest oldest first ---
{
  const pending = getPendingReviewProposals(queue, "obsidian-memory-pi");
  assert.deepEqual(
    pending.map((item) => item.id),
    ["aa000001", "aa000002", "5c20015a", "f5e0ff78"],
  );
  assert.equal(countCurrentProjectPending(queue, "obsidian-memory-pi"), 2);
}

{
  const pending = getPendingReviewProposals(queue);
  assert.deepEqual(
    pending.map((item) => item.id),
    ["5c20015a", "aa000001", "f5e0ff78", "aa000002"],
  );
}

// --- next / find ---
{
  const next = findReviewProposal(queue, "next");
  assert.equal(next?.id, "5c20015a", "token next without project is global oldest");
  assert.equal(findReviewProposal(queue, "next", "obsidian-memory-pi")?.id, "aa000001");
  assert.equal(findReviewProposal(queue, "aa000002")?.id, "aa000002");
  assert.equal(findReviewProposal(queue, "aa00", "obsidian-memory-pi")?.id, "aa000001", "prefix matches first pending in triage order");
}

// --- resolve plan ---
{
  const next = planReviewResolve(queue, { action: "discard", target: "next" }, "obsidian-memory-pi");
  assert.equal(next.ok, true);
  assert.deepEqual(next.ok ? next.proposals.map((item) => item.id) : [], ["aa000001"]);

  const all = planReviewResolve(queue, { action: "apply", target: "all" }, "obsidian-memory-pi");
  assert.equal(all.ok, true);
  assert.deepEqual(all.ok ? all.proposals.map((item) => item.id) : [], ["aa000001", "aa000002", "5c20015a", "f5e0ff78"]);

  const project = planReviewResolve(queue, { action: "discard", target: "project" }, "obsidian-memory-pi");
  assert.equal(project.ok, true);
  assert.deepEqual(project.ok ? project.proposals.map((item) => item.id) : [], ["aa000001", "aa000002"]);

  const other = planReviewResolve(
    queue,
    { action: "discard", target: "project", project: "meepo" },
    "obsidian-memory-pi",
  );
  assert.equal(other.ok, true);
  assert.deepEqual(other.ok ? other.proposals.map((item) => item.id) : [], ["5c20015a"]);

  const ids = planReviewResolve(
    queue,
    { action: "discard", target: "ids", ids: ["5c20015a", "f5e0ff78"] },
    "obsidian-memory-pi",
  );
  assert.equal(ids.ok, true);
  assert.deepEqual(ids.ok ? ids.proposals.map((item) => item.id) : [], ["5c20015a", "f5e0ff78"]);
}

{
  const emptyIds = planReviewResolve(queue, { action: "discard", target: "ids", ids: [] });
  assert.equal(emptyIds.ok, false);

  const missing = planReviewResolve(queue, { action: "apply", target: "ids", ids: ["nope"] });
  assert.equal(missing.ok, false);

  const already = planReviewResolve(queue, { action: "discard", target: "ids", ids: ["deadbeef"] });
  assert.equal(already.ok, false);

  const noProject = planReviewResolve(queue, { action: "discard", target: "project" });
  assert.equal(noProject.ok, false);

  const emptyProject = planReviewResolve(queue, { action: "discard", target: "project", project: "missing" });
  assert.equal(emptyProject.ok, false);

  const emptyNext = planReviewResolve([], { action: "apply", target: "next" }, "obsidian-memory-pi");
  assert.equal(emptyNext.ok, false);
}

// --- triage keys: a/d/e/esc only ---
assert.equal(handleTriageKey("a"), "apply");
assert.equal(handleTriageKey("d"), "discard");
assert.equal(handleTriageKey("e"), "toggle-expand");
assert.equal(handleTriageKey("escape"), "leave");
assert.equal(handleTriageKey("esc"), "leave");
assert.equal(handleTriageKey("\x1b"), "leave");
assert.equal(handleTriageKey("n"), "ignore");
assert.equal(handleTriageKey("j"), "ignore");
assert.equal(handleTriageKey("enter"), "ignore");
assert.equal(handleTriageKey("A"), "apply");

// --- view model + overlay lines ---
{
  const longContent = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
  const focused = proposal({
    id: "aa000001",
    createdAt: "2026-08-16T18:30:00.000Z",
    content: longContent,
    rationale: "Extract capture: milestone",
  });
  const collapsed = buildTriageViewModel(focused, queue, "obsidian-memory-pi", false);
  assert.equal(collapsed.index, 0);
  assert.equal(collapsed.total, 4);
  assert.equal(collapsed.currentProjectCount, 2);
  assert.equal(collapsed.previewLines.length, TRIAGE_PREVIEW_LINES);
  assert.equal(collapsed.contentLines.length, 14);
  assert.equal(collapsed.expanded, false);

  const lines = formatTriageLines(collapsed);
  assert.match(lines[0], /Review 1 of 4 · 2 this project/);
  assert.match(lines[1], /aa000001 · obsidian-memory-pi · auto · append_file/);
  assert.ok(lines.includes("Rationale:"));
  assert.ok(lines.includes("Preview:"));
  assert.ok(!lines.includes("line 11"));
  assert.match(lines.at(-1), /a Apply  d Discard  e Expand  esc Leave/);

  const expanded = formatTriageLines(buildTriageViewModel(focused, queue, "obsidian-memory-pi", true));
  assert.ok(expanded.includes("Content:"));
  assert.ok(expanded.includes("line 14"));
  assert.match(expanded.at(-1), /e Collapse/);
}

// --- widget cue: identity + key, no body stub ---
{
  const cue = formatReviewWidgetCue({
    pendingCount: 4,
    next: olderHere,
    shortcut: TRIAGE_SHORTCUT,
  });
  assert.equal(cue.nextLine, "next aa000001 · obsidian-memory-pi · memory/projects/obsidian-memory-pi/progress.md");
  assert.equal(cue.hintLine, "ctrl+shift+m");
  assert.equal(formatReviewWidgetCue({ pendingCount: 0 }).nextLine, undefined);
}

// --- list / resolve copy ---
{
  const list = formatReviewList(queue, "obsidian-memory-pi");
  assert.match(list, /aa000001/);
  assert.match(list, /5c20015a/);
  assert.equal(formatReviewList([], "obsidian-memory-pi"), "No pending review proposals.");
  assert.equal(formatResolveResult("discard", [olderForeign, newerForeign]), "Discarded 2 review proposal(s): 5c20015a, f5e0ff78.");
  assert.equal(resolveProposalTarget({ action: "append_log" }), "memory/log.md");
}

console.log("review-queue tests passed");
