/**
 * Local, privacy-preserving Memory metrics (append-only).
 *
 * No network telemetry. Events live under the agent memory config area so
 * capture quality (Proposal apply/discard rates, Auto-recall hits, QMD lag)
 * can be tuned without guessing.
 *
 * Domain: Proposal, Apply, Discard, Auto-recall, Review queue.
 */

/** Known Proposal origin tags; unknown tags remain countable when they appear. */
export const KNOWN_PROPOSAL_SOURCES = [
  "explicit",
  "fallback",
  "extract",
  "dream",
  "audit",
  "assistant",
  "auto",
  "manual",
] as const;

export type KnownProposalSource = (typeof KNOWN_PROPOSAL_SOURCES)[number];

/** Free-form source tag so future extract/dream/audit values never break the schema. */
export type ProposalSourceTag = KnownProposalSource | (string & {});

export type ProposalMetricKind = "proposal_create" | "proposal_apply" | "proposal_discard";
export type AutoRecallMetricKind = "auto_recall";
export type QmdSyncMetricKind = "qmd_sync";

export type MetricEvent =
  | {
      kind: ProposalMetricKind;
      at: string;
      source: ProposalSourceTag;
      proposalId?: string;
      project?: string;
    }
  | {
      kind: AutoRecallMetricKind;
      at: string;
      hit: boolean;
      resultCount: number;
      project?: string;
      timedOut?: boolean;
      failed?: boolean;
    }
  | {
      kind: QmdSyncMetricKind;
      at: string;
      /** Milliseconds the index was dirty before this sync started (0 if unknown). */
      dirtyDurationMs: number;
      /** Wall time of the sync run itself. */
      syncDurationMs: number;
      ok: boolean;
      includeEmbed?: boolean;
    };

export type ProposalSourceRollup = {
  source: string;
  created: number;
  applied: number;
  discarded: number;
  /** applied / (applied + discarded); undefined when no terminal outcomes. */
  applyRate?: number;
  /** discarded / (applied + discarded); undefined when no terminal outcomes. */
  discardRate?: number;
};

export type MetricsSummary = {
  totalEvents: number;
  proposals: {
    bySource: ProposalSourceRollup[];
    created: number;
    applied: number;
    discarded: number;
  };
  autoRecall: {
    attempts: number;
    hits: number;
    misses: number;
    timeouts: number;
    failures: number;
    hitRate?: number;
  };
  qmdSync: {
    runs: number;
    failures: number;
    /** Average dirty lag in ms over successful samples with known dirtyDurationMs. */
    avgDirtyDurationMs?: number;
    maxDirtyDurationMs?: number;
    avgSyncDurationMs?: number;
  };
};

export function normalizeProposalSource(source: string | undefined | null): ProposalSourceTag {
  const raw = (source || "unknown").trim();
  return raw.length > 0 ? raw : "unknown";
}

/**
 * Map legacy / tool-facing proposal.source values onto metrics source tags.
 * - auto → fallback (auto-queued when explicit language was not persisted by tools)
 * - assistant → explicit (model called memory_propose_write)
 * - manual → manual
 * Future: extract / dream / audit pass through unchanged.
 */
export function mapProposalSourceToMetricTag(
  source: string | undefined,
  options?: { via?: "tool" | "auto_fallback" | "command" },
): ProposalSourceTag {
  if (options?.via === "auto_fallback") return "fallback";
  if (options?.via === "command") return "manual";
  const normalized = normalizeProposalSource(source);
  if (normalized === "auto") return "fallback";
  if (normalized === "assistant") return "explicit";
  return normalized;
}

export function createProposalCreateEvent(input: {
  source: ProposalSourceTag;
  proposalId?: string;
  project?: string;
  at?: string;
}): MetricEvent {
  return {
    kind: "proposal_create",
    at: input.at || new Date().toISOString(),
    source: normalizeProposalSource(input.source),
    proposalId: input.proposalId,
    project: input.project,
  };
}

export function createProposalApplyEvent(input: {
  source: ProposalSourceTag;
  proposalId?: string;
  project?: string;
  at?: string;
}): MetricEvent {
  return {
    kind: "proposal_apply",
    at: input.at || new Date().toISOString(),
    source: normalizeProposalSource(input.source),
    proposalId: input.proposalId,
    project: input.project,
  };
}

export function createProposalDiscardEvent(input: {
  source: ProposalSourceTag;
  proposalId?: string;
  project?: string;
  at?: string;
}): MetricEvent {
  return {
    kind: "proposal_discard",
    at: input.at || new Date().toISOString(),
    source: normalizeProposalSource(input.source),
    proposalId: input.proposalId,
    project: input.project,
  };
}

export function createAutoRecallEvent(input: {
  hit: boolean;
  resultCount: number;
  project?: string;
  timedOut?: boolean;
  failed?: boolean;
  at?: string;
}): MetricEvent {
  return {
    kind: "auto_recall",
    at: input.at || new Date().toISOString(),
    hit: Boolean(input.hit),
    resultCount: Math.max(0, Number(input.resultCount) || 0),
    project: input.project,
    timedOut: input.timedOut,
    failed: input.failed,
  };
}

export function createQmdSyncEvent(input: {
  dirtyDurationMs: number;
  syncDurationMs: number;
  ok: boolean;
  includeEmbed?: boolean;
  at?: string;
}): MetricEvent {
  return {
    kind: "qmd_sync",
    at: input.at || new Date().toISOString(),
    dirtyDurationMs: Math.max(0, Number(input.dirtyDurationMs) || 0),
    syncDurationMs: Math.max(0, Number(input.syncDurationMs) || 0),
    ok: Boolean(input.ok),
    includeEmbed: input.includeEmbed,
  };
}

function rate(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return numerator / denominator;
}

/**
 * Roll up an in-memory event list. Unknown proposal sources appear as their own rows.
 */
export function summarizeMetrics(events: readonly MetricEvent[]): MetricsSummary {
  const bySource = new Map<string, ProposalSourceRollup>();
  const ensureSource = (source: string): ProposalSourceRollup => {
    const key = normalizeProposalSource(source);
    let row = bySource.get(key);
    if (!row) {
      row = { source: key, created: 0, applied: 0, discarded: 0 };
      bySource.set(key, row);
    }
    return row;
  };

  let created = 0;
  let applied = 0;
  let discarded = 0;

  let recallAttempts = 0;
  let recallHits = 0;
  let recallMisses = 0;
  let recallTimeouts = 0;
  let recallFailures = 0;

  let qmdRuns = 0;
  let qmdFailures = 0;
  let dirtySum = 0;
  let dirtyCount = 0;
  let dirtyMax = 0;
  let syncSum = 0;
  let syncCount = 0;

  for (const event of events) {
    if (event.kind === "proposal_create") {
      created += 1;
      ensureSource(event.source).created += 1;
    } else if (event.kind === "proposal_apply") {
      applied += 1;
      ensureSource(event.source).applied += 1;
    } else if (event.kind === "proposal_discard") {
      discarded += 1;
      ensureSource(event.source).discarded += 1;
    } else if (event.kind === "auto_recall") {
      recallAttempts += 1;
      if (event.timedOut) recallTimeouts += 1;
      if (event.failed) recallFailures += 1;
      if (event.hit) recallHits += 1;
      else recallMisses += 1;
    } else if (event.kind === "qmd_sync") {
      qmdRuns += 1;
      if (!event.ok) qmdFailures += 1;
      if (Number.isFinite(event.dirtyDurationMs)) {
        dirtySum += event.dirtyDurationMs;
        dirtyCount += 1;
        dirtyMax = Math.max(dirtyMax, event.dirtyDurationMs);
      }
      if (Number.isFinite(event.syncDurationMs)) {
        syncSum += event.syncDurationMs;
        syncCount += 1;
      }
    }
  }

  const bySourceList = [...bySource.values()]
    .map((row) => {
      const terminal = row.applied + row.discarded;
      return {
        ...row,
        applyRate: rate(row.applied, terminal),
        discardRate: rate(row.discarded, terminal),
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source));

  return {
    totalEvents: events.length,
    proposals: {
      bySource: bySourceList,
      created,
      applied,
      discarded,
    },
    autoRecall: {
      attempts: recallAttempts,
      hits: recallHits,
      misses: recallMisses,
      timeouts: recallTimeouts,
      failures: recallFailures,
      hitRate: rate(recallHits, recallAttempts),
    },
    qmdSync: {
      runs: qmdRuns,
      failures: qmdFailures,
      avgDirtyDurationMs: dirtyCount > 0 ? dirtySum / dirtyCount : undefined,
      maxDirtyDurationMs: dirtyCount > 0 ? dirtyMax : undefined,
      avgSyncDurationMs: syncCount > 0 ? syncSum / syncCount : undefined,
    },
  };
}

/** Format a compact operator-facing metrics block for status / commands. */
export function formatMetricsSummary(summary: MetricsSummary): string {
  const lines: string[] = ["Memory metrics (local only)", `Events: ${summary.totalEvents}`];

  lines.push(
    `Proposals: created ${summary.proposals.created} · applied ${summary.proposals.applied} · discarded ${summary.proposals.discarded}`,
  );
  if (summary.proposals.bySource.length > 0) {
    for (const row of summary.proposals.bySource) {
      const rates =
        row.applyRate === undefined
          ? "n/a"
          : `apply ${(row.applyRate * 100).toFixed(0)}% / discard ${((row.discardRate || 0) * 100).toFixed(0)}%`;
      lines.push(
        `  · ${row.source}: create ${row.created} · apply ${row.applied} · discard ${row.discarded} (${rates})`,
      );
    }
  }

  const hit =
    summary.autoRecall.hitRate === undefined ? "n/a" : `${(summary.autoRecall.hitRate * 100).toFixed(0)}%`;
  lines.push(
    `Auto-recall: ${summary.autoRecall.attempts} attempts · hits ${summary.autoRecall.hits} · misses ${summary.autoRecall.misses} · hit rate ${hit}` +
      (summary.autoRecall.timeouts || summary.autoRecall.failures
        ? ` · timeouts ${summary.autoRecall.timeouts} · failures ${summary.autoRecall.failures}`
        : ""),
  );

  const avgDirty =
    summary.qmdSync.avgDirtyDurationMs === undefined
      ? "n/a"
      : `${Math.round(summary.qmdSync.avgDirtyDurationMs)}ms`;
  const maxDirty =
    summary.qmdSync.maxDirtyDurationMs === undefined
      ? "n/a"
      : `${Math.round(summary.qmdSync.maxDirtyDurationMs)}ms`;
  const avgSync =
    summary.qmdSync.avgSyncDurationMs === undefined
      ? "n/a"
      : `${Math.round(summary.qmdSync.avgSyncDurationMs)}ms`;
  lines.push(
    `QMD sync: ${summary.qmdSync.runs} runs · failures ${summary.qmdSync.failures} · avg dirty lag ${avgDirty} · max dirty lag ${maxDirty} · avg sync ${avgSync}`,
  );

  return lines.join("\n");
}

/** Parse NDJSON metrics file contents; skip corrupt lines. */
export function parseMetricsNdjson(raw: string): MetricEvent[] {
  const events: MetricEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as MetricEvent;
      if (parsed && typeof parsed === "object" && typeof (parsed as MetricEvent).kind === "string") {
        events.push(parsed);
      }
    } catch {
      // skip corrupt line
    }
  }
  return events;
}

export function serializeMetricEvent(event: MetricEvent): string {
  return JSON.stringify(event);
}
