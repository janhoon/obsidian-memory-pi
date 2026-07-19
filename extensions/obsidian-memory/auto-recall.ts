/**
 * Intent-aware Auto-recall: classify user intent and plan Scope mix.
 *
 * Domain: Auto-recall, Search, Scope, Active context, Note, Recall.
 * Snippet-only pre-answer injection is enforced by the extension (not full Note reads).
 */

export type RecallIntent =
  | "continuity"
  | "decision"
  | "preference"
  | "status"
  | "general"
  | "none";

/** Precise Scope slices used for Auto-recall (not the nested tool scopes). */
export type RecallScope = "session" | "project" | "global";

export type AutoRecallConfigSlice = {
  enabled: boolean;
  maxResults: number;
  triggerPatterns: readonly string[];
  /** When true, first agent turn may run light Recall without a trigger phrase. */
  firstTurnRecall?: boolean;
};

export type AutoRecallPlan = {
  shouldRecall: boolean;
  intent: RecallIntent;
  /** Ordered scopes to include in the Search filter. */
  scopes: RecallScope[];
  /** Optional path substrings to boost after Search (e.g. active-context). */
  preferPathSubstrings: string[];
  /** Why this plan was chosen (debug / status). */
  reason: string;
  matchedPattern?: string;
};

const CONTINUITY_CUES = [
  "continue",
  "catch up",
  "last session",
  "where were we",
  "pick up where",
  "resume",
  "what were we doing",
  "remind me where",
] as const;

const DECISION_CUES = [
  "what did we decide",
  "why did we",
  "decision",
  "decided",
  "trade-off",
  "tradeoff",
  "rationale for",
  "why did we choose",
  "why are we using",
] as const;

const PREFERENCE_CUES = [
  "my preference",
  "i prefer",
  "prefer that",
  "preferences",
  "default style",
  "how should you",
  "always respond",
  "house style",
  "writing style",
] as const;

const STATUS_CUES = [
  "project status",
  "status update",
  "what's next",
  "what is next",
  "current focus",
  "in progress",
  "where are we",
  "progress on",
  "active context",
  "blocker",
  "blockers",
] as const;

function includesAny(text: string, cues: readonly string[]): string | undefined {
  for (const cue of cues) {
    if (text.includes(cue)) return cue;
  }
  return undefined;
}

/**
 * Classify free-text user intent for Auto-recall routing.
 * More specific intents win over general trigger-pattern matches.
 */
export function classifyRecallIntent(prompt: string): { intent: RecallIntent; matchedCue?: string } {
  const lowered = prompt.replace(/\s+/g, " ").trim().toLowerCase();
  if (!lowered || lowered.startsWith("/")) return { intent: "none" };

  const decision = includesAny(lowered, DECISION_CUES);
  if (decision) return { intent: "decision", matchedCue: decision };

  const preference = includesAny(lowered, PREFERENCE_CUES);
  if (preference) return { intent: "preference", matchedCue: preference };

  const status = includesAny(lowered, STATUS_CUES);
  if (status) return { intent: "status", matchedCue: status };

  const continuity = includesAny(lowered, CONTINUITY_CUES);
  if (continuity) return { intent: "continuity", matchedCue: continuity };

  return { intent: "none" };
}

/** Map intent → Scope mix (acceptance criteria). */
export function scopesForIntent(intent: RecallIntent): RecallScope[] {
  switch (intent) {
    case "continuity":
      return ["session", "project"];
    case "decision":
      return ["project", "global"];
    case "preference":
      return ["global", "project"];
    case "status":
      return ["project"];
    case "general":
      return ["project"];
    case "none":
    default:
      return [];
  }
}

export function preferPathsForIntent(intent: RecallIntent, project?: string): string[] {
  const slug = (project || "").trim();
  if (intent === "status") {
    return slug
      ? [
          `memory/projects/${slug}/active-context.md`,
          `memory/projects/${slug}/MEMORY.md`,
          `memory/projects/${slug}/progress.md`,
        ]
      : ["active-context.md", "MEMORY.md", "progress.md"];
  }
  if (intent === "decision") {
    return slug ? [`memory/projects/${slug}/decisions/`, "memory/working-context.md"] : ["decisions/"];
  }
  if (intent === "preference") {
    return ["memory/working-context.md", "memory/glossary.md", "memory/global/"];
  }
  if (intent === "continuity") {
    return slug
      ? [`memory/sessions/${slug}/`, `memory/projects/${slug}/active-context.md`]
      : ["memory/sessions/"];
  }
  return [];
}

/**
 * Plan whether Auto-recall should run and which Scopes to Search.
 * Backward compatible: flat triggerPatterns still fire as intent `general` (project scope)
 * when no more specific intent matches.
 */
export function planAutoRecall(
  prompt: string,
  options: {
    config: AutoRecallConfigSlice;
    project?: string;
    /** True for the first agent turn of the session (before any completed reply). */
    isFirstTurn?: boolean;
  },
): AutoRecallPlan {
  const config = options.config;
  if (!config.enabled) {
    return {
      shouldRecall: false,
      intent: "none",
      scopes: [],
      preferPathSubstrings: [],
      reason: "autoRecall disabled",
    };
  }

  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("/")) {
    return {
      shouldRecall: false,
      intent: "none",
      scopes: [],
      preferPathSubstrings: [],
      reason: "empty or command prompt",
    };
  }

  const classified = classifyRecallIntent(normalized);
  if (classified.intent !== "none") {
    return {
      shouldRecall: true,
      intent: classified.intent,
      scopes: scopesForIntent(classified.intent),
      preferPathSubstrings: preferPathsForIntent(classified.intent, options.project),
      reason: `intent:${classified.intent}`,
      matchedPattern: classified.matchedCue,
    };
  }

  const lowered = normalized.toLowerCase();
  const matchedPattern = config.triggerPatterns.find((pattern) => lowered.includes(pattern.toLowerCase()));
  if (matchedPattern) {
    return {
      shouldRecall: true,
      intent: "general",
      scopes: scopesForIntent("general"),
      preferPathSubstrings: preferPathsForIntent("general", options.project),
      reason: `trigger:${matchedPattern}`,
      matchedPattern,
    };
  }

  if (config.firstTurnRecall && options.isFirstTurn) {
    return {
      shouldRecall: true,
      intent: "status",
      scopes: scopesForIntent("status"),
      preferPathSubstrings: preferPathsForIntent("status", options.project),
      reason: "firstTurnRecall",
    };
  }

  return {
    shouldRecall: false,
    intent: "none",
    scopes: [],
    preferPathSubstrings: [],
    reason: "no trigger",
  };
}

/**
 * Build precise path prefixes for a set of Recall scopes (no accidental nesting).
 * Unlike tool `scope=project` (which historically also included global router files),
 * Auto-recall uses only the scopes listed in the plan.
 */
export function buildRecallScopePrefixes(
  scopes: readonly RecallScope[],
  options: {
    globalPrefixes: readonly string[];
    projectTemplate: string;
    sessionTemplate: string;
    project?: string;
  },
): string[] {
  const slug = (options.project || "").trim();
  const projectPrefix = slug ? options.projectTemplate.replaceAll("{project}", slug) : undefined;
  const sessionPrefix = slug ? options.sessionTemplate.replaceAll("{project}", slug) : undefined;
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (prefix: string | undefined) => {
    if (!prefix || seen.has(prefix)) return;
    seen.add(prefix);
    out.push(prefix);
  };

  for (const scope of scopes) {
    if (scope === "global") {
      for (const g of options.globalPrefixes) add(g);
    } else if (scope === "project") {
      add(projectPrefix);
    } else if (scope === "session") {
      add(sessionPrefix);
    }
  }

  return out;
}

export type RankableSearchHit = {
  file: string;
  score?: number;
};

/**
 * Stable re-rank: prefer configured path substrings, then original score, then path.
 * Does not change snippet content — only order for injection budget.
 */
export function rankRecallResults<T extends RankableSearchHit>(
  results: readonly T[],
  preferPathSubstrings: readonly string[],
): T[] {
  if (preferPathSubstrings.length === 0) return [...results];

  const scored = results.map((result, index) => {
    const file = result.file || "";
    let boost = 0;
    for (let i = 0; i < preferPathSubstrings.length; i++) {
      const needle = preferPathSubstrings[i];
      if (needle && file.includes(needle)) {
        boost = preferPathSubstrings.length - i;
        break;
      }
    }
    return { result, index, boost, score: typeof result.score === "number" ? result.score : 0 };
  });

  scored.sort((a, b) => {
    if (b.boost !== a.boost) return b.boost - a.boost;
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map((row) => row.result);
}

/** Merge defaults for autoRecall including firstTurnRecall. */
export function withAutoRecallDefaults(
  partial?: Partial<AutoRecallConfigSlice> & { timeoutMs?: number; clearDelayMs?: number },
  defaults?: { triggerPatterns: readonly string[] },
): AutoRecallConfigSlice & { timeoutMs?: number; clearDelayMs?: number } {
  const triggerPatterns =
    Array.isArray(partial?.triggerPatterns) && partial.triggerPatterns.length > 0
      ? partial.triggerPatterns
      : [...(defaults?.triggerPatterns || [])];

  return {
    enabled: partial?.enabled ?? true,
    maxResults: partial?.maxResults && partial.maxResults > 0 ? partial.maxResults : 4,
    triggerPatterns,
    firstTurnRecall: partial?.firstTurnRecall ?? false,
    timeoutMs: partial?.timeoutMs,
    clearDelayMs: partial?.clearDelayMs,
  };
}
