import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "metrics.ts");

const {
  createProposalCreateEvent,
  createProposalApplyEvent,
  createProposalDiscardEvent,
  createAutoRecallEvent,
  createQmdSyncEvent,
  summarizeMetrics,
  formatMetricsSummary,
  parseMetricsNdjson,
  serializeMetricEvent,
  mapProposalSourceToMetricTag,
  normalizeProposalSource,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

// --- source mapping ---
assert.equal(mapProposalSourceToMetricTag("assistant"), "explicit");
assert.equal(mapProposalSourceToMetricTag("auto"), "fallback");
assert.equal(mapProposalSourceToMetricTag("auto", { via: "auto_fallback" }), "fallback");
assert.equal(mapProposalSourceToMetricTag("assistant", { via: "command" }), "manual");
assert.equal(mapProposalSourceToMetricTag("extract"), "extract");
assert.equal(mapProposalSourceToMetricTag("dream"), "dream");
assert.equal(mapProposalSourceToMetricTag("audit"), "audit");
assert.equal(normalizeProposalSource(""), "unknown");
assert.equal(normalizeProposalSource("  custom-tag  "), "custom-tag");

// --- event factories ---
{
  const created = createProposalCreateEvent({ source: "explicit", proposalId: "abc", project: "p", at: "2026-01-01T00:00:00.000Z" });
  assert.equal(created.kind, "proposal_create");
  assert.equal(created.source, "explicit");
  assert.equal(created.proposalId, "abc");

  const applied = createProposalApplyEvent({ source: "fallback", proposalId: "abc" });
  assert.equal(applied.kind, "proposal_apply");

  const discarded = createProposalDiscardEvent({ source: "extract" });
  assert.equal(discarded.kind, "proposal_discard");
  assert.equal(discarded.source, "extract");
}

// --- rollup by source including unknown future tags ---
{
  const events = [
    createProposalCreateEvent({ source: "explicit", at: "t1" }),
    createProposalCreateEvent({ source: "explicit", at: "t2" }),
    createProposalApplyEvent({ source: "explicit", at: "t3" }),
    createProposalDiscardEvent({ source: "explicit", at: "t4" }),
    createProposalCreateEvent({ source: "fallback", at: "t5" }),
    createProposalDiscardEvent({ source: "fallback", at: "t6" }),
    createProposalCreateEvent({ source: "dream", at: "t7" }),
    createProposalCreateEvent({ source: "brand-new-source", at: "t8" }),
    createAutoRecallEvent({ hit: true, resultCount: 3, at: "t9" }),
    createAutoRecallEvent({ hit: false, resultCount: 0, at: "t10" }),
    createAutoRecallEvent({ hit: false, resultCount: 0, timedOut: true, at: "t11" }),
    createQmdSyncEvent({ dirtyDurationMs: 1000, syncDurationMs: 100, ok: true, at: "t12" }),
    createQmdSyncEvent({ dirtyDurationMs: 3000, syncDurationMs: 200, ok: true, at: "t13" }),
    createQmdSyncEvent({ dirtyDurationMs: 500, syncDurationMs: 50, ok: false, at: "t14" }),
  ];

  const summary = summarizeMetrics(events);
  assert.equal(summary.totalEvents, 14);
  assert.equal(summary.proposals.created, 5);
  assert.equal(summary.proposals.applied, 1);
  assert.equal(summary.proposals.discarded, 2);

  const explicit = summary.proposals.bySource.find((r) => r.source === "explicit");
  assert.ok(explicit);
  assert.equal(explicit.created, 2);
  assert.equal(explicit.applied, 1);
  assert.equal(explicit.discarded, 1);
  assert.equal(explicit.applyRate, 0.5);
  assert.equal(explicit.discardRate, 0.5);

  const dream = summary.proposals.bySource.find((r) => r.source === "dream");
  assert.ok(dream, "future source dream is countable");
  assert.equal(dream.created, 1);

  const brand = summary.proposals.bySource.find((r) => r.source === "brand-new-source");
  assert.ok(brand, "unknown sources remain countable");

  assert.equal(summary.autoRecall.attempts, 3);
  assert.equal(summary.autoRecall.hits, 1);
  assert.equal(summary.autoRecall.misses, 2);
  assert.equal(summary.autoRecall.timeouts, 1);
  assert.ok(Math.abs((summary.autoRecall.hitRate || 0) - 1 / 3) < 1e-9);

  assert.equal(summary.qmdSync.runs, 3);
  assert.equal(summary.qmdSync.failures, 1);
  assert.equal(summary.qmdSync.avgDirtyDurationMs, (1000 + 3000 + 500) / 3);
  assert.equal(summary.qmdSync.maxDirtyDurationMs, 3000);
  assert.equal(summary.qmdSync.avgSyncDurationMs, (100 + 200 + 50) / 3);
}

// --- format ---
{
  const summary = summarizeMetrics([
    createProposalCreateEvent({ source: "explicit" }),
    createProposalApplyEvent({ source: "explicit" }),
    createAutoRecallEvent({ hit: true, resultCount: 1 }),
    createQmdSyncEvent({ dirtyDurationMs: 1200, syncDurationMs: 80, ok: true }),
  ]);
  const text = formatMetricsSummary(summary);
  assert.match(text, /local only/i);
  assert.match(text, /explicit/);
  assert.match(text, /Auto-recall/);
  assert.match(text, /QMD sync/);
  assert.doesNotMatch(text, /https?:\/\//);
}

// --- ndjson round-trip ---
{
  const events = [
    createProposalCreateEvent({ source: "audit", proposalId: "x", at: "2026-01-01T00:00:00.000Z" }),
    createAutoRecallEvent({ hit: false, resultCount: 0, at: "2026-01-01T00:00:01.000Z" }),
  ];
  const raw = events.map(serializeMetricEvent).join("\n") + "\nnot-json\n";
  const parsed = parseMetricsNdjson(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, "proposal_create");
  assert.equal(parsed[0].source, "audit");
  assert.equal(parsed[1].kind, "auto_recall");
}

console.log("metrics.test.mjs: all assertions passed");
