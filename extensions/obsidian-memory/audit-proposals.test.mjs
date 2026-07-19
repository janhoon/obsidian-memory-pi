import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "audit-proposals.ts");

const {
  planAuditProposals,
  formatMemoryOperatorSummary,
  latestMetricTimestamps,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

const sampleSummary = {
  scope: "project",
  project: "demo",
  scannedFiles: 10,
  staleFiles: [
    { path: "memory/projects/demo/overview.md", daysOld: 90 },
    { path: "memory/projects/demo/progress.md", daysOld: 45 },
  ],
  brokenLinks: [{ source: "memory/projects/demo/active-context.md", target: "missing-note" }],
  orphanCandidates: ["memory/projects/demo/old-scratch.md"],
  duplicateTitles: [{ title: "dup", paths: ["memory/a.md", "memory/b.md"] }],
  exactDuplicateBodies: [["memory/x.md", "memory/y.md"]],
  contradictionCandidates: [
    { paths: ["memory/projects/demo/decisions/DEC-001 - A.md", "memory/projects/demo/decisions/DEC-002 - B.md"], reason: "decision status mismatch on similar titles" },
  ],
};

// High-signal defaults include broken_link, stale, contradiction, duplicate_body — not orphan/title by default
{
  const drafts = planAuditProposals(sampleSummary, { maxProposals: 10 });
  assert.ok(drafts.length >= 4);
  assert.ok(drafts.every((d) => d.sourceTag === "audit"));
  assert.ok(drafts.every((d) => d.action === "append_file"));
  assert.ok(drafts.some((d) => d.findingKind === "broken_link"));
  assert.ok(drafts.some((d) => d.findingKind === "stale"));
  assert.ok(drafts.some((d) => d.findingKind === "contradiction"));
  assert.ok(drafts.some((d) => d.findingKind === "duplicate_body"));
  assert.ok(drafts.every((d) => d.rationale.includes("Audit finding")));
  assert.ok(drafts.every((d) => d.content.includes("review before Apply")));
}

// Cap
{
  const drafts = planAuditProposals(sampleSummary, { maxProposals: 2 });
  assert.equal(drafts.length, 2);
}

// Report-only path: max 0 → no drafts
{
  const drafts = planAuditProposals(sampleSummary, { maxProposals: 0 });
  assert.equal(drafts.length, 0);
}

// Operator summary
{
  const text = formatMemoryOperatorSummary({
    ready: true,
    project: "demo",
    configPath: "/tmp/config.json",
    vaultPath: "/tmp/vault",
    corePack: {
      enabled: true,
      loadedCount: 2,
      expectedCount: 3,
      truncated: false,
      injected: true,
      missingPaths: ["memory/projects/demo/MEMORY.md"],
    },
    pendingProposalCount: 3,
    qmd: { enabled: true, dirty: true, dirtyAgeMs: 45000 },
    metrics: {
      lastExtractAt: "2026-04-15T10:00:00.000Z",
      lastAutoRecallAt: "2026-04-15T11:00:00.000Z",
      lastQmdSyncAt: "2026-04-15T09:00:00.000Z",
      lastDreamAt: undefined,
    },
    keyNotes: [
      { path: "memory/working-context.md", present: true },
      { path: "memory/projects/demo/active-context.md", present: true },
      { path: "memory/projects/demo/MEMORY.md", present: false },
    ],
  });
  assert.match(text, /operator summary/i);
  assert.match(text, /Core pack: 2\/3/);
  assert.match(text, /Pending Proposals: 3/);
  assert.match(text, /QMD: stale/);
  assert.match(text, /last extract/);
  assert.match(text, /last dream: n\/a/);
  assert.match(text, /MEMORY\.md: missing/);
}

{
  const latest = latestMetricTimestamps([
    { kind: "proposal_create", at: "2026-01-01T00:00:00.000Z", source: "extract" },
    { kind: "proposal_create", at: "2026-01-02T00:00:00.000Z", source: "extract" },
    { kind: "auto_recall", at: "2026-01-03T00:00:00.000Z" },
    { kind: "qmd_sync", at: "2026-01-04T00:00:00.000Z" },
    { kind: "proposal_create", at: "2026-01-05T00:00:00.000Z", source: "dream" },
  ]);
  assert.equal(latest.lastExtractAt, "2026-01-02T00:00:00.000Z");
  assert.equal(latest.lastAutoRecallAt, "2026-01-03T00:00:00.000Z");
  assert.equal(latest.lastQmdSyncAt, "2026-01-04T00:00:00.000Z");
  assert.equal(latest.lastDreamAt, "2026-01-05T00:00:00.000Z");
}

console.log("audit-proposals.test.mjs: all assertions passed");
