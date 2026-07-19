/**
 * Significance-driven capture: detect high-signal turns and plan extract Proposals.
 *
 * Wrong durable Memory is worse than none — extract is always Proposal (review-only),
 * never silent doctrine Write. Source tags: explicit | fallback | extract.
 *
 * Domain: Proposal, Write, Decision, Apply, Discard, Memory.
 */

export type SignificanceKind = "decision" | "preference" | "correction" | "milestone";

export type SignificanceHit = {
  kind: SignificanceKind;
  cue: string;
  /** Confidence-ish weight for ranking (higher first). */
  weight: number;
};

export type SignificanceConfig = {
  /** Master switch for extract capture on agent_end. */
  enabled: boolean;
  /** Max extract Proposals to queue per turn. */
  maxProposalsPerTurn: number;
  /**
   * When true, skip extract entirely (kill-switch).
   * Metrics-driven high discard rates can set this via config or runtime.
   */
  disabledByDiscardRate?: boolean;
};

export const DEFAULT_SIGNIFICANCE_CONFIG: SignificanceConfig = {
  enabled: true,
  maxProposalsPerTurn: 2,
  disabledByDiscardRate: false,
};

const DECISION_CUES: Array<{ cue: string; weight: number }> = [
  { cue: "we decided", weight: 3 },
  { cue: "we will go with", weight: 3 },
  { cue: "decision:", weight: 3 },
  { cue: "chose to", weight: 2 },
  { cue: "going with", weight: 2 },
  { cue: "trade-off", weight: 2 },
  { cue: "tradeoff", weight: 2 },
  { cue: "instead of", weight: 1 },
  { cue: "adopted", weight: 2 },
];

const PREFERENCE_CUES: Array<{ cue: string; weight: number }> = [
  { cue: "i prefer", weight: 3 },
  { cue: "my preference", weight: 3 },
  { cue: "please always", weight: 3 },
  { cue: "from now on", weight: 2 },
  { cue: "default to", weight: 2 },
  { cue: "always use", weight: 2 },
  { cue: "never use", weight: 2 },
  { cue: "for future answers", weight: 2 },
];

const CORRECTION_CUES: Array<{ cue: string; weight: number }> = [
  { cue: "actually,", weight: 3 },
  { cue: "correction:", weight: 3 },
  { cue: "that's wrong", weight: 3 },
  { cue: "that is wrong", weight: 3 },
  { cue: "not quite", weight: 2 },
  { cue: "fix that", weight: 3 },
  { cue: "don't remember it that way", weight: 3 },
  { cue: "do not remember it that way", weight: 3 },
  { cue: "update the memory", weight: 3 },
  { cue: "wrong:", weight: 2 },
];

const MILESTONE_CUES: Array<{ cue: string; weight: number }> = [
  { cue: "shipped", weight: 3 },
  { cue: "launched", weight: 3 },
  { cue: "merged", weight: 2 },
  { cue: "milestone", weight: 3 },
  { cue: "we finished", weight: 2 },
  { cue: "completed the", weight: 2 },
  { cue: "done with", weight: 1 },
  { cue: "released", weight: 2 },
];

function findHits(text: string, kind: SignificanceKind, cues: Array<{ cue: string; weight: number }>): SignificanceHit[] {
  const hits: SignificanceHit[] = [];
  for (const { cue, weight } of cues) {
    if (text.includes(cue)) hits.push({ kind, cue, weight });
  }
  return hits;
}

/**
 * Deterministic significance scan over user + assistant turn text.
 * Returns unique kinds ordered by total weight (high first).
 */
export function detectSignificanceSignals(input: {
  userText?: string;
  assistantText?: string;
}): SignificanceHit[] {
  const text = `${input.userText || ""}\n${input.assistantText || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return [];

  const all = [
    ...findHits(text, "decision", DECISION_CUES),
    ...findHits(text, "preference", PREFERENCE_CUES),
    ...findHits(text, "correction", CORRECTION_CUES),
    ...findHits(text, "milestone", MILESTONE_CUES),
  ];

  // Collapse to best hit per kind
  const byKind = new Map<SignificanceKind, SignificanceHit>();
  for (const hit of all) {
    const existing = byKind.get(hit.kind);
    if (!existing || hit.weight > existing.weight) byKind.set(hit.kind, hit);
  }

  return [...byKind.values()].sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
}

export function isHighSignificance(hits: readonly SignificanceHit[]): boolean {
  return hits.length > 0 && hits.some((h) => h.weight >= 2);
}

export type ExtractProposalDraft = {
  sourceTag: "extract";
  kind: SignificanceKind;
  targetPath: string;
  title: string;
  rationale: string;
  content: string;
  action: "append_file";
  contentClass: string;
};

/** Plausible Proposal targets by significance kind (always reviewable, never doctrine Write). */
export function targetPathForSignificanceKind(kind: SignificanceKind, project?: string): string {
  const slug = (project || "").trim();
  switch (kind) {
    case "preference":
      // Global-ish prefs land on working context; project-scoped when project known stays reviewable there too.
      return slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
    case "decision":
      return slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
    case "correction":
      return slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
    case "milestone":
      return slug ? `memory/projects/${slug}/progress.md` : "memory/working-context.md";
    default:
      return slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
  }
}

function contentClassForKind(kind: SignificanceKind): string {
  switch (kind) {
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    case "correction":
      return "uncertain_durable";
    case "milestone":
      return "progress";
    default:
      return "uncertain_durable";
  }
}

/**
 * Build ≤ maxProposalsPerTurn extract drafts from significance hits.
 * Always Proposal path (never silent doctrine Write).
 */
export function planExtractProposals(input: {
  hits: readonly SignificanceHit[];
  userText?: string;
  assistantText?: string;
  project?: string;
  maxProposalsPerTurn?: number;
  toolNames?: string[];
}): ExtractProposalDraft[] {
  if (!isHighSignificance(input.hits)) return [];

  const cap = Math.max(0, input.maxProposalsPerTurn ?? DEFAULT_SIGNIFICANCE_CONFIG.maxProposalsPerTurn);
  if (cap === 0) return [];

  const drafts: ExtractProposalDraft[] = [];
  const seenPaths = new Set<string>();

  for (const hit of input.hits) {
    if (drafts.length >= cap) break;

    const targetPath = targetPathForSignificanceKind(hit.kind, input.project);
    if (seenPaths.has(targetPath)) continue;
    seenPaths.add(targetPath);

    const contentClass = contentClassForKind(hit.kind);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const userBit = truncate(input.userText, 220);
    const assistantBit = truncate(input.assistantText, 280);
    const tools = input.toolNames?.length ? input.toolNames.join(", ") : undefined;

    const content = [
      `\n## [${stamp}] extract capture (${hit.kind})`,
      "",
      `- Signal: ${hit.kind} (“${hit.cue}”)`,
      `- Write policy: ${contentClass} → propose (extract is review-only)`,
      userBit ? `- User: ${userBit}` : undefined,
      assistantBit ? `- Assistant: ${assistantBit}` : undefined,
      tools ? `- Tools: ${tools}` : undefined,
      "",
      "_Queued by significance extract — review before Apply. Never auto-applied as doctrine._",
      "",
    ]
      .filter(Boolean)
      .join("\n");

    drafts.push({
      sourceTag: "extract",
      kind: hit.kind,
      targetPath,
      title: `extract-${hit.kind}`,
      rationale: `Extract capture: high-significance ${hit.kind} signal (“${hit.cue}”) without a memory-persisting tool this turn. Default path is Proposal (review-only); never silent doctrine Write.`,
      content,
      action: "append_file",
      contentClass,
    });
  }

  return drafts;
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/**
 * Whether extract should run given config + optional metrics kill-switch.
 * Hook for discard-rate: pass disabledByDiscardRate from metrics rollup.
 */
export function shouldRunExtractCapture(
  config: SignificanceConfig,
  options?: { alreadyPersisted?: boolean },
): boolean {
  if (!config.enabled) return false;
  if (config.disabledByDiscardRate) return false;
  if (options?.alreadyPersisted) return false;
  return true;
}

/**
 * Derive kill-switch from proposal metrics rollup (optional hook).
 * High discard rate on extract source disables further extract.
 */
export function shouldDisableExtractFromMetrics(input: {
  extractCreated: number;
  extractDiscarded: number;
  extractApplied: number;
  /** Minimum terminal outcomes before kill-switch can fire. */
  minTerminal?: number;
  /** Discard rate threshold (0–1). Default 0.8. */
  discardRateThreshold?: number;
}): boolean {
  const terminal = input.extractApplied + input.extractDiscarded;
  const minTerminal = input.minTerminal ?? 5;
  if (terminal < minTerminal) return false;
  const rate = input.extractDiscarded / terminal;
  const threshold = input.discardRateThreshold ?? 0.8;
  return rate >= threshold;
}

export function withSignificanceDefaults(partial?: Partial<SignificanceConfig>): SignificanceConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_SIGNIFICANCE_CONFIG.enabled,
    maxProposalsPerTurn:
      Number.isFinite(partial?.maxProposalsPerTurn) && (partial?.maxProposalsPerTurn ?? 0) > 0
        ? (partial?.maxProposalsPerTurn as number)
        : DEFAULT_SIGNIFICANCE_CONFIG.maxProposalsPerTurn,
    disabledByDiscardRate: partial?.disabledByDiscardRate ?? DEFAULT_SIGNIFICANCE_CONFIG.disabledByDiscardRate,
  };
}
