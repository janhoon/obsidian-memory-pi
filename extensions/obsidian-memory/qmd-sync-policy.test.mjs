import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "qmd-sync-policy.ts");

const {
  shouldIncludeEmbedForDebouncedSync,
  shouldIncludeEmbedForSessionEnd,
  formatQmdIndexWidgetLabel,
  shouldClearDirtyAfterSync,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

assert.equal(shouldIncludeEmbedForDebouncedSync({ mode: "update", embed: "manual" }), false);
assert.equal(shouldIncludeEmbedForDebouncedSync({ mode: "update", embed: "end_of_session" }), false);
assert.equal(shouldIncludeEmbedForDebouncedSync({ mode: "update", embed: "after_update" }), true);
assert.equal(shouldIncludeEmbedForDebouncedSync({ mode: "full", embed: "manual" }), true);

assert.equal(shouldIncludeEmbedForSessionEnd({ mode: "update", embed: "manual" }), false);
assert.equal(shouldIncludeEmbedForSessionEnd({ mode: "update", embed: "end_of_session" }), true);
assert.equal(shouldIncludeEmbedForSessionEnd({ mode: "full", embed: "manual" }), true);

assert.equal(formatQmdIndexWidgetLabel(undefined), undefined);
assert.equal(formatQmdIndexWidgetLabel({ dirty: false, syncing: false }), undefined);
assert.equal(formatQmdIndexWidgetLabel({ dirty: true, syncing: false }), "QMD stale");
assert.equal(formatQmdIndexWidgetLabel({ dirty: true, syncing: true }), "QMD syncing…");
assert.equal(formatQmdIndexWidgetLabel({ dirty: false, syncing: false, lastError: "boom" }), "QMD sync failed");

assert.equal(shouldClearDirtyAfterSync({ dirtyAtBefore: 100, dirtyAtAfter: 100, startedAt: 100 }), true);
assert.equal(shouldClearDirtyAfterSync({ dirtyAtBefore: 100, dirtyAtAfter: undefined, startedAt: 100 }), true);
assert.equal(
  shouldClearDirtyAfterSync({ dirtyAtBefore: 100, dirtyAtAfter: 150, startedAt: 120 }),
  false,
  "newer write during sync must keep dirty",
);
assert.equal(
  shouldClearDirtyAfterSync({ dirtyAtBefore: 100, dirtyAtAfter: 110, startedAt: 120 }),
  true,
  "write timestamp at-or-before start is covered by this sync",
);

console.log("qmd-sync-policy tests: all passed");
