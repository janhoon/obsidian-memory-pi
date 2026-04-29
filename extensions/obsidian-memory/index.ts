import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
const INGEST_KINDS = ["auto", "document", "image", "video", "audio"] as const;
type IngestKindInput = (typeof INGEST_KINDS)[number];
type IngestKind = Exclude<IngestKindInput, "auto">;
const DOCLING_IMAGE_EXPORT_MODES = ["placeholder", "embedded", "referenced"] as const;
type DoclingImageExportMode = (typeof DOCLING_IMAGE_EXPORT_MODES)[number];

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
  ingest: {
    doclingCommand: string;
    ffmpegCommand: string;
    doclingTimeoutMs: number;
    ffmpegTimeoutMs: number;
    qmdSyncAfterIngest: boolean;
    qmdUpdateTimeoutMs: number;
    qmdEmbedTimeoutMs: number;
    maxSourceCopyBytes: number;
    maxExtractedCharsInMemory: number;
    videoFrameIntervalSec: number;
    maxVideoFrames: number;
    doclingImageExportMode: DoclingImageExportMode;
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

const DEFAULT_INGEST_CONFIG = {
  doclingCommand: "docling",
  ffmpegCommand: "ffmpeg",
  doclingTimeoutMs: 120_000,
  ffmpegTimeoutMs: 120_000,
  qmdSyncAfterIngest: true,
  qmdUpdateTimeoutMs: 60_000,
  qmdEmbedTimeoutMs: 180_000,
  maxSourceCopyBytes: 25 * 1024 * 1024,
  maxExtractedCharsInMemory: 50_000,
  videoFrameIntervalSec: 30,
  maxVideoFrames: 12,
  doclingImageExportMode: "placeholder" as DoclingImageExportMode,
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
const MEMORY_INGEST_SOURCE_SCHEMA = Type.Object({
  source: Type.String({ description: "Local file path or http(s) URL to ingest into memory" }),
  kind: Type.Optional(StringEnum(INGEST_KINDS)),
  title: Type.Optional(Type.String({ description: "Optional human-readable title for the source note" })),
  project: Type.Optional(Type.String({ description: "Project slug override" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags to add to the generated memory note" })),
  copySource: Type.Optional(Type.Boolean({ description: "Copy the raw source into sources/ when possible. Defaults to true for non-video inputs." })),
  refreshIndex: Type.Optional(Type.Boolean({ description: "Run QMD update/embed after writing. Defaults to config.ingest.qmdSyncAfterIngest." })),
  targetPath: Type.Optional(Type.String({ description: "Optional vault-relative memory/ path for the generated note" })),
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
    ingest: {
      doclingCommand: config.ingest?.doclingCommand || DEFAULT_INGEST_CONFIG.doclingCommand,
      ffmpegCommand: config.ingest?.ffmpegCommand || DEFAULT_INGEST_CONFIG.ffmpegCommand,
      doclingTimeoutMs:
        Number.isFinite(config.ingest?.doclingTimeoutMs) && (config.ingest?.doclingTimeoutMs ?? 0) > 0
          ? config.ingest?.doclingTimeoutMs ?? DEFAULT_INGEST_CONFIG.doclingTimeoutMs
          : DEFAULT_INGEST_CONFIG.doclingTimeoutMs,
      ffmpegTimeoutMs:
        Number.isFinite(config.ingest?.ffmpegTimeoutMs) && (config.ingest?.ffmpegTimeoutMs ?? 0) > 0
          ? config.ingest?.ffmpegTimeoutMs ?? DEFAULT_INGEST_CONFIG.ffmpegTimeoutMs
          : DEFAULT_INGEST_CONFIG.ffmpegTimeoutMs,
      qmdSyncAfterIngest: config.ingest?.qmdSyncAfterIngest ?? DEFAULT_INGEST_CONFIG.qmdSyncAfterIngest,
      qmdUpdateTimeoutMs:
        Number.isFinite(config.ingest?.qmdUpdateTimeoutMs) && (config.ingest?.qmdUpdateTimeoutMs ?? 0) > 0
          ? config.ingest?.qmdUpdateTimeoutMs ?? DEFAULT_INGEST_CONFIG.qmdUpdateTimeoutMs
          : DEFAULT_INGEST_CONFIG.qmdUpdateTimeoutMs,
      qmdEmbedTimeoutMs:
        Number.isFinite(config.ingest?.qmdEmbedTimeoutMs) && (config.ingest?.qmdEmbedTimeoutMs ?? 0) > 0
          ? config.ingest?.qmdEmbedTimeoutMs ?? DEFAULT_INGEST_CONFIG.qmdEmbedTimeoutMs
          : DEFAULT_INGEST_CONFIG.qmdEmbedTimeoutMs,
      maxSourceCopyBytes:
        Number.isFinite(config.ingest?.maxSourceCopyBytes) && (config.ingest?.maxSourceCopyBytes ?? -1) >= 0
          ? config.ingest?.maxSourceCopyBytes ?? DEFAULT_INGEST_CONFIG.maxSourceCopyBytes
          : DEFAULT_INGEST_CONFIG.maxSourceCopyBytes,
      maxExtractedCharsInMemory:
        Number.isFinite(config.ingest?.maxExtractedCharsInMemory) && (config.ingest?.maxExtractedCharsInMemory ?? -1) >= 0
          ? config.ingest?.maxExtractedCharsInMemory ?? DEFAULT_INGEST_CONFIG.maxExtractedCharsInMemory
          : DEFAULT_INGEST_CONFIG.maxExtractedCharsInMemory,
      videoFrameIntervalSec:
        Number.isFinite(config.ingest?.videoFrameIntervalSec) && (config.ingest?.videoFrameIntervalSec ?? 0) > 0
          ? config.ingest?.videoFrameIntervalSec ?? DEFAULT_INGEST_CONFIG.videoFrameIntervalSec
          : DEFAULT_INGEST_CONFIG.videoFrameIntervalSec,
      maxVideoFrames:
        Number.isFinite(config.ingest?.maxVideoFrames) && (config.ingest?.maxVideoFrames ?? -1) >= 0
          ? config.ingest?.maxVideoFrames ?? DEFAULT_INGEST_CONFIG.maxVideoFrames
          : DEFAULT_INGEST_CONFIG.maxVideoFrames,
      doclingImageExportMode: DOCLING_IMAGE_EXPORT_MODES.includes(config.ingest?.doclingImageExportMode as DoclingImageExportMode)
        ? (config.ingest?.doclingImageExportMode as DoclingImageExportMode)
        : DEFAULT_INGEST_CONFIG.doclingImageExportMode,
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
      message?.role === "toolResult" &&
      ["memory_propose_write", "memory_write", "memory_record_decision", "memory_ingest_source"].includes(String(message?.toolName || "")),
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
    `Docling command: ${state.config?.ingest.doclingCommand || DEFAULT_INGEST_CONFIG.doclingCommand}`,
    `FFmpeg command: ${state.config?.ingest.ffmpegCommand || DEFAULT_INGEST_CONFIG.ffmpegCommand}`,
    `Media ingest QMD sync: ${state.config?.ingest.qmdSyncAfterIngest ? "on" : "off"}`,
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

type MemoryIngestParams = {
  source: string;
  kind?: IngestKindInput;
  title?: string;
  project?: string;
  tags?: string[];
  copySource?: boolean;
  refreshIndex?: boolean;
  targetPath?: string;
};

type SourceCopyResult = {
  path?: string;
  bytes?: number;
  sha256?: string;
  skippedReason?: string;
};

type DoclingConversionResult = {
  markdown: string;
  outputFiles: string[];
  stderr?: string;
};

type MemoryIngestResult = {
  source: string;
  kind: IngestKind;
  title: string;
  project: string;
  memoryPath: string;
  sourceDir: string;
  copiedSource?: SourceCopyResult;
  derivedPaths: string[];
  framePaths: string[];
  warnings: string[];
  qmdRefreshed: boolean;
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mpeg", ".mpg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".opus", ".webm"]);

function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

async function runConfiguredCommand(
  pi: ExtensionAPI,
  commandLine: string,
  args: string[],
  options: { timeout?: number; signal?: AbortSignal } = {},
) {
  const parts = splitCommandLine(commandLine || "");
  const command = parts[0] || commandLine;
  const prefixArgs = parts.slice(1);
  if (!command) throw new Error("Missing command.");
  return pi.exec(command, [...prefixArgs, ...args], options);
}

function safeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "source";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function titleFromSource(source: string): string {
  try {
    if (isHttpUrl(source)) {
      const url = new URL(source);
      const decodedName = decodeURIComponent(basename(url.pathname || ""));
      const withoutExt = decodedName ? decodedName.replace(/\.[^.]+$/, "") : url.hostname;
      return withoutExt.replace(/[\-_]+/g, " ").trim() || url.hostname || "media source";
    }
  } catch {
    // fall through to local path handling
  }

  const normalized = normalizePathArg(source);
  const name = basename(normalized).replace(/\.[^.]+$/, "");
  return name.replace(/[\-_]+/g, " ").trim() || "media source";
}

function resolveLocalSourcePath(source: string): string {
  const normalized = normalizePathArg(source.trim());
  if (normalized.startsWith("file://")) {
    const url = new URL(normalized);
    return decodeURIComponent(url.pathname);
  }
  return resolve(expandHome(normalized));
}

function extensionFromContentType(contentType?: string): string | undefined {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "application/pdf":
      return ".pdf";
    case "text/markdown":
      return ".md";
    case "text/html":
      return ".html";
    default:
      return undefined;
  }
}

function inferSourceExtension(source: string, contentType?: string): string {
  let candidate = source;
  try {
    if (isHttpUrl(source)) candidate = new URL(source).pathname;
  } catch {
    // keep raw candidate
  }

  const ext = extname(candidate).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
  return extensionFromContentType(contentType) || ".bin";
}

function inferIngestKind(source: string, requested?: IngestKindInput): IngestKind {
  if (requested && requested !== "auto") return requested;
  const ext = inferSourceExtension(source);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "document";
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

async function writeVaultSourceFile(config: MemoryConfig, inputPath: string, content: string | Buffer) {
  const { absolutePath, relativePath } = resolveVaultFile(config, inputPath);
  if (!relativePath.startsWith("sources/")) {
    throw new Error(`Source writes are restricted to sources/: ${relativePath}`);
  }

  await withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  });
}

async function copyVaultSourceFile(config: MemoryConfig, sourcePath: string, inputPath: string) {
  const { absolutePath, relativePath } = resolveVaultFile(config, inputPath);
  if (!relativePath.startsWith("sources/")) {
    throw new Error(`Source writes are restricted to sources/: ${relativePath}`);
  }

  await withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    await copyFile(sourcePath, absolutePath);
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`download timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function copyOriginalSourceToVault(
  config: MemoryConfig,
  params: { source: string; conversionSource: string; kind: IngestKind; sourceDir: string; copySource?: boolean; signal?: AbortSignal },
): Promise<SourceCopyResult> {
  const shouldCopy = params.copySource ?? (params.kind !== "video" && params.kind !== "audio");
  if (!shouldCopy) return { skippedReason: params.kind === "video" ? "video raw source is referenced, not copied by default" : "copySource=false" };

  const maxBytes = config.ingest.maxSourceCopyBytes;
  if (maxBytes <= 0) return { skippedReason: "raw source copying disabled by maxSourceCopyBytes=0" };

  if (isHttpUrl(params.source)) {
    const response = await fetchWithTimeout(params.source, config.ingest.doclingTimeoutMs, params.signal);
    if (!response.ok) return { skippedReason: `download failed with HTTP ${response.status}` };

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > maxBytes) return { skippedReason: `remote source is ${contentLength} bytes, above ${maxBytes} byte copy limit` };

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return { skippedReason: `remote source is ${buffer.byteLength} bytes, above ${maxBytes} byte copy limit` };

    const ext = inferSourceExtension(params.source, response.headers.get("content-type") || undefined);
    const targetPath = `${params.sourceDir}/original${ext}`;
    await writeVaultSourceFile(config, targetPath, buffer);
    return { path: targetPath, bytes: buffer.byteLength, sha256: sha256Buffer(buffer) };
  }

  const info = await stat(params.conversionSource);
  if (!info.isFile()) return { skippedReason: "local source is not a regular file" };
  if (info.size > maxBytes) return { skippedReason: `local source is ${info.size} bytes, above ${maxBytes} byte copy limit` };

  const targetPath = `${params.sourceDir}/original${inferSourceExtension(params.conversionSource)}`;
  await copyVaultSourceFile(config, params.conversionSource, targetPath);
  return { path: targetPath, bytes: info.size, sha256: await sha256File(params.conversionSource) };
}

async function readMarkdownOutputs(root: string): Promise<{ markdown: string; files: string[] }> {
  const files = (await collectMarkdownFiles(root)).sort();
  if (files.length === 0) return { markdown: "", files: [] };
  const parts: string[] = [];
  for (const file of files) {
    const content = (await readFile(file, "utf8")).trim();
    if (!content) continue;
    if (files.length === 1) {
      parts.push(content);
    } else {
      parts.push(`## ${basename(file, ".md")}\n\n${content}`);
    }
  }
  return { markdown: parts.join("\n\n---\n\n"), files };
}

function doclingArgsForKind(kind: IngestKind): string[] {
  if (kind === "image") return ["--from", "image"];
  if (kind === "audio") return ["--from", "audio", "--pipeline", "asr"];
  if (kind === "video") return ["--pipeline", "asr"];
  return [];
}

function cleanDoclingStderr(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.includes("An executable named `docling` is not provided by package `docling`"));
  const cleaned = lines.join("\n").trim();
  return cleaned || undefined;
}

async function runDoclingConversion(
  pi: ExtensionAPI,
  config: MemoryConfig,
  source: string,
  kind: IngestKind,
  tempRoot: string,
  signal?: AbortSignal,
): Promise<DoclingConversionResult> {
  const outputDir = await mkdtemp(join(tempRoot, "docling-"));
  const timeoutSeconds = Math.max(1, Math.ceil(config.ingest.doclingTimeoutMs / 1000));
  const args = [
    source,
    ...doclingArgsForKind(kind),
    "--to",
    "md",
    "--output",
    outputDir,
    "--image-export-mode",
    config.ingest.doclingImageExportMode,
    "--document-timeout",
    String(timeoutSeconds),
  ];

  const result = await runConfiguredCommand(pi, config.ingest.doclingCommand, args, { timeout: config.ingest.doclingTimeoutMs, signal });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `docling exited with code ${result.code}`).trim());
  }

  const { markdown, files } = await readMarkdownOutputs(outputDir);
  const stdoutMarkdown = result.stdout.trim();
  const outputMarkdown = markdown || stdoutMarkdown;
  if (!outputMarkdown) throw new Error("docling completed but produced no markdown output.");
  return { markdown: outputMarkdown, outputFiles: files, stderr: cleanDoclingStderr(result.stderr) };
}

async function extractVideoFrames(
  pi: ExtensionAPI,
  config: MemoryConfig,
  source: string,
  tempRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (config.ingest.maxVideoFrames <= 0) return [];

  const framesDir = join(tempRoot, "frames");
  await mkdir(framesDir, { recursive: true });
  const pattern = join(framesDir, "frame-%03d.png");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    "-vf",
    `fps=1/${config.ingest.videoFrameIntervalSec}`,
    "-frames:v",
    String(config.ingest.maxVideoFrames),
    pattern,
  ];
  const result = await runConfiguredCommand(pi, config.ingest.ffmpegCommand, args, { timeout: config.ingest.ffmpegTimeoutMs, signal });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `ffmpeg exited with code ${result.code}`).trim());
  }

  const entries = await readdir(framesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => join(framesDir, entry.name))
    .sort();
}

async function copyFrameFilesToSources(config: MemoryConfig, frameFiles: string[], sourceDir: string): Promise<string[]> {
  const copied: string[] = [];
  for (const frameFile of frameFiles) {
    const targetPath = `${sourceDir}/frames/${basename(frameFile)}`;
    await copyVaultSourceFile(config, frameFile, targetPath);
    copied.push(targetPath);
  }
  return copied;
}

async function persistDerivedMarkdown(config: MemoryConfig, sourceDir: string, fileName: string, markdown: string): Promise<string | undefined> {
  const trimmed = markdown.trim();
  if (!trimmed) return undefined;
  const path = `${sourceDir}/${fileName}`;
  await writeVaultSourceFile(config, path, trimmed + "\n");
  return path;
}

function limitExtractedMarkdown(markdown: string, maxChars: number): { content: string; truncated: boolean } {
  const trimmed = markdown.trim();
  if (!trimmed) return { content: "_No extracted text was produced._", truncated: false };
  if (maxChars <= 0) return { content: "_Extracted markdown was stored under sources/ and omitted from this memory note by configuration._", truncated: true };
  if (trimmed.length <= maxChars) return { content: trimmed, truncated: false };
  return {
    content: `${trimmed.slice(0, maxChars).trimEnd()}\n\n_Extraction truncated in memory note after ${maxChars} characters; see sources/ for full markdown._`,
    truncated: true,
  };
}

function buildIngestMemoryNote(params: {
  title: string;
  project: string;
  kind: IngestKind;
  source: string;
  sourceDir: string;
  copiedSource?: SourceCopyResult;
  derivedPaths: string[];
  framePaths: string[];
  extractedMarkdown: string;
  tags: string[];
  warnings: string[];
  ingestedAt: string;
  maxExtractedChars: number;
}): string {
  const date = params.ingestedAt.slice(0, 10);
  const limited = limitExtractedMarkdown(params.extractedMarkdown, params.maxExtractedChars);
  const tags = [...new Set(["memory-ingest", "media-ingest", params.kind, ...params.tags.map(safeSlug)].filter(Boolean))];
  const frontmatter = [
    "---",
    "type: source_ingest",
    "scope: project",
    `project: ${yamlString(params.project)}`,
    "relevance: medium",
    `source_kind: ${params.kind}`,
    `source_uri: ${yamlString(params.source)}`,
    `source_dir: ${yamlString(params.sourceDir)}`,
    params.copiedSource?.path ? `source_stored: ${yamlString(params.copiedSource.path)}` : undefined,
    params.derivedPaths.length > 0 ? `derived_markdown: ${yamlString(params.derivedPaths[0])}` : undefined,
    `ingested_at: ${yamlString(params.ingestedAt)}`,
    `last_reviewed: ${date}`,
    "tags:",
    ...tags.map((tag) => `  - ${tag}`),
    "---",
  ].filter(Boolean) as string[];

  const provenance = [
    `- Source: ${params.source}`,
    `- Kind: ${params.kind}`,
    `- Source directory: \`${params.sourceDir}\``,
    params.copiedSource?.path ? `- Copied source: \`${params.copiedSource.path}\`` : `- Copied source: ${params.copiedSource?.skippedReason || "not copied"}`,
    params.copiedSource?.bytes !== undefined ? `- Copied bytes: ${params.copiedSource.bytes}` : undefined,
    params.copiedSource?.sha256 ? `- SHA-256: \`${params.copiedSource.sha256}\`` : undefined,
    params.derivedPaths.length > 0 ? `- Derived markdown: ${params.derivedPaths.map((path) => `\`${path}\``).join(", ")}` : undefined,
    params.framePaths.length > 0 ? `- Sampled frames: ${params.framePaths.length} frame(s) under \`${params.sourceDir}/frames/\`` : undefined,
    limited.truncated ? "- Memory note extraction: truncated; full derived markdown is in sources/." : undefined,
  ].filter(Boolean) as string[];

  const lines = [
    ...frontmatter,
    `# ${params.title}`,
    "",
    "## Summary",
    "",
    `Automated Docling ingest for a ${params.kind} source. This note was written directly so the extracted material can participate in memory search and later audits can merge, deduplicate, or clean up overlap.`,
    "",
    "## Provenance",
    "",
    ...provenance,
  ];

  if (params.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...params.warnings.map((warning) => `- ${warning}`));
  }

  lines.push("", "## Extracted content", "", limited.content, "");
  return lines.join("\n");
}

async function refreshQmdAfterIngest(pi: ExtensionAPI, config: MemoryConfig, signal?: AbortSignal): Promise<string[]> {
  const warnings: string[] = [];
  const update = await runConfiguredCommand(pi, config.qmdCommand, ["update"], { timeout: config.ingest.qmdUpdateTimeoutMs, signal });
  if (update.code !== 0) {
    warnings.push(`qmd update failed: ${(update.stderr || update.stdout || `exit ${update.code}`).trim()}`);
    return warnings;
  }

  const embed = await runConfiguredCommand(
    pi,
    config.qmdCommand,
    ["embed", "--max-docs-per-batch", "32", "--max-batch-mb", "8"],
    { timeout: config.ingest.qmdEmbedTimeoutMs, signal },
  );
  if (embed.code !== 0) {
    warnings.push(`qmd embed failed: ${(embed.stderr || embed.stdout || `exit ${embed.code}`).trim()}`);
  }
  return warnings;
}

function renderIngestResult(result: MemoryIngestResult): string {
  const lines = [
    `Ingested ${result.kind}: ${result.title}`,
    `Memory note: ${result.memoryPath}`,
    `Source directory: ${result.sourceDir}`,
    result.copiedSource?.path ? `Copied source: ${result.copiedSource.path}` : undefined,
    result.derivedPaths.length > 0 ? `Derived markdown: ${result.derivedPaths.join(", ")}` : undefined,
    result.framePaths.length > 0 ? `Frames: ${result.framePaths.length}` : undefined,
    `QMD refreshed: ${result.qmdRefreshed ? "yes" : "no"}`,
  ].filter(Boolean) as string[];
  if (result.warnings.length > 0) lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}

async function ingestMemorySource(
  pi: ExtensionAPI,
  config: MemoryConfig,
  runtimeProject: string | undefined,
  params: MemoryIngestParams,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<MemoryIngestResult> {
  const source = normalizePathArg(params.source || "").trim();
  if (!source) throw new Error("memory_ingest_source requires a source path or URL.");
  const isUrl = isHttpUrl(source);
  if (!isUrl && /^[a-z]+:\/\//i.test(source) && !source.startsWith("file://")) {
    throw new Error("Only local paths, file:// URLs, and http(s) URLs are supported for source ingest.");
  }

  const conversionSource = isUrl ? source : resolveLocalSourcePath(source);
  if (!isUrl) {
    const info = await stat(conversionSource);
    if (!info.isFile()) throw new Error(`Local source is not a regular file: ${conversionSource}`);
  }

  const kind = inferIngestKind(source, params.kind);
  const project = safeSlug(params.project || runtimeProject || "unknown");
  const title = (params.title || titleFromSource(source)).replace(/\s+/g, " ").trim() || "Media source";
  const slug = safeSlug(title);
  const ingestedAt = new Date().toISOString();
  const date = ingestedAt.slice(0, 10);
  const ingestId = `${ingestedAt.slice(0, 19).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const sourceDir = `sources/media/${project}/${date}/${ingestId}-${slug}`;
  const memoryPath = normalizeVaultRelativePath(params.targetPath || `memory/projects/${project}/ingests/${ingestId}-${slug}.md`);
  const warnings: string[] = [];
  const derivedPaths: string[] = [];
  let framePaths: string[] = [];
  const extractedSections: string[] = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "obsidian-memory-ingest-"));

  try {
    onProgress?.("copying source provenance…");
    let copiedSource: SourceCopyResult | undefined;
    try {
      copiedSource = await copyOriginalSourceToVault(config, {
        source,
        conversionSource,
        kind,
        sourceDir,
        copySource: params.copySource,
        signal,
      });
      if (copiedSource.skippedReason) warnings.push(`Raw source not copied: ${copiedSource.skippedReason}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Raw source copy failed: ${message}`);
      copiedSource = { skippedReason: message };
    }

    if (kind === "video") {
      onProgress?.("running Docling ASR on video…");
      try {
        const transcript = await runDoclingConversion(pi, config, conversionSource, "video", tempRoot, signal);
        extractedSections.push(`# Transcript\n\n${transcript.markdown.trim()}`);
        const transcriptPath = await persistDerivedMarkdown(config, sourceDir, "transcript.md", transcript.markdown);
        if (transcriptPath) derivedPaths.push(transcriptPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Docling ASR for video failed: ${message}`);
      }

      onProgress?.("sampling video frames with ffmpeg…");
      try {
        const frameFiles = await extractVideoFrames(pi, config, conversionSource, tempRoot, signal);
        framePaths = await copyFrameFilesToSources(config, frameFiles, sourceDir);
        if (frameFiles.length > 0) {
          onProgress?.("running Docling OCR on sampled frames…");
          const frameMarkdown = await runDoclingConversion(pi, config, dirname(frameFiles[0]), "image", tempRoot, signal);
          extractedSections.push(`# Sampled frame OCR\n\n${frameMarkdown.markdown.trim()}`);
          const framesMarkdownPath = await persistDerivedMarkdown(config, sourceDir, "frames.md", frameMarkdown.markdown);
          if (framesMarkdownPath) derivedPaths.push(framesMarkdownPath);
        } else {
          warnings.push("ffmpeg produced no sampled frames.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Video frame extraction/OCR failed: ${message}`);
      }

      if (extractedSections.length === 0) {
        throw new Error(`Video ingest produced no extracted text. ${warnings.join(" ")}`.trim());
      }
    } else {
      onProgress?.("running Docling conversion…");
      const conversion = await runDoclingConversion(pi, config, conversionSource, kind, tempRoot, signal);
      extractedSections.push(conversion.markdown.trim());
      const derivedPath = await persistDerivedMarkdown(config, sourceDir, "docling.md", conversion.markdown);
      if (derivedPath) derivedPaths.push(derivedPath);
      if (conversion.stderr) warnings.push(`Docling stderr: ${truncateText(conversion.stderr, 500)}`);
    }

    const extractedMarkdown = extractedSections.join("\n\n---\n\n");
    if (kind === "video") {
      const combinedPath = await persistDerivedMarkdown(config, sourceDir, "docling.md", extractedMarkdown);
      if (combinedPath && !derivedPaths.includes(combinedPath)) derivedPaths.unshift(combinedPath);
    }

    onProgress?.("writing memory note…");
    const note = buildIngestMemoryNote({
      title,
      project,
      kind,
      source,
      sourceDir,
      copiedSource,
      derivedPaths,
      framePaths,
      extractedMarkdown,
      tags: params.tags || [],
      warnings,
      ingestedAt,
      maxExtractedChars: config.ingest.maxExtractedCharsInMemory,
    });
    await writeVaultFile(config, memoryPath, note, false);

    const logEntry = [
      `\n## [${ingestedAt.slice(0, 16).replace("T", " ")}] source-ingest | ${title}`,
      "",
      `- Kind: ${kind}`,
      `- Source: ${source}`,
      `- Memory note: [[${memoryPath.replace(/^memory\//, "").replace(/\.md$/i, "")}]]`,
      `- Source directory: ${sourceDir}`,
      "",
    ].join("\n");
    await writeVaultFile(config, "memory/log.md", logEntry, true);

    let qmdRefreshed = false;
    const shouldRefresh = params.refreshIndex ?? config.ingest.qmdSyncAfterIngest;
    if (shouldRefresh) {
      onProgress?.("refreshing QMD index…");
      try {
        const qmdWarnings = await refreshQmdAfterIngest(pi, config, signal);
        warnings.push(...qmdWarnings);
        qmdRefreshed = qmdWarnings.length === 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`QMD refresh failed: ${message}`);
      }
    }

    return {
      source,
      kind,
      title,
      project,
      memoryPath,
      sourceDir,
      copiedSource,
      derivedPaths,
      framePaths,
      warnings,
      qmdRefreshed,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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
      systemPrompt += `\n\nExplicit memory request detected for this turn. Before finishing, create a durable memory artifact. If the request provides a local path or URL to an image, video, document, or other source, prefer memory_ingest_source. Otherwise prefer memory_propose_write over memory_write unless the user explicitly asked for an immediate write. Suggested target: ${pendingMemoryIntent.targetPath}. If the request is clearly a durable project decision with title, summary, and rationale, prefer memory_record_decision.`;
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

  pi.registerTool({
    name: "memory_ingest_source",
    label: "Memory Ingest Source",
    description: "Ingest a local path or URL with Docling, store source provenance, write a memory note, and refresh QMD.",
    promptSnippet: "Ingest images, videos, documents, or URLs into the Obsidian memory base using Docling.",
    promptGuidelines: [
      "Use memory_ingest_source when the user provides a local path or URL that should contribute to long-term memory.",
      "memory_ingest_source writes directly to memory/ and stores raw or derived source artifacts under sources/; do not call memory_propose_write for the same source.",
      "For video inputs, memory_ingest_source attempts Docling ASR plus ffmpeg frame sampling and OCR.",
    ],
    parameters: MEMORY_INGEST_SOURCE_SCHEMA,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWithMemoryActivity(
        ctx,
        `memory: ingesting ${formatMemoryTarget(params.source)}`,
        "memory: ingest complete",
        "memory: ingest failed",
        async () => {
          if (!runtimeState.ready || !runtimeState.config) {
            throw new Error("Memory system is not configured.");
          }

          const result = await ingestMemorySource(pi, runtimeState.config, runtimeState.project, params, signal, (message) => {
            onUpdate?.({ content: [{ type: "text", text: message }] });
          });
          return {
            content: [{ type: "text", text: renderIngestResult(result) }],
            details: result,
          };
        },
      );
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

  pi.registerCommand("memory-ingest", {
    description: "Ingest a local path or URL into memory with Docling: /memory-ingest [--kind image|video|audio|document] [--copy|--no-copy] [--no-refresh] <path-or-url> [title]",
    handler: async (args, ctx) => {
      const parts = splitCommandLine(args.trim());
      const positional: string[] = [];
      let kind: IngestKindInput | undefined;
      let copySource: boolean | undefined;
      let refreshIndex: boolean | undefined;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (part === "--kind") {
          const value = parts[++index] as IngestKindInput | undefined;
          if (!value || !INGEST_KINDS.includes(value)) {
            ctx.ui.notify(`Invalid --kind. Expected one of: ${INGEST_KINDS.join(", ")}`, "warning");
            return;
          }
          kind = value;
          continue;
        }
        if (part === "--copy") {
          copySource = true;
          continue;
        }
        if (part === "--no-copy") {
          copySource = false;
          continue;
        }
        if (part === "--no-refresh") {
          refreshIndex = false;
          continue;
        }
        positional.push(part);
      }

      const source = positional[0];
      const title = positional.slice(1).join(" ").trim() || undefined;
      if (!source) {
        ctx.ui.notify("Usage: /memory-ingest [--kind image|video|audio|document] [--copy|--no-copy] [--no-refresh] <path-or-url> [title]", "warning");
        return;
      }

      runtimeState = await refreshRuntimeState(pi, ctx, runtimeState);
      reviewQueue = await loadReviewQueue();
      updateUi(ctx);
      if (!runtimeState.ready || !runtimeState.config) {
        ctx.ui.notify("Memory system is not configured.", "error");
        return;
      }

      try {
        const result = await runWithMemoryActivity(
          ctx,
          `memory: ingesting ${formatMemoryTarget(source)}`,
          "memory: ingest complete",
          "memory: ingest failed",
          () => ingestMemorySource(pi, runtimeState.config as MemoryConfig, runtimeState.project, { source, title, kind, copySource, refreshIndex }),
        );
        ctx.ui.notify(renderIngestResult(result), result.warnings.length > 0 ? "warning" : "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`memory-ingest failed: ${message}`, "error");
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
