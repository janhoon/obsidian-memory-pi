import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "significance.ts");

const {
  detectSignificanceSignals,
  isHighSignificance,
  planExtractProposals,
  shouldRunExtractCapture,
  shouldDisableExtractFromMetrics,
  withSignificanceDefaults,
  DEFAULT_SIGNIFICANCE_CONFIG,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

// --- detectSignificanceSignals ---
{
  const hits = detectSignificanceSignals({
    userText: "We decided to use QMD because sparse retrieval wins.",
    assistantText: "Recorded.",
  });
  assert.ok(hits.some((h) => h.kind === "decision"));
  assert.equal(isHighSignificance(hits), true);
}

{
  const hits = detectSignificanceSignals({
    userText: "I prefer bullet lists from now on.",
  });
  assert.ok(hits.some((h) => h.kind === "preference"));
}

{
  const hits = detectSignificanceSignals({
    userText: "Actually, that's wrong — fix that in memory.",
  });
  assert.ok(hits.some((h) => h.kind === "correction"));
}

{
  const hits = detectSignificanceSignals({
    userText: "We shipped the core pack and merged the PR.",
  });
  assert.ok(hits.some((h) => h.kind === "milestone"));
}

{
  const hits = detectSignificanceSignals({
    userText: "hello how are you",
    assistantText: "fine",
  });
  assert.equal(isHighSignificance(hits), false);
  assert.equal(planExtractProposals({ hits, userText: "hello" }).length, 0);
}

// --- planExtractProposals: capped, Proposal-only, extract source ---
{
  const hits = detectSignificanceSignals({
    userText: "We decided on vault layout. I prefer short notes. We shipped v1.",
  });
  const drafts = planExtractProposals({
    hits,
    userText: "We decided on vault layout. I prefer short notes. We shipped v1.",
    assistantText: "Acknowledged.",
    project: "demo",
    maxProposalsPerTurn: 2,
  });
  assert.ok(drafts.length <= 2);
  assert.ok(drafts.length >= 1);
  for (const draft of drafts) {
    assert.equal(draft.sourceTag, "extract");
    assert.equal(draft.action, "append_file");
    assert.ok(draft.targetPath.startsWith("memory/"));
    assert.match(draft.rationale, /Extract capture/);
    assert.match(draft.rationale, /Proposal \(review-only\)/);
    assert.match(draft.content, /review before Apply/);
  }
}

// Low weight only → no extract
{
  const hits = detectSignificanceSignals({ userText: "done with snacks" }); // "done with" weight 1 only if alone?
  // "done with" is weight 1 milestone — isHighSignificance requires weight >= 2
  assert.equal(isHighSignificance(hits), false);
}

// --- shouldRunExtractCapture ---
assert.equal(shouldRunExtractCapture({ ...DEFAULT_SIGNIFICANCE_CONFIG }), true);
assert.equal(shouldRunExtractCapture({ ...DEFAULT_SIGNIFICANCE_CONFIG, enabled: false }), false);
assert.equal(shouldRunExtractCapture({ ...DEFAULT_SIGNIFICANCE_CONFIG, disabledByDiscardRate: true }), false);
assert.equal(shouldRunExtractCapture(DEFAULT_SIGNIFICANCE_CONFIG, { alreadyPersisted: true }), false);

// --- kill-switch from metrics ---
assert.equal(
  shouldDisableExtractFromMetrics({
    extractCreated: 10,
    extractDiscarded: 8,
    extractApplied: 2,
    minTerminal: 5,
    discardRateThreshold: 0.8,
  }),
  true,
);
assert.equal(
  shouldDisableExtractFromMetrics({
    extractCreated: 3,
    extractDiscarded: 3,
    extractApplied: 0,
    minTerminal: 5,
  }),
  false,
  "not enough terminal outcomes",
);
assert.equal(
  shouldDisableExtractFromMetrics({
    extractCreated: 10,
    extractDiscarded: 2,
    extractApplied: 8,
  }),
  false,
);

assert.equal(withSignificanceDefaults({ maxProposalsPerTurn: 1 }).maxProposalsPerTurn, 1);
assert.equal(withSignificanceDefaults({}).enabled, true);

console.log("significance.test.mjs: all assertions passed");
