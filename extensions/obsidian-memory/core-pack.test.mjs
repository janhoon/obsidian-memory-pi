import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "core-pack.ts");

const {
  resolveCorePackPaths,
  truncateMarkdown,
  assembleCorePack,
  formatCorePackMessage,
  formatCorePackWidgetLabel,
  shouldInjectCorePackOnSessionStart,
  shouldInjectCorePackOnFirstTurn,
  withCoreLoadDefaults,
  DEFAULT_CORE_LOAD_CONFIG,
  corePackCustomType,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

// --- resolveCorePackPaths ---
assert.deepEqual(
  resolveCorePackPaths(
    [
      "memory/working-context.md",
      "memory/projects/{project}/active-context.md",
      "memory/projects/{project}/MEMORY.md",
    ],
    "obsidian-memory-pi",
  ),
  [
    "memory/working-context.md",
    "memory/projects/obsidian-memory-pi/active-context.md",
    "memory/projects/obsidian-memory-pi/MEMORY.md",
  ],
);

assert.deepEqual(
  resolveCorePackPaths(["memory/working-context.md", "memory/working-context.md"], "p"),
  ["memory/working-context.md"],
  "dedupe paths",
);

assert.deepEqual(
  resolveCorePackPaths(["memory/projects/{project}/active-context.md"], "  "),
  ["memory/projects/unknown/active-context.md"],
  "empty project falls back to unknown",
);

// --- truncateMarkdown ---
assert.deepEqual(truncateMarkdown("short", 100), { text: "short", truncated: false });
{
  const long = "a".repeat(50) + "\n" + "b".repeat(50);
  const result = truncateMarkdown(long, 40);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 40, `expected length <= 40, got ${result.text.length}`);
  assert.ok(result.text.includes("truncated"), "marker present");
}
assert.equal(truncateMarkdown("hello", 0).text, "");
assert.equal(truncateMarkdown("hello", 0).truncated, true);

// --- assembleCorePack: missing files skip quietly ---
{
  const pack = assembleCorePack(
    [
      { path: "memory/working-context.md", content: "# Working\n\nFocus: ship core pack.\n" },
      { path: "memory/projects/demo/active-context.md", content: undefined },
      { path: "memory/projects/demo/MEMORY.md", content: undefined },
    ],
    { project: "demo", maxFileChars: 6000, maxTotalChars: 14000 },
  );
  assert.equal(pack.loadedCount, 1);
  assert.deepEqual(pack.missingPaths, [
    "memory/projects/demo/active-context.md",
    "memory/projects/demo/MEMORY.md",
  ]);
  assert.ok(pack.messageContent?.includes("Working"));
  assert.ok(pack.messageContent?.includes("ship core pack"));
  assert.equal(pack.truncated, false);
}

// --- assembleCorePack: empty content does not count as loaded ---
{
  const pack = assembleCorePack([{ path: "memory/working-context.md", content: "   \n" }], {
    project: "demo",
    maxFileChars: 100,
    maxTotalChars: 100,
  });
  assert.equal(pack.loadedCount, 0);
  assert.equal(pack.messageContent, undefined);
  assert.equal(pack.files[0].status, "empty");
}

// --- per-file budget ---
{
  const body = "x".repeat(500);
  const pack = assembleCorePack([{ path: "memory/working-context.md", content: body }], {
    project: "demo",
    maxFileChars: 100,
    maxTotalChars: 10_000,
  });
  assert.equal(pack.files[0].status, "truncated");
  assert.ok(pack.files[0].includedChars <= 100);
  assert.ok(pack.truncated);
}

// --- total budget across files ---
{
  const pack = assembleCorePack(
    [
      { path: "a.md", content: "A".repeat(80) },
      { path: "b.md", content: "B".repeat(80) },
      { path: "c.md", content: "C".repeat(80) },
    ],
    { project: "demo", maxFileChars: 100, maxTotalChars: 120 },
  );
  assert.ok(pack.totalChars <= 120, `total ${pack.totalChars} exceeds budget`);
  assert.ok(pack.truncated);
  // First file fully or mostly included; later files reduced or empty.
  assert.ok(pack.files[0].includedChars > 0);
  const sum = pack.files.reduce((n, f) => n + f.includedChars, 0);
  assert.equal(sum, pack.totalChars);
}

// --- formatCorePackMessage includes paths ---
{
  const msg = formatCorePackMessage(
    [
      {
        path: "memory/working-context.md",
        status: "loaded",
        content: "Hello focus",
        originalChars: 11,
        includedChars: 11,
      },
    ],
    "demo",
  );
  assert.ok(msg.includes("memory/working-context.md"));
  assert.ok(msg.includes("Hello focus"));
  assert.ok(msg.includes("demo"));
}

// --- widget label ---
assert.equal(formatCorePackWidgetLabel(undefined, { enabled: true }), undefined);
assert.equal(formatCorePackWidgetLabel(undefined, { enabled: false }), "core off");
{
  const pack = assembleCorePack(
    [
      { path: "a.md", content: "hi" },
      { path: "b.md", content: undefined },
    ],
    { project: "p", maxFileChars: 100, maxTotalChars: 100 },
  );
  assert.equal(formatCorePackWidgetLabel(pack, { enabled: true }), "core 1/2");
}
{
  const pack = assembleCorePack([{ path: "a.md", content: "x".repeat(200) }], {
    project: "p",
    maxFileChars: 50,
    maxTotalChars: 50,
  });
  assert.equal(formatCorePackWidgetLabel(pack, { enabled: true }), "core 1/1 (trunc)");
}
{
  const pack = assembleCorePack([{ path: "a.md", content: undefined }], {
    project: "p",
    maxFileChars: 50,
    maxTotalChars: 50,
  });
  assert.equal(formatCorePackWidgetLabel(pack, { enabled: true }), "core none");
}

// --- inject gates ---
assert.equal(shouldInjectCorePackOnSessionStart("startup", "session_start", false), true);
assert.equal(shouldInjectCorePackOnSessionStart("new", "session_start", false), true);
assert.equal(shouldInjectCorePackOnSessionStart("fork", "session_start", false), true);
assert.equal(shouldInjectCorePackOnSessionStart("resume", "session_start", false), false);
assert.equal(shouldInjectCorePackOnSessionStart("reload", "session_start", false), false);
assert.equal(shouldInjectCorePackOnSessionStart("startup", "session_start", true), false);
assert.equal(shouldInjectCorePackOnSessionStart("startup", "first_turn", false), false);

assert.equal(shouldInjectCorePackOnFirstTurn("first_turn", false), true);
assert.equal(shouldInjectCorePackOnFirstTurn("first_turn", true), false);
assert.equal(shouldInjectCorePackOnFirstTurn("session_start", false), false);

// --- defaults ---
{
  const d = withCoreLoadDefaults(undefined);
  assert.equal(d.enabled, true);
  assert.equal(d.maxTotalChars, DEFAULT_CORE_LOAD_CONFIG.maxTotalChars);
  assert.equal(d.maxFileChars, DEFAULT_CORE_LOAD_CONFIG.maxFileChars);
  assert.equal(d.injectOn, "session_start");
  assert.ok(d.files.includes("memory/working-context.md"));
  assert.ok(d.files.some((f) => f.includes("active-context.md")));
}
{
  const d = withCoreLoadDefaults({ enabled: false, maxTotalChars: 0, injectOn: "nope" });
  assert.equal(d.enabled, false);
  assert.equal(d.maxTotalChars, DEFAULT_CORE_LOAD_CONFIG.maxTotalChars, "invalid budget falls back");
  assert.equal(d.injectOn, "session_start", "invalid injectOn falls back");
}
{
  const d = withCoreLoadDefaults({ injectOn: "first_turn", maxFileChars: 12, files: ["memory/x.md"] });
  assert.equal(d.injectOn, "first_turn");
  assert.equal(d.maxFileChars, 12);
  assert.deepEqual(d.files, ["memory/x.md"]);
}

assert.equal(corePackCustomType(), "obsidian-memory-core");

console.log("core-pack tests: all passed");
