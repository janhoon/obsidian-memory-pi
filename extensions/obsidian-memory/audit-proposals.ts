/**
 * Convert high-signal Audit findings into reviewable Proposal drafts.
 *
 * Default Audit remains report-only; enqueue is opt-in.
 * Source tag for metrics: `audit`.
 *
 * Domain: Audit, Audit finding, Proposal, Review queue, Apply, Discard.
 */

export type AuditFindingKind = "broken_link" | "stale" | "orphan" | "duplicate_title" | "duplicate_body" | "contradiction";

export type AuditSummaryLike = {
  scope: string;
  project?: string;
  scannedFiles: number;
  staleFiles: Array<{ path: string; daysOld: number }>;
  brokenLinks: Array<{ source: string; target: string }>;
  orphanCandidates: string[];
  duplicateTitles: Array<{ title: string; paths: string[] }>;
  exactDuplicateBodies: string[][];
  contradictionCandidates: Array<{ paths: string[]; reason: string }>;
};

export type AuditProposalDraft = {
  sourceTag: "audit";
  findingKind: AuditFindingKind;
  /** Vault-relative path to append a remediation note (Proposal content, not auto-fixed). */
  targetPath: string;
  title: string;
  rationale: string;
  content: string;
  action: "append_file";
};

export type PlanAuditProposalsOptions = {
  /** Max Proposals to enqueue from one Audit pass. */
  maxProposals?: number;
  /** Only enqueue findings of these kinds (default: high-signal set). */
  kinds?: readonly AuditFindingKind[];
  project?: string;
};

const DEFAULT_HIGH_SIGNAL_KINDS: readonly AuditFindingKind[] = [
  "broken_link",
  "stale",
  "contradiction",
  "duplicate_body",
];

/**
 * Plan reviewable Proposals for high-signal Audit findings.
 * Content is a remediation checklist the human can Apply (append to a Note) or Discard —
 * not an automatic wiki rewrite of the broken link graph.
 */
export function planAuditProposals(
  summary: AuditSummaryLike,
  options: PlanAuditProposalsOptions = {},
): AuditProposalDraft[] {
  const max = Math.max(0, options.maxProposals ?? 5);
  if (max === 0) return [];

  const kinds = new Set(options.kinds || DEFAULT_HIGH_SIGNAL_KINDS);
  const project = options.project || summary.project;
  const drafts: AuditProposalDraft[] = [];
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

  const push = (draft: AuditProposalDraft) => {
    if (drafts.length >= max) return;
    drafts.push(draft);
  };

  if (kinds.has("broken_link")) {
    for (const item of summary.brokenLinks) {
      if (drafts.length >= max) break;
      push({
        sourceTag: "audit",
        findingKind: "broken_link",
        targetPath: item.source.startsWith("memory/") ? item.source : `memory/${item.source}`,
        title: "audit-broken-link",
        rationale: `Audit finding: broken wikilink [[${item.target}]] in ${item.source}. Review and fix or remove the link.`,
        action: "append_file",
        content: [
          `\n## [${stamp}] audit finding: broken wikilink`,
          "",
          `- Source Note: \`${item.source}\``,
          `- Missing target: \`[[${item.target}]]\``,
          `- Scope: ${summary.scope}${project ? ` (${project})` : ""}`,
          "",
          "Suggested actions: create the missing Note, retarget the wikilink, or remove the dead link.",
          "_Queued by Audit enqueue — review before Apply._",
          "",
        ].join("\n"),
      });
    }
  }

  if (kinds.has("stale")) {
    // Prefer most stale first (summary already sorts that way from runAudit).
    for (const item of summary.staleFiles) {
      if (drafts.length >= max) break;
      const path = item.path.startsWith("memory/") ? item.path : `memory/${item.path}`;
      push({
        sourceTag: "audit",
        findingKind: "stale",
        targetPath: path,
        title: "audit-stale-note",
        rationale: `Audit finding: stale Note ${item.path} (${item.daysOld} days since last_reviewed). Refresh or archive.`,
        action: "append_file",
        content: [
          `\n## [${stamp}] audit finding: stale Note`,
          "",
          `- Path: \`${item.path}\``,
          `- Days since last_reviewed: ${item.daysOld}`,
          "",
          "Suggested actions: update content and `last_reviewed`, or mark superseded/archived.",
          "_Queued by Audit enqueue — review before Apply._",
          "",
        ].join("\n"),
      });
    }
  }

  if (kinds.has("contradiction")) {
    for (const item of summary.contradictionCandidates) {
      if (drafts.length >= max) break;
      const primary = item.paths[0] || "memory/working-context.md";
      const path = primary.startsWith("memory/") ? primary : `memory/${primary}`;
      push({
        sourceTag: "audit",
        findingKind: "contradiction",
        targetPath: path,
        title: "audit-contradiction",
        rationale: `Audit finding: potential contradiction (${item.reason}) among ${item.paths.join(", ")}.`,
        action: "append_file",
        content: [
          `\n## [${stamp}] audit finding: potential contradiction`,
          "",
          `- Reason: ${item.reason}`,
          `- Notes: ${item.paths.map((p) => `\`${p}\``).join(", ")}`,
          "",
          "Suggested actions: reconcile facts, supersede an old Decision, or clarify status.",
          "_Queued by Audit enqueue — review before Apply._",
          "",
        ].join("\n"),
      });
    }
  }

  if (kinds.has("duplicate_body")) {
    for (const paths of summary.exactDuplicateBodies) {
      if (drafts.length >= max) break;
      const primary = paths[0] || "memory/working-context.md";
      const path = primary.startsWith("memory/") ? primary : `memory/${primary}`;
      push({
        sourceTag: "audit",
        findingKind: "duplicate_body",
        targetPath: path,
        title: "audit-duplicate-body",
        rationale: `Audit finding: exact duplicate bodies: ${paths.join(", ")}.`,
        action: "append_file",
        content: [
          `\n## [${stamp}] audit finding: exact duplicate bodies`,
          "",
          `- Notes: ${paths.map((p) => `\`${p}\``).join(", ")}`,
          "",
          "Suggested actions: merge into one Note and leave a stub/pointer, or delete the duplicate via a separate Proposal.",
          "_Queued by Audit enqueue — review before Apply. Destructive cleanup stays proposal-only._",
          "",
        ].join("\n"),
      });
    }
  }

  if (kinds.has("orphan")) {
    for (const orphanPath of summary.orphanCandidates) {
      if (drafts.length >= max) break;
      const path = orphanPath.startsWith("memory/") ? orphanPath : `memory/${orphanPath}`;
      push({
        sourceTag: "audit",
        findingKind: "orphan",
        targetPath: path,
        title: "audit-orphan",
        rationale: `Audit finding: orphan candidate ${orphanPath} (no inbound/outbound wikilinks).`,
        action: "append_file",
        content: [
          `\n## [${stamp}] audit finding: orphan candidate`,
          "",
          `- Path: \`${orphanPath}\``,
          "",
          "Suggested actions: link from index/router Notes, or archive if obsolete.",
          "_Queued by Audit enqueue — review before Apply._",
          "",
        ].join("\n"),
      });
    }
  }

  if (kinds.has("duplicate_title")) {
    for (const item of summary.duplicateTitles) {
      if (drafts.length >= max) break;
      const primary = item.paths[0] || "memory/working-context.md";
      const path = primary.startsWith("memory/") ? primary : `memory/${primary}`;
      push({
        sourceTag: "audit",
        findingKind: "duplicate_title",
        targetPath: path,
        title: "audit-duplicate-title",
        rationale: `Audit finding: duplicate title "${item.title}" on ${item.paths.join(", ")}.`,
        action: "append_file",
        content: [
          `\n## [${stamp}] audit finding: duplicate title`,
          "",
          `- Title: ${item.title}`,
          `- Notes: ${item.paths.map((p) => `\`${p}\``).join(", ")}`,
          "",
          "Suggested actions: rename for disambiguation or merge.",
          "_Queued by Audit enqueue — review before Apply._",
          "",
        ].join("\n"),
      });
    }
  }

  return drafts;
}

/** Compact operator summary lines (core pack, review queue, QMD, automation age). */
export function formatMemoryOperatorSummary(input: {
  ready: boolean;
  project?: string;
  configPath?: string;
  vaultPath?: string;
  corePack?: {
    enabled: boolean;
    loadedCount?: number;
    expectedCount?: number;
    truncated?: boolean;
    injected?: boolean;
    missingPaths?: string[];
  };
  pendingProposalCount: number;
  qmd?: {
    enabled?: boolean;
    dirty?: boolean;
    syncing?: boolean;
    lastError?: string;
    dirtyAgeMs?: number;
  };
  metrics?: {
    lastExtractAt?: string;
    lastAutoRecallAt?: string;
    lastQmdSyncAt?: string;
    lastDreamAt?: string;
  };
  keyNotes?: Array<{ path: string; present: boolean }>;
}): string {
  const lines: string[] = [
    "Memory operator summary",
    `Ready: ${input.ready ? "yes" : "no"}`,
    `Project: ${input.project || "unknown"}`,
  ];
  if (input.configPath) lines.push(`Config: ${input.configPath}`);
  if (input.vaultPath) lines.push(`Vault: ${input.vaultPath}`);

  if (input.corePack) {
    if (!input.corePack.enabled) {
      lines.push("Core pack: off");
    } else if (input.corePack.loadedCount === undefined) {
      lines.push("Core pack: enabled (not loaded yet)");
    } else {
      const exp = input.corePack.expectedCount ?? "?";
      lines.push(
        `Core pack: ${input.corePack.loadedCount}/${exp} notes` +
          (input.corePack.truncated ? " (truncated)" : "") +
          (input.corePack.injected ? ", injected" : ", pending inject"),
      );
      if (input.corePack.missingPaths?.length) {
        lines.push(`  Missing: ${input.corePack.missingPaths.join(", ")}`);
      }
    }
  }

  if (input.keyNotes?.length) {
    lines.push("Key Notes:");
    for (const note of input.keyNotes) {
      lines.push(`  · ${note.path}: ${note.present ? "present" : "missing"}`);
    }
  }

  lines.push(`Pending Proposals: ${input.pendingProposalCount}`);

  if (input.qmd) {
    const state = input.qmd.syncing
      ? "syncing"
      : input.qmd.lastError
        ? `error (${input.qmd.lastError})`
        : input.qmd.dirty
          ? "stale"
          : input.qmd.enabled === false
            ? "auto-sync off"
            : "ready";
    const lag =
      input.qmd.dirty && typeof input.qmd.dirtyAgeMs === "number"
        ? ` · dirty ${Math.round(input.qmd.dirtyAgeMs / 1000)}s`
        : "";
    lines.push(`QMD: ${state}${lag}`);
  }

  if (input.metrics) {
    lines.push("Recent automation:");
    lines.push(`  · last extract: ${input.metrics.lastExtractAt || "n/a"}`);
    lines.push(`  · last auto-recall: ${input.metrics.lastAutoRecallAt || "n/a"}`);
    lines.push(`  · last QMD sync: ${input.metrics.lastQmdSyncAt || "n/a"}`);
    lines.push(`  · last dream: ${input.metrics.lastDreamAt || "n/a"}`);
  }

  return lines.join("\n");
}

/** Pull latest timestamps by kind from metric events (for operator summary). */
export function latestMetricTimestamps(
  events: ReadonlyArray<{ kind: string; at: string; source?: string }>,
): {
  lastExtractAt?: string;
  lastAutoRecallAt?: string;
  lastQmdSyncAt?: string;
  lastDreamAt?: string;
} {
  let lastExtractAt: string | undefined;
  let lastAutoRecallAt: string | undefined;
  let lastQmdSyncAt: string | undefined;
  let lastDreamAt: string | undefined;

  for (const event of events) {
    if (event.kind === "proposal_create" && event.source === "extract") {
      if (!lastExtractAt || event.at > lastExtractAt) lastExtractAt = event.at;
    }
    if (event.kind === "proposal_create" && event.source === "dream") {
      if (!lastDreamAt || event.at > lastDreamAt) lastDreamAt = event.at;
    }
    if (event.kind === "auto_recall") {
      if (!lastAutoRecallAt || event.at > lastAutoRecallAt) lastAutoRecallAt = event.at;
    }
    if (event.kind === "qmd_sync") {
      if (!lastQmdSyncAt || event.at > lastQmdSyncAt) lastQmdSyncAt = event.at;
    }
  }

  return { lastExtractAt, lastAutoRecallAt, lastQmdSyncAt, lastDreamAt };
}
