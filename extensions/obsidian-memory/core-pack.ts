/**
 * Session-start core pack: bounded always-on Notes (Working context, Active context,
 * optional project MEMORY index). Pure assembly helpers — IO lives in the extension.
 */

export type CoreLoadInjectOn = "session_start" | "first_turn";

export type CoreLoadConfig = {
  enabled: boolean;
  maxTotalChars: number;
  maxFileChars: number;
  files: string[];
  includeTodaySessionTail: boolean;
  injectOn: CoreLoadInjectOn;
};

export type CorePackFileStatus = "loaded" | "missing" | "truncated" | "empty";

export type CorePackFileResult = {
  path: string;
  status: CorePackFileStatus;
  /** Content after per-file and residual total-budget truncation; empty when missing/empty. */
  content: string;
  originalChars: number;
  includedChars: number;
};

export type CorePackResult = {
  project: string;
  files: CorePackFileResult[];
  loadedCount: number;
  missingPaths: string[];
  totalChars: number;
  truncated: boolean;
  /** Formatted injection body, or undefined when nothing usable was loaded. */
  messageContent?: string;
};

export const DEFAULT_CORE_LOAD_CONFIG: CoreLoadConfig = {
  enabled: true,
  maxTotalChars: 14_000,
  maxFileChars: 6_000,
  files: [
    "memory/working-context.md",
    "memory/projects/{project}/active-context.md",
    "memory/projects/{project}/MEMORY.md",
  ],
  includeTodaySessionTail: false,
  injectOn: "session_start",
};

const CORE_PACK_CUSTOM_TYPE = "obsidian-memory-core";

export function corePackCustomType(): string {
  return CORE_PACK_CUSTOM_TYPE;
}

/** Expand `{project}` placeholders in configured file templates. */
export function resolveCorePackPaths(templates: readonly string[], project: string): string[] {
  const slug = project.trim() || "unknown";
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const template of templates) {
    const path = template.replaceAll("{project}", slug).replace(/^\/+/, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    resolved.push(path);
  }
  return resolved;
}

/**
 * Truncate markdown by character budget without collapsing newlines.
 * Appends a short marker when truncated.
 */
export function truncateMarkdown(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { text: "", truncated: text.length > 0 };
  }
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const marker = "\n\n…(truncated for core pack budget)";
  const budget = Math.max(0, maxChars - marker.length);
  let slice = text.slice(0, budget);
  // Prefer breaking on a newline near the end when possible.
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl > budget * 0.6) {
    slice = slice.slice(0, lastNl);
  }
  return { text: slice.trimEnd() + marker, truncated: true };
}

export type CorePackSource = {
  path: string;
  /** Undefined means the Note is missing; empty string means present but empty. */
  content: string | undefined;
};

/**
 * Assemble a budgeted core pack from already-read sources (missing → undefined).
 * Enforces per-file then residual total char budgets; never throws on missing files.
 */
export function assembleCorePack(
  sources: readonly CorePackSource[],
  options: {
    project: string;
    maxFileChars: number;
    maxTotalChars: number;
  },
): CorePackResult {
  const maxFileChars = Math.max(0, options.maxFileChars);
  const maxTotalChars = Math.max(0, options.maxTotalChars);
  const files: CorePackFileResult[] = [];
  let remaining = maxTotalChars;
  let anyTruncated = false;
  let totalChars = 0;
  const missingPaths: string[] = [];

  for (const source of sources) {
    if (source.content === undefined) {
      missingPaths.push(source.path);
      files.push({
        path: source.path,
        status: "missing",
        content: "",
        originalChars: 0,
        includedChars: 0,
      });
      continue;
    }

    const original = source.content;
    const originalChars = original.length;
    if (originalChars === 0 || original.trim().length === 0) {
      files.push({
        path: source.path,
        status: "empty",
        content: "",
        originalChars,
        includedChars: 0,
      });
      continue;
    }

    if (remaining <= 0) {
      anyTruncated = true;
      files.push({
        path: source.path,
        status: "truncated",
        content: "",
        originalChars,
        includedChars: 0,
      });
      continue;
    }

    const fileBudget = Math.min(maxFileChars, remaining);
    const { text, truncated } = truncateMarkdown(original, fileBudget);
    if (truncated) anyTruncated = true;

    // If residual total budget is smaller than file budget, re-truncate to remaining.
    let included = text;
    if (included.length > remaining) {
      const second = truncateMarkdown(original, remaining);
      included = second.text;
      if (second.truncated) anyTruncated = true;
    }

    const includedChars = included.length;
    remaining = Math.max(0, remaining - includedChars);
    totalChars += includedChars;

    files.push({
      path: source.path,
      status: truncated || includedChars < originalChars ? "truncated" : "loaded",
      content: included,
      originalChars,
      includedChars,
    });
  }

  const loadedCount = files.filter((f) => f.includedChars > 0).length;
  const messageContent = loadedCount > 0 ? formatCorePackMessage(files, options.project) : undefined;

  return {
    project: options.project,
    files,
    loadedCount,
    missingPaths,
    totalChars,
    truncated: anyTruncated,
    messageContent,
  };
}

/** Format injection body for LLM context (custom message content). */
export function formatCorePackMessage(files: readonly CorePackFileResult[], project: string): string {
  const parts: string[] = [
    `Session core pack for project \`${project || "unknown"}\`.`,
    "These Notes are always-on continuity context (not Auto-recall search snippets).",
    "Prefer memory_get only when you need more than what is shown here.",
    "",
  ];

  for (const file of files) {
    if (file.includedChars <= 0) continue;
    parts.push(`### ${file.path}`);
    if (file.status === "truncated") {
      parts.push(`_(truncated; original ${file.originalChars} chars → ${file.includedChars})_`);
    }
    parts.push("");
    parts.push(file.content.trimEnd());
    parts.push("");
  }

  return parts.join("\n").trimEnd() + "\n";
}

/**
 * Compact widget/status label for core pack readiness.
 * Examples: `core 2/3`, `core 2/3 (trunc)`, `core none`, undefined when disabled/not run.
 */
export function formatCorePackWidgetLabel(
  result: CorePackResult | undefined,
  options: { enabled: boolean } = { enabled: true },
): string | undefined {
  if (!options.enabled) return "core off";
  if (!result) return undefined;
  const expected = result.files.length;
  if (expected === 0) return result.loadedCount > 0 ? `core ${result.loadedCount}` : "core none";
  const base = `core ${result.loadedCount}/${expected}`;
  if (result.loadedCount === 0) return "core none";
  return result.truncated ? `${base} (trunc)` : base;
}

/** Whether this session_start reason should attempt injection for injectOn=session_start. */
export function shouldInjectCorePackOnSessionStart(
  reason: string,
  injectOn: CoreLoadInjectOn,
  alreadyInjected: boolean,
): boolean {
  if (alreadyInjected) return false;
  if (injectOn !== "session_start") return false;
  // Avoid duplicating core pack on reload/resume of an existing conversation.
  return reason === "startup" || reason === "new" || reason === "fork";
}

/** Whether the first agent turn should inject the core pack. */
export function shouldInjectCorePackOnFirstTurn(
  injectOn: CoreLoadInjectOn,
  alreadyInjected: boolean,
): boolean {
  if (alreadyInjected) return false;
  return injectOn === "first_turn";
}

/**
 * Merge coreLoad partial config with defaults (positive budgets, known injectOn).
 */
export function withCoreLoadDefaults(partial?: Partial<CoreLoadConfig>): CoreLoadConfig {
  const injectOn =
    partial?.injectOn === "first_turn" || partial?.injectOn === "session_start"
      ? partial.injectOn
      : DEFAULT_CORE_LOAD_CONFIG.injectOn;

  const maxTotalChars =
    Number.isFinite(partial?.maxTotalChars) && (partial?.maxTotalChars ?? 0) > 0
      ? (partial?.maxTotalChars as number)
      : DEFAULT_CORE_LOAD_CONFIG.maxTotalChars;

  const maxFileChars =
    Number.isFinite(partial?.maxFileChars) && (partial?.maxFileChars ?? 0) > 0
      ? (partial?.maxFileChars as number)
      : DEFAULT_CORE_LOAD_CONFIG.maxFileChars;

  const files =
    Array.isArray(partial?.files) && partial.files.length > 0
      ? partial.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [...DEFAULT_CORE_LOAD_CONFIG.files];

  return {
    enabled: partial?.enabled ?? DEFAULT_CORE_LOAD_CONFIG.enabled,
    maxTotalChars,
    maxFileChars,
    files: files.length > 0 ? files : [...DEFAULT_CORE_LOAD_CONFIG.files],
    includeTodaySessionTail: partial?.includeTodaySessionTail ?? DEFAULT_CORE_LOAD_CONFIG.includeTodaySessionTail,
    injectOn,
  };
}
