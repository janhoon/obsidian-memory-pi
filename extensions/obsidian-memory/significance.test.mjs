import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "significance.ts");

const {
  detectSignificanceSignals,
  isHighSignificance,
  isExtractNoise,
  planExtractProposals,
  shouldRunExtractCapture,
  shouldDisableExtractFromMetrics,
  withSignificanceDefaults,
  DEFAULT_SIGNIFICANCE_CONFIG,
  targetPathForSignificanceKind,
  synthesizeExtractClaim,
  extractFingerprint,
  isDuplicateExtractProposal,
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

// --- user-only cues: assistant vocabulary does not extract ---
{
  const hits = detectSignificanceSignals({
    userText: "happy with all the recommendations here",
    assistantText: "Locked: default to Apply/Discard. The trade-off is overlay vs widget. We merged the PR.",
  });
  assert.equal(hits.length, 0, "assistant-only cues must not extract");
}

{
  const hits = detectSignificanceSignals({
    userText: "I prefer short claims from now on.",
    assistantText: "We decided to default to transcripts instead of claims.",
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "preference");
}

// --- noise skip: skill XML, child notices, review wrappers ---
assert.equal(isExtractNoise('<skill name="grill-with-docs" location="/tmp/x"> default to Apply'), true);
assert.equal(isExtractNoise("Child sa_abc123_def (thermo-nuclear-reviewer) reported a completion. We shipped it."), true);
assert.equal(isExtractNoise("# review Inbox unread attach\nI prefer never use dual lists"), true);
assert.equal(isExtractNoise("We decided to use QMD."), false);

{
  const hits = detectSignificanceSignals({
    userText: '<skill name="grill-with-docs"> default to Apply / Discard',
    assistantText: "The glossary already names this Apply / Discard.",
  });
  assert.equal(hits.length, 0);
}

{
  const hits = detectSignificanceSignals({
    userText: "Child sa_mswb9lo3_243cf356 (thermo-nuclear-reviewer) reported a completion. We shipped HostIdentity.",
  });
  assert.equal(hits.length, 0);
}

// --- extract is a claim, not a transcript dump; never core-pack ---
{
  const hits = detectSignificanceSignals({
    userText: "I prefer short notes from now on.",
  });
  const drafts = planExtractProposals({
    hits,
    userText: "I prefer short notes from now on.",
    assistantText: "Acknowledged. Default to bullets.",
    project: "demo",
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].targetPath, "memory/projects/demo/inbox.md");
  assert.match(drafts[0].content, /I prefer short notes from now on/i);
  assert.doesNotMatch(drafts[0].content, /^- User:/m);
  assert.doesNotMatch(drafts[0].content, /^- Assistant:/m);
  assert.doesNotMatch(drafts[0].content, /Default to bullets/);
}

assert.equal(targetPathForSignificanceKind("preference", "demo"), "memory/projects/demo/inbox.md");
assert.equal(targetPathForSignificanceKind("milestone", "demo"), "memory/projects/demo/inbox.md");
assert.equal(targetPathForSignificanceKind("decision"), "memory/working/inbox.md");

{
  const claim = synthesizeExtractClaim({
    kind: "preference",
    cue: "i prefer",
    userText: "I prefer short notes from now on. Also ship later.",
  });
  assert.match(claim, /I prefer short notes from now on/i);
  assert.doesNotMatch(claim, /Also ship later/);
}

// --- fingerprint dedupe against recent extracts ---
{
  const hits = detectSignificanceSignals({ userText: "I prefer short notes from now on." });
  const drafts = planExtractProposals({
    hits,
    userText: "I prefer short notes from now on.",
    project: "demo",
  });
  assert.equal(drafts.length, 1);
  const fp = extractFingerprint(drafts[0]);
  assert.ok(fp);
  assert.equal(
    isDuplicateExtractProposal(drafts[0], [{ fingerprint: fp, project: "demo" }], "demo"),
    true,
  );
  assert.equal(
    isDuplicateExtractProposal(drafts[0], [{ fingerprint: fp, project: "other" }], "demo"),
    false,
  );
  const skipped = planExtractProposals({
    hits,
    userText: "I prefer short notes from now on.",
    project: "demo",
    recentFingerprints: [{ fingerprint: fp, project: "demo" }],
  });
  assert.equal(skipped.length, 0);
}

console.log("significance.test.mjs: all assertions passed");
