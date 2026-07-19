import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "decisions.ts");

const {
  parseDecisionId,
  sanitizeDecisionTitle,
  buildDecisionNote,
  markDecisionSuperseded,
  buildDecisionIndexHeader,
  upsertDecisionIndexEntry,
  resolveSupersedesRef,
  nextDecisionIdFromNames,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

assert.equal(parseDecisionId("DEC-1"), "DEC-001");
assert.equal(parseDecisionId("see DEC-12 please"), "DEC-012");
assert.equal(parseDecisionId("memory/projects/p/decisions/DEC-003 - Foo.md"), "DEC-003");
assert.equal(parseDecisionId("no id here"), undefined);
assert.equal(sanitizeDecisionTitle('Bad: "title"'), "Bad title");

{
  const note = buildDecisionNote({
    decisionId: "DEC-002",
    project: "demo",
    title: "Use QMD",
    summary: "We will use QMD.",
    rationale: "Sparse retrieval.",
    status: "adopted",
    date: "2026-04-15",
    supersedes: "DEC-001",
    supersedesTitle: "Use grep",
  });
  assert.match(note, /status: adopted/);
  assert.match(note, /supersedes: DEC-001/);
  assert.match(note, /## Supersedes/);
  assert.match(note, /DEC-001 - Use grep/);
}

{
  const prior = buildDecisionNote({
    decisionId: "DEC-001",
    project: "demo",
    title: "Use grep",
    summary: "Old approach.",
    rationale: "Simple.",
    status: "adopted",
    date: "2026-01-01",
  });
  const updated = markDecisionSuperseded(prior, { newDecisionId: "DEC-002", newTitle: "Use QMD", date: "2026-04-15" });
  assert.ok(updated);
  assert.match(updated, /status: superseded/);
  assert.match(updated, /superseded_by: DEC-002/);
  assert.match(updated, /## Superseded by/);
  assert.match(updated, /DEC-002 - Use QMD/);
  assert.match(updated, /last_reviewed: 2026-04-15/);
}

assert.equal(markDecisionSuperseded("not a decision", { newDecisionId: "DEC-002", newTitle: "X" }), undefined);

{
  let index = buildDecisionIndexHeader("demo", "2026-04-15");
  index = upsertDecisionIndexEntry(index, {
    decisionId: "DEC-001",
    title: "Use grep",
    summary: "Old",
    status: "adopted",
    date: "2026-01-01",
  });
  index = upsertDecisionIndexEntry(index, {
    decisionId: "DEC-002",
    title: "Use QMD",
    summary: "New",
    status: "adopted",
    date: "2026-04-15",
    supersedes: "DEC-001",
  });
  // Mark prior superseded in index
  index = upsertDecisionIndexEntry(index, {
    decisionId: "DEC-001",
    title: "Use grep",
    summary: "Old",
    status: "superseded",
    date: "2026-01-01",
    supersededBy: "DEC-002",
  });

  assert.match(index, /## Active/);
  assert.match(index, /## Superseded/);
  const activeSection = index.split("## Superseded")[0];
  const supersededSection = index.split("## Superseded")[1];
  assert.match(activeSection, /DEC-002/);
  // DEC-001 may appear only as a "supersedes" mention on the new Decision line, not as its own Active entry.
  assert.doesNotMatch(activeSection, /\[\[DEC-001 /);
  assert.match(supersededSection, /\[\[DEC-001 /);
  assert.match(supersededSection, /superseded by DEC-002/);
  assert.match(activeSection, /supersedes DEC-001/);
}

{
  const files = ["index.md", "DEC-001 - Use grep.md", "DEC-002 - Use QMD.md"];
  const ok = resolveSupersedesRef("DEC-001", files);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.decisionId, "DEC-001");
    assert.equal(ok.fileName, "DEC-001 - Use grep.md");
  }

  const missing = resolveSupersedesRef("DEC-099", files);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /No Decision Note found/);

  const bad = resolveSupersedesRef("the old one", files);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /Could not parse Decision id/);
}

assert.equal(nextDecisionIdFromNames(["DEC-001 - A.md", "DEC-003 - B.md", "index.md"]), "DEC-004");
assert.equal(nextDecisionIdFromNames([]), "DEC-001");

console.log("decisions.test.mjs: all assertions passed");
