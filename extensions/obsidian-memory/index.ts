import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;
type SearchMode = (typeof SEARCH_MODES)[number];
const SCOPES = ["project", "global", "session", "all"] as const;
type MemoryScope = (typeof SCOPES)[number];

type ProjectMapping = {
  cwdPattern: string;
  project: string;
};

type MemoryConfig = {
  vaultPath: string;
  qmdCommand: string;
  qmdCollection: string;
  defaultSearchMode: SearchMode;
  defaultLimit: number;
  routerFiles: string[];
  scopePrefixes: {
    global: string[];
    projectTemplate: string;
    sessionTemplate: string;
  };
  autoRecall: {
    enabled: boolean;
    maxResults: number;
    timeoutMs: number;
    clearDelayMs: number;
    triggerPatterns: string[];
  };
  autoSessionNotes: {
    enabled: boolean;
    maxAssistantChars: number;
    includeTools: boolean;
  };
  autoPropose: {
    enabled: boolean;
    triggerPatterns: string[];
  };
  preCompactionFlush: {
    enabled: boolean;
    maxTurns: number;
    includeFiles: boolean;
  };
  projectMappings: ProjectMapping[];
};

type RuntimeState = {
  configPath: string;
  config?: MemoryConfig;
  project?: string;
  ready: boolean;
  warnings: string[];
  lastRecallPreview?: string;
};

type QmdSearchResult = {
  docid?: string;
  score?: number;
  file: string;
  title?: string;
  line?: number;
  context?: string;
  snippet?: string;
  body?: string;
};

type ReviewProposal = {
  id: string;
  createdAt: string;
  project?: string;
  source: "assistant" | "auto" | "manual";
  rationale?: string;
  action: "append_log" | "append_file" | "write_file";
  path?: string;
  title?: string;
  content: string;
  status: "pending" | "applied" | "discarded";
};

type PendingMemoryIntent = {
  createdAt: string;
  prompt: string;
  matchedPattern: string;
  project?: string;
  targetPath: string;
};

type MemoryActivityState = "running" | "complete" | "failed" | "timed_out";

type MemoryActivity = {
  id: number;
  text: string;
  state: MemoryActivityState;
};

type MemoryAuditSummary = {
  scope: MemoryScope;
  project?: string;
  scannedFiles: number;
  staleFiles: Array<{ path: string; daysOld: number }>;
  brokenLinks: Array<{ source: string; target: string }>;
  orphanCandidates: string[];
  duplicateTitles: Array<{ title: string; paths: string[] }>;
  exactDuplicateBodies: string[][];
  contradictionCandidates: Array<{ paths: string[]; reason: string }>;
};

type MemoryNoteInfo = {
  path: string;
  absolutePath: string;
  title: string;
  content: string;
  normalizedBody: string;
  links: string[];
  lastReviewed?: string;
  status?: string;
  isDecision: boolean;
  titleTokens: string[];
  cueProfile: "positive" | "negative" | "neutral";
};

const DEFAULT_GLOBAL_PREFIXES = [
  "memory/schema.md",
  "memory/index.md",
  "memory/triggers.md",
  "memory/glossary.md",
  "memory/working-context.md",
  "memory/global/",
] as const;

const DEFAULT_AUTO_RECALL_PATTERNS = [
  "continue",
  "last session",
  "what did we decide",
  "why did we",
  "remember",
  "context",
  "catch up",
  "project status",
] as const;
const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 60_000;
const DEFAULT_AUTO_RECALL_CLEAR_DELAY_MS = 5_000;

const DEFAULT_AUTO_SESSION_NOTES = {
  enabled: true,
  maxAssistantChars: 280,
  includeTools: true,
} as const;

const DEFAULT_AUTO_PROPOSE_PATTERNS = [
  "remember this",
  "save this",
  "make a note",
  "note this",
  "capture this",
  "file this",
  "don't forget",
  "store this",
  "put this in memory",
  "add this to memory",
  "write this down",
] as const;

const DEFAULT_PRE_COMPACTION_FLUSH = {
  enabled: true,
  maxTurns: 8,
  includeFiles: true,
} as const;

const MEMORY_STATUS_SCHEMA = Type.Object({});
const MEMORY_SEARCH_SCHEMA = Type.Object({
  query: Type.String({ description: "Search query for the knowledge base" }),
  scope: Type.Optional(StringEnum(SCOPES)),
  mode: Type.Optional(StringEnum(SEARCH_MODES)),
  limit: Type.Optional(Type.Number({ description: "Maximum results", minimum: 1, maximum: 20 })),
  project: Type.Optional(Type.String({ description: "Project slug override" })),
});
const MEMORY_GET_SCHEMA = Type.Object({
  path: Type.String({ description: "Vault-relative path returned by memory_search, or a QMD docid like #abc123" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
const MEMORY_WRITE_SCHEMA = Type.Object({
  action: StringEnum(["append_log", "append_file", "write_file"] as const),
  path: Type.Optional(Type.String({ description: "Vault-relative target path under memory/" })),
  title: Type.Optional(Type.String({ description: "Optional title for append_log entries" })),
  content: Type.String({ description: "Markdown content to write" }),
});
const MEMORY_RECORD_DECISION_SCHEMA = Type.Object({
  title: Type.String({ description: "Decision title" }),
  summary: Type.String({ description: "Short summary of what was decided" }),
  rationale: Type.String({ description: "Why this decision was made" }),
  alternatives: Type.Optional(Type.String({ description: "Alternatives considered" })),
  consequences: Type.Optional(Type.String({ description: "Expected downstream consequences" })),
  status: Type.Optional(StringEnum(["proposed", "adopted", "superseded", "rejected"] as const)),
  project: Type.Optional(Type.String({ description: "Project slug override" })),
  date: Type.Optional(Type.String({ description: "Decision date in YYYY-MM-DD format" })),
});
const MEMORY_PROPOSE_WRITE_SCHEMA = Type.Object({
  action: StringEnum(["append_log", "append_file", "write_file"] as const),
  path: Type.Optional(Type.String({ description: "Vault-relative target path under memory/" })),
  title: Type.Optional(Type.String({ description: "Optional title for append_log entries" })),
  content: Type.String({ description: "Markdown content to queue for review" }),
  rationale: Type.Optional(Type.String({ description: "Why this write should be proposed" })),
  project: Type.Optional(Type.String({ description: "Project slug override" })),
});
const MEMORY_REVIEW_STATUS_SCHEMA = Type.Object({});
const MEMORY_AUDIT_SCHEMA = Type.Object({
  scope: Type.Optional(StringEnum(SCOPES)),
  project: Type.Optional(Type.String({ description: "Project slug override" })),
  staleDays: Type.Optional(Type.Number({ description: "Staleness threshold in days", minimum: 1, maximum: 3650 })),
});

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME || input;
  if (input.startsWith("~/")) {
    return join(process.env.HOME || "~", input.slice(2));
  }
  return input;
}

function normalizePathArg(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

function normalizeVaultRelativePath(input: string): string {
  const normalized = normalizePathArg(input);
  if (normalized.startsWith("qmd://")) {
    const withoutScheme = normalized.slice("qmd://".length);
    const slashIndex = withoutScheme.indexOf("/");
    if (slashIndex >= 0) {
      return withoutScheme.slice(slashIndex + 1);
    }
    return "";
  }
  return normalized.replace(/^\/+/, "");
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveConfigPath(): string {
  const fromEnv = process.env.PI_MEMORY_CONFIG;
  if (fromEnv) return expandHome(fromEnv);
  return join(getAgentDir(), "memory", "config.json");
}

function withDefaults(config: Partial<MemoryConfig>): MemoryConfig {
  const configuredVaultPath = config.vaultPath ? resolve(expandHome(config.vaultPath)) : "";
  return {
    vaultPath: configuredVaultPath,
    qmdCommand: config.qmdCommand || "qmd",
    qmdCollection: config.qmdCollection || "",
    defaultSearchMode: config.defaultSearchMode || "hybrid",
    defaultLimit: config.defaultLimit || 5,
    routerFiles: config.routerFiles || [
      "memory/schema.md",
      "memory/index.md",
      "memory/working-context.md",
      "memory/triggers.md",
      "memory/glossary.md",
    ],
    scopePrefixes: {
      global: config.scopePrefixes?.global || [...DEFAULT_GLOBAL_PREFIXES],
      projectTemplate: config.scopePrefixes?.projectTemplate || "memory/projects/{project}/",
      sessionTemplate: config.scopePrefixes?.sessionTemplate || "memory/sessions/{project}/",
    },
    autoRecall: {
      enabled: config.autoRecall?.enabled ?? true,
      maxResults: config.autoRecall?.maxResults || 4,
      timeoutMs:
        Number.isFinite(config.autoRecall?.timeoutMs) && (config.autoRecall?.timeoutMs ?? 0) > 0
          ? config.autoRecall?.timeoutMs ?? DEFAULT_AUTO_RECALL_TIMEOUT_MS
          : DEFAULT_AUTO_RECALL_TIMEOUT_MS,
      clearDelayMs:
        Number.isFinite(config.autoRecall?.clearDelayMs) && (config.autoRecall?.clearDelayMs ?? -1) >= 0
          ? config.autoRecall?.clearDelayMs ?? DEFAULT_AUTO_RECALL_CLEAR_DELAY_MS
          : DEFAULT_AUTO_RECALL_CLEAR_DELAY_MS,
      triggerPatterns: config.autoRecall?.triggerPatterns || [...DEFAULT_AUTO_RECALL_PATTERNS],
    },
    autoSessionNotes: {
      enabled: config.autoSessionNotes?.enabled ?? DEFAULT_AUTO_SESSION_NOTES.enabled,
      maxAssistantChars: config.autoSessionNotes?.maxAssistantChars || DEFAULT_AUTO_SESSION_NOTES.maxAssistantChars,
      includeTools: config.autoSessionNotes?.includeTools ?? DEFAULT_AUTO_SESSION_NOTES.includeTools,
    },
    autoPropose: {
      enabled: config.autoPropose?.enabled ?? true,
      triggerPatterns: config.autoPropose?.triggerPatterns || [...DEFAULT_AUTO_PROPOSE_PATTERNS],
    },
    preCompactionFlush: {
      enabled: config.preCompactionFlush?.enabled ?? DEFAULT_PRE_COMPACTION_FLUSH.enabled,
      maxTurns: config.preCompactionFlush?.maxTurns || DEFAULT_PRE_COMPACTION_FLUSH.maxTurns,
      includeFiles: config.preCompactionFlush?.includeFiles ?? DEFAULT_PRE_COMPACTION_FLUSH.includeFiles,
    },
    projectMappings: config.projectMappings || [],
  };
}

async function loadConfig(configPath: string): Promise<{ config?: MemoryConfig; warnings: string[] }> {
  const warnings: string[] = [];
  if (!existsSync(configPath)) {
    warnings.push(`Missing config: ${configPath}`);
    return { warnings };
  }

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MemoryConfig>;
    const config = withDefaults(parsed);

    if (!config.vaultPath) warnings.push("Config is missing vaultPath");
    if (!config.qmdCollection) warnings.push("Config is missing qmdCollection");
    if (config.vaultPath && !existsSync(config.vaultPath)) {
      warnings.push(`Vault path does not exist: ${config.vaultPath}`);
    }

    return { config, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to load config: ${message}`);
    return { warnings };
  }
}

async function detectProject(pi: ExtensionAPI, ctx: ExtensionContext, config?: MemoryConfig): Promise<string> {
  for (const mapping of config?.projectMappings || []) {
    if (ctx.cwd.includes(mapping.cwdPattern)) return mapping.project;
  }

  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 1500 });
    const root = result.stdout.trim();
    if (result.code === 0 && root) return basename(root);
  } catch {
    // ignore and fall back to cwd
  }

  return basename(ctx.cwd);
}

function isRuntimeReady(state: RuntimeState): boolean {
  return Boolean(state.config && state.config.qmdCollection && state.config.vaultPath && existsSync(state.config.vaultPath));
}

async function refreshRuntimeState(pi: ExtensionAPI, ctx: ExtensionContext, current?: RuntimeState): Promise<RuntimeState> {
  const configPath = current?.configPath || resolveConfigPath();
  const { config, warnings } = await loadConfig(configPath);
  const project = await detectProject(pi, ctx, config);
  const next: RuntimeState = {
    configPath,
    config,
    project,
    warnings,
    ready: false,
    lastRecallPreview: current?.lastRecallPreview,
  };
  next.ready = isRuntimeReady(next);
  return next;
}

function resolveReviewQueuePath(): string {
  return join(getAgentDir(), "memory", "review-queue.json");
}

async function loadReviewQueue(): Promise<ReviewProposal[]> {
  const queuePath = resolveReviewQueuePath();
  if (!existsSync(queuePath)) return [];

  try {
    const raw = await readFile(queuePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReviewProposal[]) : [];
  } catch {
    return [];
  }
}

async function saveReviewQueue(queue: ReviewProposal[]): Promise<void> {
  const queuePath = resolveReviewQueuePath();
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, JSON.stringify(queue, null, 2) + "\n", "utf8");
}

function getPendingReviewProposals(queue: ReviewProposal[]): ReviewProposal[] {
  return queue.filter((item) => item.status === "pending");
}

function resolveProposalTarget(proposal: Pick<ReviewProposal, "action" | "path">): string {
  return proposal.action === "append_log" ? "memory/log.md" : proposal.path || "(missing path)";
}

function renderProposalPreview(proposal: ReviewProposal): string {
  const preview = proposal.content.replace(/\s+/g, " ").trim().slice(0, 100);
  return `${proposal.id} · ${proposal.action} · ${resolveProposalTarget(proposal)}${preview ? ` · ${preview}` : ""}`;
}

function chooseAutoProposalPath(prompt: string, project?: string): string {
  const lowered = prompt.toLowerCase();
  const looksGlobal = ["i prefer", "my preference", "for future answers", "in general", "default to"].some((token) =>
    lowered.includes(token),
  );
  if (looksGlobal || !project) return "memory/working-context.md";
  return `memory/projects/${project}/active-context.md`;
}

function detectExplicitMemoryIntent(prompt: string, patterns: readonly string[], project?: string): PendingMemoryIntent | undefined {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("/")) return undefined;
  const lowered = normalized.toLowerCase();
  const matchedPattern = patterns.find((pattern) => lowered.includes(pattern.toLowerCase()));
  if (!matchedPattern) return undefined;

  return {
    createdAt: new Date().toISOString(),
    prompt: normalized,
    matchedPattern,
    project,
    targetPath: chooseAutoProposalPath(normalized, project),
  };
}

function didPersistMemoryThisTurn(messages: Array<any>): boolean {
  return messages.some(
    (message) =>
      message?.role === "toolResult" && ["memory_propose_write", "memory_write", "memory_record_decision"].includes(String(message?.toolName || "")),
  );
}

function buildAutoProposalFromTurn(
  intent: PendingMemoryIntent,
  messages: Array<any>,
  config: MemoryConfig,
): ReviewProposal | undefined {
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
  const toolNames = [...new Set(messages.filter((message) => message?.role === "toolResult").map((message) => message?.toolName).filter(Boolean))];
  const userText = truncateText(extractTextFromContent(lastUser?.content || intent.prompt), 220);
  const assistantText = truncateText(extractTextFromContent(lastAssistant?.content), config.autoSessionNotes.maxAssistantChars);
  if (!userText && !assistantText) return undefined;

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const content = [
    `\n## [${stamp}] explicit memory capture`,
    "",
    `- Trigger: ${intent.matchedPattern}`,
    userText ? `- User request: ${userText}` : undefined,
    assistantText ? `- Assistant summary: ${assistantText}` : undefined,
    toolNames.length > 0 ? `- Tools: ${toolNames.join(", ")}` : undefined,
    "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    project: intent.project,
    source: "auto",
    rationale: `Auto-captured because the user explicitly asked to remember/save something (${intent.matchedPattern}).`,
    action: "append_file",
    path: intent.targetPath,
    title: "explicit-memory-capture",
    content,
    status: "pending",
  };
}

function toStringList(value: unknown): string[] {
  if (value instanceof Set) return [...value].map(String);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function computeTrackedFiles(fileOps: unknown): { readFiles: string[]; modifiedFiles: string[] } {
  const candidate = (fileOps || {}) as { read?: unknown; written?: unknown; edited?: unknown };
  const readFiles = new Set(toStringList(candidate.read));
  const modifiedFiles = new Set([...toStringList(candidate.written), ...toStringList(candidate.edited)]);
  for (const file of modifiedFiles) readFiles.delete(file);
  return {
    readFiles: [...readFiles].sort(),
    modifiedFiles: [...modifiedFiles].sort(),
  };
}

function buildTurnSnapshots(
  messages: Array<any>,
  maxTurns: number,
  maxAssistantChars: number,
): Array<{ user?: string; assistant?: string; tools: string[] }> {
  const snapshots: Array<{ user?: string; assistant?: string; tools: string[] }> = [];
  let current: { user?: string; assistant?: string; tools: string[] } = { tools: [] };
  const flushCurrent = () => {
    if (current.user || current.assistant || current.tools.length > 0) {
      snapshots.push({ user: current.user, assistant: current.assistant, tools: [...current.tools] });
    }
    current = { tools: [] };
  };

  for (const message of messages) {
    if (message?.role === "user") {
      flushCurrent();
      current.user = truncateText(extractTextFromContent(message?.content), 180);
      continue;
    }
    if (message?.role === "assistant") {
      current.assistant = truncateText(extractTextFromContent(message?.content), maxAssistantChars);
      continue;
    }
    if (message?.role === "toolResult" && message?.toolName) {
      if (!current.tools.includes(message.toolName)) current.tools.push(message.toolName);
    }
  }

  flushCurrent();
  return snapshots.slice(-Math.max(1, maxTurns));
}

function buildCompactionFlushBody(
  preparation: { messagesToSummarize?: Array<any>; tokensBefore?: number; isSplitTurn?: boolean; fileOps?: unknown },
  config: MemoryConfig,
): string | undefined {
  const messages = Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : [];
  const turns = buildTurnSnapshots(messages, config.preCompactionFlush.maxTurns, Math.min(config.autoSessionNotes.maxAssistantChars, 220));
  const { readFiles, modifiedFiles } = computeTrackedFiles(preparation.fileOps);
  if (turns.length === 0 && modifiedFiles.length === 0 && readFiles.length === 0) return undefined;

  const lines = [
    `\n## [${timeLabelNow()}] pre_compaction_flush`,
    "",
    `- Tokens before compaction: ${preparation.tokensBefore ?? "unknown"}`,
    `- Messages summarized: ${messages.length}`,
    `- Split turn: ${preparation.isSplitTurn ? "yes" : "no"}`,
  ];

  if (config.preCompactionFlush.includeFiles) {
    if (modifiedFiles.length > 0) lines.push(`- Modified files: ${modifiedFiles.slice(0, 8).join(", ")}`);
    if (readFiles.length > 0) lines.push(`- Read files: ${readFiles.slice(0, 8).join(", ")}`);
  }

  if (turns.length > 0) {
    lines.push("", "### Conversation snapshot", "");
    turns.forEach((turn, index) => {
      lines.push(`- Turn ${index + 1}`);
      if (turn.user) lines.push(`  - User: ${turn.user}`);
      if (turn.assistant) lines.push(`  - Assistant: ${turn.assistant}`);
      if (turn.tools.length > 0) lines.push(`  - Tools: ${turn.tools.join(", ")}`);
    });
  }

  lines.push("");
  return lines.join("\n");
}

function buildWidgetLines(
  ctx: ExtensionContext,
  state: RuntimeState,
  pendingQueue: ReviewProposal[],
  sessionNotesEnabled: boolean,
  pendingIntent?: PendingMemoryIntent,
  activity?: MemoryActivity,
): string[] {
  const pending = getPendingReviewProposals(pendingQueue);
  const review = ctx.ui.theme.fg(pending.length > 0 ? "warning" : "dim", `review ${pending.length} pending`);
  const notes = ctx.ui.theme.fg(sessionNotesEnabled ? "success" : "dim", `session notes ${sessionNotesEnabled ? "on" : "off"}`);
  const autoCapture = ctx.ui.theme.fg(state.config?.autoPropose.enabled ? "success" : "dim", `auto capture ${state.config?.autoPropose.enabled ? "on" : "off"}`);
  const lines = [ctx.ui.theme.fg("accent", "🧠 memory"), `${review} · ${notes} · ${autoCapture}`];

  if (activity) {
    const color = activity.state === "complete" ? "success" : activity.state === "running" ? "accent" : "warning";
    lines.push(ctx.ui.theme.fg(color, activity.text));
    return lines;
  }

  if (pending.length > 0) {
    const next = pending[0];
    lines.push(ctx.ui.theme.fg("warning", `next ${next.id} → ${resolveProposalTarget(next)}`));
    lines.push(ctx.ui.theme.fg("dim", truncateText(next.content, 96)));
    lines.push(
      ctx.ui.theme.fg(
        "dim",
        pending.length > 1 ? `+${pending.length - 1} more · /memory-review pick` : `/memory-review pick · /memory-review apply ${next.id}`,
      ),
    );
  } else if (pendingIntent) {
    lines.push(ctx.ui.theme.fg("accent", `armed → will queue a review proposal after this reply (${pendingIntent.matchedPattern})`));
  }

  return lines;
}

function setStatus(
  ctx: ExtensionContext,
  state: RuntimeState,
  pendingQueue: ReviewProposal[] = [],
  sessionNotesEnabled: boolean = false,
  pendingIntent?: PendingMemoryIntent,
  activity?: MemoryActivity,
) {
  if (!ctx.hasUI) return;

  if (state.ready) {
    const pendingReviewCount = getPendingReviewProposals(pendingQueue).length;
    const suffix = pendingReviewCount > 0 ? ` +${pendingReviewCount} review` : "";
    ctx.ui.setStatus("obsidian-memory", `memory:${state.project || "unknown"}${suffix}`);
    ctx.ui.setWidget("obsidian-memory", buildWidgetLines(ctx, state, pendingQueue, sessionNotesEnabled, pendingIntent, activity), {
      placement: "belowEditor",
    });
  } else {
    ctx.ui.setStatus("obsidian-memory", "memory:unconfigured");
    const lines = [ctx.ui.theme.fg("warning", "Obsidian memory not configured"), ctx.ui.theme.fg("dim", state.configPath)];
    if (activity) {
      const color = activity.state === "complete" ? "success" : activity.state === "running" ? "accent" : "warning";
      lines.push(ctx.ui.theme.fg(color, activity.text));
    }
    ctx.ui.setWidget("obsidian-memory", lines, { placement: "belowEditor" });
  }
}

function renderStatus(state: RuntimeState, qmdStatus?: string, pendingReviewCount: number = 0): string {
  const lines = [
    `Config: ${state.configPath}`,
    `Ready: ${state.ready ? "yes" : "no"}`,
    `Project: ${state.project || "unknown"}`,
    `Vault: ${state.config?.vaultPath || "(missing)"}`,
    `QMD command: ${state.config?.qmdCommand || "qmd"}`,
    `QMD collection: ${state.config?.qmdCollection || "(missing)"}`,
    `Default mode: ${state.config?.defaultSearchMode || "hybrid"}`,
    `Pending review items: ${pendingReviewCount}`,
    `Auto recall: ${state.config?.autoRecall.enabled ? "on" : "off"}`,
    `Auto recall timeout: ${state.config?.autoRecall.timeoutMs ?? DEFAULT_AUTO_RECALL_TIMEOUT_MS}ms`,
    `Memory activity clear delay: ${state.config?.autoRecall.clearDelayMs ?? DEFAULT_AUTO_RECALL_CLEAR_DELAY_MS}ms`,
    `Auto session notes: ${state.config?.autoSessionNotes.enabled ? "on" : "off"}`,
    `Auto propose memory requests: ${state.config?.autoPropose.enabled ? "on" : "off"}`,
    `Pre-compaction flush: ${state.config?.preCompactionFlush.enabled ? "on" : "off"}`,
  ];

  if (qmdStatus) {
    lines.push("", "QMD status:", qmdStatus.trim());
  }

  if (state.warnings.length > 0) {
    lines.push("", "Warnings:", ...state.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function getScopePrefixes(config: MemoryConfig, scope: MemoryScope, project?: string): string[] | undefined {
  const globalPrefixes = [...config.scopePrefixes.global];
  const projectPrefix = project ? config.scopePrefixes.projectTemplate.replaceAll("{project}", project) : undefined;
  const sessionPrefix = project ? config.scopePrefixes.sessionTemplate.replaceAll("{project}", project) : undefined;

  switch (scope) {
    case "global":
      return globalPrefixes;
    case "project":
      return [...globalPrefixes, ...(projectPrefix ? [projectPrefix] : [])];
    case "session":
      return [...globalPrefixes, ...(projectPrefix ? [projectPrefix] : []), ...(sessionPrefix ? [sessionPrefix] : [])];
    case "all":
      return undefined;
  }
}

function matchesPrefix(file: string, prefix: string): boolean {
  return prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix;
}

function filterByScope(results: QmdSearchResult[], prefixes?: string[]): QmdSearchResult[] {
  if (!prefixes || prefixes.length === 0) return results;
  return results.filter((result) => prefixes.some((prefix) => matchesPrefix(normalizeVaultRelativePath(result.file), prefix)));
}

function summarizeResults(results: QmdSearchResult[]): string {
  if (results.length === 0) return "No matching memory notes found.";

  return results
    .map((result, index) => {
      const score = typeof result.score === "number" ? `${Math.round(result.score * 100)}%` : "--";
      const line = result.line ? `:${result.line}` : "";
      const docid = result.docid ? `${result.docid} ` : "";
      const heading = `${index + 1}. [${score}] ${docid}${result.file}${line}`;
      const title = result.title && result.title !== result.file ? `   title: ${result.title}` : undefined;
      const snippet = result.snippet ? `   ${result.snippet.replace(/\s+/g, " ").trim()}` : undefined;
      return [heading, title, snippet].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

async function getQmdStatus(pi: ExtensionAPI, state: RuntimeState): Promise<string | undefined> {
  if (!state.ready || !state.config) return undefined;
  try {
    const result = await pi.exec(state.config.qmdCommand, ["status"], { timeout: 4000 });
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    return text || undefined;
  } catch {
    return undefined;
  }
}

function buildSearchModes(mode: SearchMode): SearchMode[] {
  if (mode === "hybrid") return ["hybrid", "semantic", "keyword"];
  if (mode === "semantic") return ["semantic", "keyword"];
  return ["keyword"];
}

function buildQmdArgs(config: MemoryConfig, query: string, mode: SearchMode, limit: number): string[] {
  const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
  const args = [subcommand, query, "--json", "--line-numbers", "-n", String(limit)];
  if (config.qmdCollection) {
    args.push("-c", config.qmdCollection);
  }
  return args;
}

async function runSearch(
  pi: ExtensionAPI,
  state: RuntimeState,
  options: { query: string; scope: MemoryScope; mode: SearchMode; limit: number; project?: string; timeoutMs?: number },
): Promise<{ results: QmdSearchResult[]; attemptedModes: SearchMode[] }> {
  if (!state.ready || !state.config) {
    throw new Error("Memory system is not configured.");
  }

  const project = options.project || state.project;
  const prefixes = getScopePrefixes(state.config, options.scope, project);
  const rawLimit = Math.min(Math.max(options.limit * 4, options.limit), 30);
  const attemptedModes: SearchMode[] = [];
  let lastError = "Unknown QMD error";

  for (const attempt of buildSearchModes(options.mode)) {
    attemptedModes.push(attempt);
    const args = buildQmdArgs(state.config, options.query, attempt, rawLimit);
    try {
      const result = await pi.exec(state.config.qmdCommand, args, { timeout: options.timeoutMs ?? 20000 });
      if (result.code !== 0) {
        lastError = (result.stderr || result.stdout || `qmd exited with code ${result.code}`).trim();
        continue;
      }

      const parsed = JSON.parse(result.stdout || "[]") as QmdSearchResult[];
      const normalizedResults = parsed.map((item) => ({
        ...item,
        file: normalizeVaultRelativePath(item.file),
      }));
      const filtered = filterByScope(normalizedResults, prefixes).slice(0, options.limit);
      return { results: filtered, attemptedModes };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError);
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return lowered.includes("timed out") || lowered.includes("timeout");
}

function formatMemoryTarget(input?: string): string {
  const trimmed = input?.trim();
  if (!trimmed) return "memory";
  const normalized = normalizeVaultRelativePath(normalizePathArg(trimmed));
  return basename(normalized || trimmed);
}

function resolveVaultFile(config: MemoryConfig, inputPath: string): { absolutePath: string; relativePath: string } {
  const relativePath = normalizeVaultRelativePath(inputPath);
  const absolutePath = resolve(config.vaultPath, relativePath);
  if (!isWithinRoot(config.vaultPath, absolutePath)) {
    throw new Error(`Path escapes vault root: ${inputPath}`);
  }
  return { absolutePath, relativePath };
}

async function readVaultFile(config: MemoryConfig, inputPath: string, offset?: number, limit?: number): Promise<string> {
  const { absolutePath } = resolveVaultFile(config, inputPath);
  const content = await readFile(absolutePath, "utf8");
  if (!offset && !limit) return content;

  const lines = content.split("\n");
  const start = offset ? Math.max(0, offset - 1) : 0;
  const end = limit ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}

async function writeVaultFile(config: MemoryConfig, inputPath: string, content: string, appendMode: boolean) {
  const { absolutePath, relativePath } = resolveVaultFile(config, inputPath);
  if (!relativePath.startsWith("memory/")) {
    throw new Error(`Writes are restricted to memory/: ${relativePath}`);
  }

  await withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    if (appendMode) {
      await appendFile(absolutePath, content, "utf8");
    } else {
      await writeFile(absolutePath, content, "utf8");
    }
  });
}

function sanitizeDecisionTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || "Untitled decision";
}

async function getNextDecisionId(config: MemoryConfig, project: string): Promise<string> {
  const decisionsDir = resolve(config.vaultPath, `memory/projects/${project}/decisions`);
  await mkdir(decisionsDir, { recursive: true });
  const entries = await readdir(decisionsDir, { withFileTypes: true });
  let maxId = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^DEC-(\d+)/i);
    if (!match) continue;
    maxId = Math.max(maxId, Number(match[1]));
  }

  return `DEC-${String(maxId + 1).padStart(3, "0")}`;
}

function buildDecisionNote(params: {
  decisionId: string;
  project: string;
  title: string;
  summary: string;
  rationale: string;
  alternatives?: string;
  consequences?: string;
  status: string;
  date: string;
}): string {
  const title = sanitizeDecisionTitle(params.title);
  const sections = [
    "---",
    "type: decision",
    "scope: project",
    `project: ${params.project}`,
    `relevance: high`,
    `status: ${params.status}`,
    `decision_id: ${params.decisionId}`,
    `last_reviewed: ${params.date}`,
    "---",
    `# ${params.decisionId} - ${title}`,
    "",
    "## Summary",
    "",
    params.summary.trim(),
    "",
    "## Rationale",
    "",
    params.rationale.trim(),
  ];

  if (params.alternatives?.trim()) {
    sections.push("", "## Alternatives considered", "", params.alternatives.trim());
  }
  if (params.consequences?.trim()) {
    sections.push("", "## Consequences", "", params.consequences.trim());
  }

  return sections.join("\n") + "\n";
}

function buildDecisionIndexHeader(project: string): string {
  return `---\ntype: context\nscope: project\nrelevance: medium\nlast_reviewed: ${new Date().toISOString().slice(0, 10)}\n---\n# Decision index\n\nProject: ${project}\n\n`;
}

function buildDecisionIndexEntry(params: {
  decisionId: string;
  title: string;
  summary: string;
  status: string;
  date: string;
}): string {
  const safeTitle = sanitizeDecisionTitle(params.title);
  const shortSummary = params.summary.replace(/\s+/g, " ").trim();
  return `- ${params.date} — [[${params.decisionId} - ${safeTitle}|${params.decisionId}]] — ${params.status} — ${shortSummary}\n`;
}

function isoDateNow(): string {
  return new Date().toISOString().slice(0, 10);
}

function timeLabelNow(): string {
  return new Date().toISOString().slice(11, 16);
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text || "")
    .join("\n")
    .trim();
}

function normalizeLinkTarget(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/\.md$/i, "").replace(/^\/+/, "").trim().toLowerCase();
}

function normalizeStem(path: string): string {
  return normalizeLinkTarget(path.replace(/\.md$/i, ""));
}

function tokenizeTitle(input: string): string[] {
  const stopwords = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "index", "readme"]);
  return (input.toLowerCase().match(/[a-z0-9]+/g) || []).filter((token) => token.length > 2 && !stopwords.has(token));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function cueProfileForContent(content: string, status?: string): "positive" | "negative" | "neutral" {
  const lowered = `${status || ""} ${content}`.toLowerCase();
  const positive = ["adopted", "use ", "preferred", "enable", "keep", "recommended"];
  const negative = ["rejected", "superseded", "deprecated", "avoid", "do not", "remove", "disable"];
  const hasPositive = positive.some((token) => lowered.includes(token));
  const hasNegative = negative.some((token) => lowered.includes(token));
  if (hasPositive && !hasNegative) return "positive";
  if (hasNegative && !hasPositive) return "negative";
  return "neutral";
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) data[key] = value;
  }
  return data;
}

function parseNoteInfo(vaultRoot: string, absolutePath: string, content: string): MemoryNoteInfo {
  const relativePath = relative(vaultRoot, absolutePath).replace(/\\/g, "/");
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const frontmatter = parseFrontmatter(content);
  const links: string[] = [];
  const linkPattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match = linkPattern.exec(content);
  while (match) {
    links.push(match[1].trim());
    match = linkPattern.exec(content);
  }

  return {
    path: relativePath,
    absolutePath,
    title: titleMatch?.[1]?.trim() || basename(relativePath, ".md"),
    content,
    normalizedBody: content.replace(/\s+/g, " ").trim().toLowerCase(),
    links,
    lastReviewed: frontmatter.last_reviewed,
    status: frontmatter.status,
    isDecision: frontmatter.type === "decision" || relativePath.includes("/decisions/"),
    titleTokens: tokenizeTitle(titleMatch?.[1]?.trim() || basename(relativePath, ".md")),
    cueProfile: cueProfileForContent(content, frontmatter.status),
  };
}

function resolveWikiLink(target: string, notes: MemoryNoteInfo[]): string | undefined {
  const normalized = normalizeLinkTarget(target);
  if (!normalized) return undefined;

  const byStem = new Map(notes.map((note) => [normalizeStem(note.path), note.path]));
  const direct = byStem.get(normalized);
  if (direct) return direct;

  const basenameKey = basename(normalized);
  const matches = notes.filter((note) => basename(normalizeStem(note.path)) === basenameKey);
  if (matches.length === 1) return matches[0].path;
  return undefined;
}

function daysSince(dateString?: string): number | undefined {
  if (!dateString) return undefined;
  const timestamp = Date.parse(dateString);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
}

function buildAuditReport(summary: MemoryAuditSummary): string {
  const lines = [
    `Scope: ${summary.scope}${summary.project ? ` (${summary.project})` : ""}`,
    `Scanned files: ${summary.scannedFiles}`,
    `Stale files: ${summary.staleFiles.length}`,
    `Broken links: ${summary.brokenLinks.length}`,
    `Orphan candidates: ${summary.orphanCandidates.length}`,
    `Duplicate titles: ${summary.duplicateTitles.length}`,
    `Exact duplicate bodies: ${summary.exactDuplicateBodies.length}`,
    `Potential contradictions: ${summary.contradictionCandidates.length}`,
  ];

  if (summary.staleFiles.length > 0) {
    lines.push("", "## Stale files", ...summary.staleFiles.slice(0, 20).map((item) => `- ${item.path} (${item.daysOld} days since review)`));
  }
  if (summary.brokenLinks.length > 0) {
    lines.push("", "## Broken wikilinks", ...summary.brokenLinks.slice(0, 20).map((item) => `- ${item.source} -> [[${item.target}]]`));
  }
  if (summary.orphanCandidates.length > 0) {
    lines.push("", "## Orphan candidates", ...summary.orphanCandidates.slice(0, 20).map((path) => `- ${path}`));
  }
  if (summary.duplicateTitles.length > 0) {
    lines.push(
      "",
      "## Duplicate titles",
      ...summary.duplicateTitles.slice(0, 20).map((item) => `- ${item.title}: ${item.paths.join(", ")}`),
    );
  }
  if (summary.exactDuplicateBodies.length > 0) {
    lines.push(
      "",
      "## Exact duplicate bodies",
      ...summary.exactDuplicateBodies.slice(0, 20).map((paths) => `- ${paths.join(", ")}`),
    );
  }
  if (summary.contradictionCandidates.length > 0) {
    lines.push(
      "",
      "## Potential contradictions",
      ...summary.contradictionCandidates.slice(0, 20).map((item) => `- ${item.reason}: ${item.paths.join(", ")}`),
    );
  }

  return lines.join("\n");
}

async function runAudit(config: MemoryConfig, scope: MemoryScope, project: string | undefined, staleDays: number): Promise<MemoryAuditSummary> {
  const baseRelative =
    scope === "project"
      ? `memory/projects/${project || ""}`
      : scope === "session"
        ? `memory/sessions/${project || ""}`
        : scope === "global"
          ? "memory"
          : "memory";
  const auditRoot = resolve(config.vaultPath, baseRelative || "memory");
  const files = existsSync(auditRoot) ? await collectMarkdownFiles(auditRoot) : [];
  const notes = await Promise.all(files.map(async (absolutePath) => parseNoteInfo(config.vaultPath, absolutePath, await readFile(absolutePath, "utf8"))));

  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  const brokenLinks: Array<{ source: string; target: string }> = [];
  for (const note of notes) {
    outbound.set(note.path, note.links.length);
    for (const link of note.links) {
      const resolved = resolveWikiLink(link, notes);
      if (!resolved) {
        brokenLinks.push({ source: note.path, target: link });
        continue;
      }
      inbound.set(resolved, (inbound.get(resolved) || 0) + 1);
    }
  }

  const staleFiles = notes
    .map((note) => ({ note, age: daysSince(note.lastReviewed) }))
    .filter((item): item is { note: MemoryNoteInfo; age: number } => item.age !== undefined && item.age > staleDays)
    .map((item) => ({ path: item.note.path, daysOld: item.age }))
    .sort((a, b) => b.daysOld - a.daysOld);

  const orphanCandidates = notes
    .filter((note) => {
      const name = basename(note.path, ".md").toLowerCase();
      const isCore = ["index", "readme", "schema", "glossary", "triggers", "working-context", "log"].includes(name);
      return !isCore && (inbound.get(note.path) || 0) === 0 && (outbound.get(note.path) || 0) === 0;
    })
    .map((note) => note.path)
    .sort();

  const titleGroups = new Map<string, string[]>();
  const bodyGroups = new Map<string, string[]>();
  for (const note of notes) {
    const titleKey = note.title.trim().toLowerCase();
    titleGroups.set(titleKey, [...(titleGroups.get(titleKey) || []), note.path]);
    bodyGroups.set(note.normalizedBody, [...(bodyGroups.get(note.normalizedBody) || []), note.path]);
  }

  const duplicateTitles = [...titleGroups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([title, paths]) => ({ title, paths }));
  const exactDuplicateBodies = [...bodyGroups.values()].filter((paths) => paths.length > 1);

  const contradictionCandidates: Array<{ paths: string[]; reason: string }> = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const left = notes[i];
      const right = notes[j];
      const titleSimilarity = jaccardSimilarity(left.titleTokens, right.titleTokens);
      if (titleSimilarity < 0.5) continue;
      const opposingCue =
        (left.cueProfile === "positive" && right.cueProfile === "negative") ||
        (left.cueProfile === "negative" && right.cueProfile === "positive");
      const differingDecisionStatus = left.isDecision && right.isDecision && left.status && right.status && left.status !== right.status;
      if (opposingCue || differingDecisionStatus) {
        contradictionCandidates.push({
          paths: [left.path, right.path],
          reason: differingDecisionStatus ? "decision status mismatch on similar titles" : "opposing cue words on similar titles",
        });
      }
    }
  }

  return {
    scope,
    project,
    scannedFiles: notes.length,
    staleFiles,
    brokenLinks,
    orphanCandidates,
    duplicateTitles,
    exactDuplicateBodies,
    contradictionCandidates,
  };
}

async function ensureSessionNoteFile(config: MemoryConfig, project: string, date: string): Promise<string> {
  const notePath = `memory/sessions/${project}/${date}.md`;
  const { absolutePath } = resolveVaultFile(config, notePath);
  if (!existsSync(absolutePath)) {
    const header = [
      "---",
      "type: context",
      "scope: session",
      `project: ${project}`,
      "relevance: low",
      `last_reviewed: ${date}`,
      "---",
      `# Session notes - ${project} - ${date}`,
      "",
    ].join("\n");
    await writeVaultFile(config, notePath, header, false);
  }
  return notePath;
}

async function appendSessionNote(config: MemoryConfig, project: string, body: string): Promise<void> {
  const date = isoDateNow();
  const notePath = await ensureSessionNoteFile(config, project, date);
  await writeVaultFile(config, notePath, body, true);
}

async function applyReviewProposal(config: MemoryConfig, proposal: ReviewProposal): Promise<void> {
  if (proposal.action === "append_log") {
    const stamp = proposal.createdAt.slice(0, 16).replace("T", " ");
    const heading = proposal.title?.trim() || "reviewed-memory-update";
    const entry = `\n## [${stamp}] ${heading}\n\n${proposal.content.trim()}\n`;
    await writeVaultFile(config, "memory/log.md", entry, true);
    return;
  }

  const path = proposal.path?.trim();
  if (!path) {
    throw new Error(`Proposal ${proposal.id} is missing a target path.`);
  }

  await writeVaultFile(config, path, proposal.content, proposal.action === "append_file");
}

function shouldAutoRecall(prompt: string, state: RuntimeState): boolean {
  if (!state.ready || !state.config?.autoRecall.enabled) return false;
  const lowered = prompt.toLowerCase();
  return state.config.autoRecall.triggerPatterns.some((pattern) => lowered.includes(pattern.toLowerCase()));
}

export default function obsidianMemoryPackage(pi: ExtensionAPI) {
  let runtimeState: RuntimeState = {
    configPath: resolveConfigPath(),
    ready: false,
    warnings: [],
  };
  let reviewQueue: ReviewProposal[] = [];
  let pendingMemoryIntent: PendingMemoryIntent | undefined;
  let memoryActivity: MemoryActivity | undefined;
  let memoryActivitySequence = 0;
  let memoryActivityClearTimer: ReturnType<typeof setTimeout> | undefined;

  const updateUi = (ctx?: ExtensionContext) => {
    if (!ctx) return;
    setStatus(
      ctx,
      runtimeState,
      reviewQueue,
      Boolean(runtimeState.config?.autoSessionNotes.enabled),
      pendingMemoryIntent,
      memoryActivity,
    );
  };

  const clearScheduledMemoryActivity = () => {
    if (memoryActivityClearTimer) {
      clearTimeout(memoryActivityClearTimer);
      memoryActivityClearTimer = undefined;
    }
  };

  const beginMemoryActivity = (ctx: ExtensionContext | undefined, text: string): number => {
    clearScheduledMemoryActivity();
    const id = ++memoryActivitySequence;
    memoryActivity = { id, text, state: "running" };
    updateUi(ctx);
    return id;
  };

  const finishMemoryActivity = (ctx: ExtensionContext | undefined, id: number, state: MemoryActivityState, text: string) => {
    if (!memoryActivity || memoryActivity.id !== id) return;

    clearScheduledMemoryActivity();
    memoryActivity = { id, text, state };
    updateUi(ctx);

    const clearDelayMs = runtimeState.config?.autoRecall.clearDelayMs ?? DEFAULT_AUTO_RECALL_CLEAR_DELAY_MS;
    if (clearDelayMs <= 0) {
      memoryActivity = undefined;
      updateUi(ctx);
      return;
    }

    memoryActivityClearTimer = setTimeout(() => {
      if (memoryActivity?.id !== id) return;
      memoryActivity = undefined;
      updateUi(ctx);
    }, clearDelayMs);
  };

  const runWithMemoryActivity = async <T>(
    ctx: ExtensionContext | undefined,
    runningText: string,
    completeText: string,
    failedText: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const activityId = beginMemoryActivity(ctx, runningText);
    try {
      const result = await operation();
      finishMemoryActivity(ctx, activityId, "complete", completeText);
      return result;
    } catch (error) {
      finishMemoryActivity(ctx, activityId, "failed", failedText);
      throw error;
    }
  };

  const queueProposal = async (proposal: ReviewProposal | undefined, ctx?: ExtensionContext) => {
    if (!proposal) return undefined;
    reviewQueue = [proposal, ...reviewQueue];
    await saveReviewQueue(reviewQueue);
    if (ctx) updateUi(ctx);
    return proposal;
  };

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" } as const;

    pendingMemoryIntent = undefined;
    const enabled = runtimeState.config?.autoPropose.enabled ?? true;
    if (enabled) {
      const patterns = runtimeState.config?.autoPropose.triggerPatterns || [...DEFAULT_AUTO_PROPOSE_PATTERNS];
      pendingMemoryIntent = detectExplicitMemoryIntent(event.text, patterns, runtimeState.project);
    }
    updateUi(ctx);
    return { action: "continue" } as const;
  });

  pi.on("session_shutdown", async () => {
    clearScheduledMemoryActivity();
    memoryActivity = undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    runtimeState = await refreshRuntimeState(pi, ctx, runtimeState);
    reviewQueue = await loadReviewQueue();
    pendingMemoryIntent = undefined;
    clearScheduledMemoryActivity();
    memoryActivity = undefined;
    updateUi(ctx);

    if (runtimeState.ready && runtimeState.config?.autoSessionNotes.enabled && event.reason !== "reload") {
      await appendSessionNote(
        runtimeState.config,
        runtimeState.project || "unknown",
        `\n## [${timeLabelNow()}] session_start\n\n- reason: ${event.reason}\n`,
      );
    }

    if (ctx.hasUI) {
      if (runtimeState.ready) {
        ctx.ui.notify(`Obsidian memory ready for project: ${runtimeState.project}`, "info");
      } else {
        ctx.ui.notify(`Obsidian memory not ready. Run /memory-init-config or edit ${runtimeState.configPath}`, "warning");
      }
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!runtimeState.ready || !runtimeState.config?.preCompactionFlush.enabled) return;

    try {
      const body = buildCompactionFlushBody(event.preparation, runtimeState.config);
      if (!body) return;
      await appendSessionNote(runtimeState.config, runtimeState.project || "unknown", body);
      updateUi(ctx);
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Obsidian memory pre-compaction flush failed: ${message}`, "warning");
      }
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const messages = Array.isArray(event.messages) ? (event.messages as Array<any>) : [];

    if (runtimeState.ready && runtimeState.config?.autoSessionNotes.enabled) {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
      const toolNames = [...new Set(messages.filter((message) => message.role === "toolResult").map((message) => message.toolName).filter(Boolean))];
      const userText = truncateText(extractTextFromContent(lastUser?.content), 220);
      const assistantText = truncateText(
        extractTextFromContent(lastAssistant?.content),
        runtimeState.config.autoSessionNotes.maxAssistantChars,
      );

      if (userText || assistantText || toolNames.length > 0) {
        const lines = [`\n## [${timeLabelNow()}] turn`, ""];
        if (userText) lines.push(`- User: ${userText}`);
        if (assistantText) lines.push(`- Assistant: ${assistantText}`);
        if (runtimeState.config.autoSessionNotes.includeTools && toolNames.length > 0) {
          lines.push(`- Tools: ${toolNames.join(", ")}`);
        }
        lines.push("");
        await appendSessionNote(runtimeState.config, runtimeState.project || "unknown", lines.join("\n"));
      }
    }

    if (
      runtimeState.ready &&
      runtimeState.config?.autoPropose.enabled &&
      pendingMemoryIntent &&
      !didPersistMemoryThisTurn(messages)
    ) {
      const proposal = await queueProposal(buildAutoProposalFromTurn(pendingMemoryIntent, messages, runtimeState.config), ctx);
      if (proposal && ctx.hasUI) {
        ctx.ui.notify(`Queued auto memory proposal ${proposal.id} for ${proposal.path}`, "info");
      }
    }

    pendingMemoryIntent = undefined;
    updateUi(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let systemPrompt = event.systemPrompt;
    let message:
      | {
          customType: string;
          content: string;
          display: boolean;
        }
      | undefined;

    if (pendingMemoryIntent && runtimeState.config?.autoPropose.enabled) {
      systemPrompt += `\n\nExplicit memory request detected for this turn. Before finishing, create a durable memory artifact. Prefer memory_propose_write over memory_write unless the user explicitly asked for an immediate write. Suggested target: ${pendingMemoryIntent.targetPath}. If the request is clearly a durable project decision with title, summary, and rationale, prefer memory_record_decision.`;
    }

    if (shouldAutoRecall(event.prompt, runtimeState) && runtimeState.config) {
      const activityId = beginMemoryActivity(ctx, "recalling memory: searching QMD");
      try {
        const { results } = await runSearch(pi, runtimeState, {
          query: event.prompt,
          scope: "project",
          mode: runtimeState.config.defaultSearchMode,
          limit: runtimeState.config.autoRecall.maxResults,
          timeoutMs: runtimeState.config.autoRecall.timeoutMs,
        });

        if (results.length > 0) {
          const preview = summarizeResults(results);
          runtimeState.lastRecallPreview = preview;
          message = {
            customType: "obsidian-memory-context",
            content: `Auto memory recall for project \`${runtimeState.project || "unknown"}\`:\n\n${preview}`,
            display: true,
          };
          systemPrompt += "\n\nWhen obsidian-memory-context is present, treat it as retrieved memory context. Use memory_get before relying on a note beyond the quoted snippet.";
        }
        finishMemoryActivity(ctx, activityId, "complete", "memory recall complete");
      } catch (error) {
        finishMemoryActivity(
          ctx,
          activityId,
          isTimeoutError(error) ? "timed_out" : "failed",
          isTimeoutError(error) ? "memory recall timed out; continuing" : "memory recall failed; continuing",
        );
        // ignore recall failure and keep other memory behavior
      }
    }

    if (!message && systemPrompt === event.systemPrompt) return;
    return message ? { message, systemPrompt } : { systemPrompt };
  });

  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description: "Show Obsidian/QMD memory integration status for the current Pi session.",
    promptSnippet: "Inspect whether Obsidian memory is configured and ready for the current project.",
    promptGuidelines: [
      "Use this tool when you need to confirm that the memory vault and QMD retrieval layer are configured before relying on memory.",
    ],
    parameters: MEMORY_STATUS_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return runWithMemoryActivity(ctx, "memory: checking status…", "memory: status complete", "memory: status failed", async () => {
        const qmdStatus = await getQmdStatus(pi, runtimeState);
        const pending = getPendingReviewProposals(reviewQueue);
        return {
          content: [{ type: "text", text: renderStatus(runtimeState, qmdStatus, pending.length) }],
          details: { runtimeState, qmdStatus, pending },
        };
      });
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search the configured Obsidian memory vault via QMD and return ranked markdown notes.",
    promptSnippet: "Search the Obsidian memory wiki before broad file reads when the user asks about prior context, decisions, or continuity.",
    promptGuidelines: [
      "Prefer memory_search over ad-hoc vault browsing when the user asks about prior discussions, decisions, or persistent project context.",
      "After memory_search, call memory_get only for the top 1-3 notes you actually need to read in full.",
    ],
    parameters: MEMORY_SEARCH_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runWithMemoryActivity(ctx, "memory: searching…", "memory: search complete", "memory: search failed", async () => {
        const mode = params.mode || runtimeState.config?.defaultSearchMode || "hybrid";
        const scope = params.scope || "project";
        const limit = params.limit || runtimeState.config?.defaultLimit || 5;
        const { results, attemptedModes } = await runSearch(pi, runtimeState, {
          query: params.query,
          scope,
          mode,
          limit,
          project: params.project,
        });

        return {
          content: [{ type: "text", text: summarizeResults(results) }],
          details: {
            query: params.query,
            scope,
            mode,
            attemptedModes,
            project: params.project || runtimeState.project,
            results,
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Memory Get",
    description: "Read a full memory note from the configured Obsidian vault, or fetch by QMD docid.",
    promptSnippet: "Read full note content for a specific memory_search result.",
    promptGuidelines: [
      "Use this after memory_search when you need the full note content for one specific result.",
    ],
    parameters: MEMORY_GET_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runWithMemoryActivity(
        ctx,
        `memory: reading ${formatMemoryTarget(params.path)}`,
        "memory: read complete",
        "memory: read failed",
        async () => {
          if (!runtimeState.ready || !runtimeState.config) {
            throw new Error("Memory system is not configured.");
          }

          const normalizedPath = normalizePathArg(params.path);
          if (normalizedPath.startsWith("#")) {
            const result = await pi.exec(runtimeState.config.qmdCommand, ["get", normalizedPath], { timeout: 10000 });
            if (result.code !== 0) {
              throw new Error((result.stderr || result.stdout || "qmd get failed").trim());
            }
            return {
              content: [{ type: "text", text: result.stdout }],
              details: { docid: normalizedPath },
            };
          }

          const vaultRelativePath = normalizeVaultRelativePath(normalizedPath);
          try {
            const { absolutePath } = resolveVaultFile(runtimeState.config, vaultRelativePath);
            if (existsSync(absolutePath)) {
              const text = await readVaultFile(runtimeState.config, vaultRelativePath, params.offset, params.limit);
              return {
                content: [{ type: "text", text }],
                details: { path: vaultRelativePath, offset: params.offset, limit: params.limit },
              };
            }
          } catch {
            // fall through to qmd get
          }

          const qmdResult = await pi.exec(runtimeState.config.qmdCommand, ["get", normalizedPath], { timeout: 10000 });
          if (qmdResult.code !== 0) {
            throw new Error((qmdResult.stderr || qmdResult.stdout || `Unable to retrieve ${normalizedPath}`).trim());
          }
          return {
            content: [{ type: "text", text: qmdResult.stdout }],
            details: { path: normalizedPath, via: "qmd" },
          };
        },
      );
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description: "Write markdown into the configured memory/ subtree with conservative path guards.",
    promptSnippet: "Persist durable notes to the configured memory wiki instead of editing random vault files directly.",
    promptGuidelines: [
      "Use memory_write for wiki maintenance under memory/ instead of generic write when updating the configured Obsidian memory vault.",
      "Never use this tool for raw sources; it is only for the maintained wiki under memory/.",
    ],
    parameters: MEMORY_WRITE_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = params.action === "append_log" ? "memory/log.md" : params.path;
      return runWithMemoryActivity(
        ctx,
        `memory: writing ${formatMemoryTarget(target)}`,
        "memory: write complete",
        "memory: write failed",
        async () => {
          if (!runtimeState.ready || !runtimeState.config) {
            throw new Error("Memory system is not configured.");
          }

          if (params.action === "append_log") {
            const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
            const heading = params.title?.trim() || "memory-update";
            const entry = `\n## [${stamp}] ${heading}\n\n${params.content.trim()}\n`;
            await writeVaultFile(runtimeState.config, "memory/log.md", entry, true);
            return {
              content: [{ type: "text", text: `Appended log entry to memory/log.md` }],
              details: { action: params.action, path: "memory/log.md" },
            };
          }

          const path = params.path?.trim();
          if (!path) {
            throw new Error(`Action ${params.action} requires path.`);
          }

          const appendMode = params.action === "append_file";
          await writeVaultFile(runtimeState.config, path, params.content, appendMode);
          return {
            content: [{ type: "text", text: `${appendMode ? "Appended" : "Wrote"} ${path}` }],
            details: { action: params.action, path },
          };
        },
      );
    },
  });

  pi.registerTool({
    name: "memory_propose_write",
    label: "Memory Propose Write",
    description: "Queue a proposed wiki write for human review instead of applying it immediately.",
    promptSnippet: "Queue durable memory writes that should be reviewed before they touch the Obsidian wiki.",
    promptGuidelines: [
      "Use memory_propose_write for confirmation-first changes like durable preferences, doctrine, or uncertain long-term facts.",
      "Prefer memory_propose_write over memory_write when the update is likely correct but should still be reviewed by the user.",
    ],
    parameters: MEMORY_PROPOSE_WRITE_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = params.action === "append_log" ? "memory/log.md" : params.path;
      return runWithMemoryActivity(
        ctx,
        `memory: proposing ${formatMemoryTarget(target)}`,
        "memory: proposal complete",
        "memory: proposal failed",
        async () => {
          if (!runtimeState.ready || !runtimeState.config) {
            throw new Error("Memory system is not configured.");
          }
          if (params.action !== "append_log" && !params.path?.trim()) {
            throw new Error(`Action ${params.action} requires path.`);
          }

          const proposal: ReviewProposal = {
            id: randomUUID().slice(0, 8),
            createdAt: new Date().toISOString(),
            project: params.project || runtimeState.project,
            source: "assistant",
            rationale: params.rationale,
            action: params.action,
            path: params.path,
            title: params.title,
            content: params.content,
            status: "pending",
          };
          reviewQueue = [proposal, ...reviewQueue];
          await saveReviewQueue(reviewQueue);
          updateUi(ctx);

          return {
            content: [{ type: "text", text: `Queued review proposal ${proposal.id}` }],
            details: { proposal, pendingCount: getPendingReviewProposals(reviewQueue).length },
          };
        },
      );
    },
  });

  pi.registerTool({
    name: "memory_review_status",
    label: "Memory Review Status",
    description: "List pending proposed memory writes waiting for review.",
    promptSnippet: "Inspect queued memory write proposals awaiting human review.",
    parameters: MEMORY_REVIEW_STATUS_SCHEMA,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return runWithMemoryActivity(ctx, "memory: checking review…", "memory: review complete", "memory: review failed", async () => {
        const pending = getPendingReviewProposals(reviewQueue);
        const text =
          pending.length === 0
            ? "No pending review proposals."
            : pending.map((proposal) => `- ${renderProposalPreview(proposal)}`).join("\n");
        return {
          content: [{ type: "text", text }],
          details: { pending },
        };
      });
    },
  });

  pi.registerTool({
    name: "memory_audit",
    label: "Memory Audit",
    description: "Audit the memory wiki for stale notes, broken links, orphan pages, duplicates, and contradiction candidates.",
    promptSnippet: "Run a deterministic audit over the Obsidian memory wiki before proposing cleanup work.",
    promptGuidelines: [
      "Use memory_audit when the user asks to review, clean up, or lint the memory wiki.",
      "After memory_audit, use memory_get or memory_search only for the flagged notes that need closer inspection.",
    ],
    parameters: MEMORY_AUDIT_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runWithMemoryActivity(ctx, "memory: auditing…", "memory: audit complete", "memory: audit failed", async () => {
        if (!runtimeState.ready || !runtimeState.config) {
          throw new Error("Memory system is not configured.");
        }

        const scope = params.scope || "project";
        const project = params.project || runtimeState.project;
        const staleDays = params.staleDays || 30;
        const summary = await runAudit(runtimeState.config, scope, project, staleDays);
        return {
          content: [{ type: "text", text: buildAuditReport(summary) }],
          details: { summary },
        };
      });
    },
  });

  pi.registerTool({
    name: "memory_record_decision",
    label: "Memory Record Decision",
    description: "Create a structured decision note under memory/projects/<project>/decisions and log it.",
    promptSnippet: "Record durable project decisions with rationale into the Obsidian memory wiki.",
    promptGuidelines: [
      "Use memory_record_decision when the user wants a decision preserved with rationale, alternatives, and consequences.",
      "Ask for missing rationale first if the decision is under-specified, then call this tool once the decision is clear.",
    ],
    parameters: MEMORY_RECORD_DECISION_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runWithMemoryActivity(ctx, "memory: writing decision…", "memory: decision complete", "memory: decision failed", async () => {
        if (!runtimeState.ready || !runtimeState.config) {
          throw new Error("Memory system is not configured.");
        }

        const project = (params.project || runtimeState.project || "").trim();
        if (!project) {
          throw new Error("No project slug available for decision recording.");
        }

        const date = params.date?.trim() || new Date().toISOString().slice(0, 10);
        const status = params.status || "adopted";
        const safeTitle = sanitizeDecisionTitle(params.title);
        const decisionId = await getNextDecisionId(runtimeState.config, project);
        const notePath = `memory/projects/${project}/decisions/${decisionId} - ${safeTitle}.md`;
        const indexPath = `memory/projects/${project}/decisions/index.md`;
        const noteBody = buildDecisionNote({
          decisionId,
          project,
          title: safeTitle,
          summary: params.summary,
          rationale: params.rationale,
          alternatives: params.alternatives,
          consequences: params.consequences,
          status,
          date,
        });

        await writeVaultFile(runtimeState.config, notePath, noteBody, false);

        const { absolutePath: indexAbsolutePath } = resolveVaultFile(runtimeState.config, indexPath);
        if (!existsSync(indexAbsolutePath)) {
          await writeVaultFile(runtimeState.config, indexPath, buildDecisionIndexHeader(project), false);
        }
        await writeVaultFile(
          runtimeState.config,
          indexPath,
          buildDecisionIndexEntry({
            decisionId,
            title: safeTitle,
            summary: params.summary,
            status,
            date,
          }),
          true,
        );

        const logEntry = `\n## [${date}] decision | ${decisionId}\n\nRecorded ${decisionId} for project \`${project}\`: ${safeTitle}\n`;
        await writeVaultFile(runtimeState.config, "memory/log.md", logEntry, true);

        return {
          content: [{ type: "text", text: `Recorded ${decisionId} at ${notePath}` }],
          details: {
            decisionId,
            project,
            status,
            path: notePath,
            indexPath,
          },
        };
      });
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show obsidian-memory runtime status",
    handler: async (_args, ctx) => {
      runtimeState = await refreshRuntimeState(pi, ctx, runtimeState);
      reviewQueue = await loadReviewQueue();
      updateUi(ctx);
      const qmdStatus = await getQmdStatus(pi, runtimeState);
      ctx.ui.notify(renderStatus(runtimeState, qmdStatus, getPendingReviewProposals(reviewQueue).length), runtimeState.ready ? "info" : "warning");
    },
  });

  pi.registerCommand("memory-search", {
    description: "Search the configured Obsidian memory vault: /memory-search <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /memory-search <query>", "warning");
        return;
      }

      runtimeState = await refreshRuntimeState(pi, ctx, runtimeState);
      reviewQueue = await loadReviewQueue();
      updateUi(ctx);
      try {
        const { results } = await runSearch(pi, runtimeState, {
          query,
          scope: "project",
          mode: runtimeState.config?.defaultSearchMode || "hybrid",
          limit: runtimeState.config?.defaultLimit || 5,
        });
        ctx.ui.notify(summarizeResults(results), "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`memory-search failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("memory-review", {
    description: "Review queued memory writes: /memory-review [list|show|pick|apply|discard] [id|next|all]",
    handler: async (args, ctx) => {
      reviewQueue = await loadReviewQueue();
      const [subcommandRaw, targetRaw] = args.trim().split(/\s+/, 2).filter(Boolean);
      const subcommand = (subcommandRaw || "list").toLowerCase();
      const pending = getPendingReviewProposals(reviewQueue);
      const findProposal = (token: string | undefined) => {
        if (!token || token === "next") return pending[0];
        return reviewQueue.find((proposal) => proposal.id === token || proposal.id.startsWith(token));
      };
      const formatDetails = (proposal: ReviewProposal) =>
        [
          `ID: ${proposal.id}`,
          `Status: ${proposal.status}`,
          `Action: ${proposal.action}`,
          `Project: ${proposal.project || "(none)"}`,
          `Path: ${resolveProposalTarget(proposal)}`,
          `Created: ${proposal.createdAt}`,
          proposal.rationale ? `Rationale: ${proposal.rationale}` : undefined,
          "",
          proposal.content,
        ]
          .filter(Boolean)
          .join("\n");

      if (subcommand === "list") {
        const text = pending.length === 0 ? "No pending review proposals." : pending.map((proposal) => `- ${renderProposalPreview(proposal)}`).join("\n");
        updateUi(ctx);
        ctx.ui.notify(text, pending.length > 0 ? "info" : "warning");
        return;
      }

      if (subcommand === "pick") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/memory-review pick requires interactive mode.", "error");
          return;
        }
        if (pending.length === 0) {
          ctx.ui.notify("No pending review proposals.", "warning");
          return;
        }

        const options = pending.map((proposal) => renderProposalPreview(proposal));
        const choice = await ctx.ui.select("Select a pending memory proposal", options);
        if (!choice) return;
        const proposal = pending[options.indexOf(choice)];
        if (!proposal) return;

        ctx.ui.notify(formatDetails(proposal), "info");
        const applyNow = await ctx.ui.confirm("Apply proposal?", `${proposal.id} → ${resolveProposalTarget(proposal)}`);
        if (applyNow) {
          if (!runtimeState.ready || !runtimeState.config) {
            ctx.ui.notify("Memory system is not configured.", "error");
            return;
          }
          await applyReviewProposal(runtimeState.config, proposal);
          proposal.status = "applied";
          await saveReviewQueue(reviewQueue);
          updateUi(ctx);
          ctx.ui.notify(`Applied review proposal ${proposal.id}.`, "success");
          return;
        }

        const discardNow = await ctx.ui.confirm("Discard proposal instead?", "Select No to keep it pending.");
        if (discardNow) {
          proposal.status = "discarded";
          await saveReviewQueue(reviewQueue);
          updateUi(ctx);
          ctx.ui.notify(`Discarded review proposal ${proposal.id}.`, "success");
        }
        return;
      }

      if (subcommand === "show") {
        const proposal = findProposal(targetRaw);
        if (!proposal) {
          ctx.ui.notify("Usage: /memory-review show <id|next>", "warning");
          return;
        }
        ctx.ui.notify(formatDetails(proposal), "info");
        return;
      }

      if (subcommand === "apply" || subcommand === "discard") {
        const targets =
          targetRaw === "all"
            ? pending
            : (() => {
                const proposal = findProposal(targetRaw);
                return proposal ? [proposal] : [];
              })();

        if (targets.length === 0) {
          ctx.ui.notify(`Usage: /memory-review ${subcommand} <id|next|all>`, "warning");
          return;
        }

        if (subcommand === "apply") {
          if (!runtimeState.ready || !runtimeState.config) {
            ctx.ui.notify("Memory system is not configured.", "error");
            return;
          }
          for (const proposal of targets) {
            if (proposal.status !== "pending") continue;
            await applyReviewProposal(runtimeState.config, proposal);
            proposal.status = "applied";
          }
        } else {
          for (const proposal of targets) {
            if (proposal.status !== "pending") continue;
            proposal.status = "discarded";
          }
        }

        await saveReviewQueue(reviewQueue);
        updateUi(ctx);
        ctx.ui.notify(`${subcommand === "apply" ? "Applied" : "Discarded"} ${targets.length} review proposal(s).`, "success");
        return;
      }

      ctx.ui.notify("Usage: /memory-review [list|show|pick|apply|discard] [id|next|all]", "warning");
    },
  });

  pi.registerCommand("memory-audit-now", {
    description: "Run a deterministic memory audit: /memory-audit-now [scope] [project] [staleDays]",
    handler: async (args, ctx) => {
      runtimeState = await refreshRuntimeState(pi, ctx, runtimeState);
      reviewQueue = await loadReviewQueue();
      updateUi(ctx);
      if (!runtimeState.ready || !runtimeState.config) {
        ctx.ui.notify("Memory system is not configured.", "error");
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const scope = (parts[0] && ["project", "global", "session", "all"].includes(parts[0]) ? parts[0] : "project") as MemoryScope;
      const project = parts[0] && ["project", "global", "session", "all"].includes(parts[0]) ? parts[1] || runtimeState.project : parts[0] || runtimeState.project;
      const staleDaysRaw = parts[0] && ["project", "global", "session", "all"].includes(parts[0]) ? parts[2] : parts[1];
      const staleDays = staleDaysRaw ? Number(staleDaysRaw) || 30 : 30;
      const summary = await runAudit(runtimeState.config, scope, project, staleDays);
      const report = buildAuditReport(summary);
      const severity = summary.brokenLinks.length + summary.orphanCandidates.length + summary.contradictionCandidates.length > 0 ? "warning" : "info";
      ctx.ui.notify(report, severity);
    },
  });

  pi.registerCommand("memory-init-config", {
    description: "Create ~/.pi/agent/memory/config.json from the example if it does not exist",
    handler: async (_args, ctx) => {
      const configPath = resolveConfigPath();
      if (existsSync(configPath)) {
        ctx.ui.notify(`Config already exists: ${configPath}`, "info");
        return;
      }

      const examplePath = join(getAgentDir(), "memory", "config.example.json");
      if (!existsSync(examplePath)) {
        ctx.ui.notify(`Missing example config: ${examplePath}`, "error");
        return;
      }

      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, await readFile(examplePath, "utf8"), "utf8");
      ctx.ui.notify(`Wrote ${configPath}. Edit vaultPath/qmdCollection, then run /memory-reload.`, "success");
      runtimeState = await refreshRuntimeState(pi, ctx, runtimeState);
      reviewQueue = await loadReviewQueue();
      updateUi(ctx);
    },
  });

  pi.registerCommand("memory-reload", {
    description: "Reload obsidian-memory runtime config",
    handler: async (_args, ctx) => {
      runtimeState = await refreshRuntimeState(pi, ctx, runtimeState);
      reviewQueue = await loadReviewQueue();
      updateUi(ctx);
      ctx.ui.notify(renderStatus(runtimeState, undefined, getPendingReviewProposals(reviewQueue).length), runtimeState.ready ? "success" : "warning");
    },
  });
}
