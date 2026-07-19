/**
 * Write-policy router: content class → Write | Proposal | Decision | Ingest.
 *
 * Encodes the durable-vs-reviewable matrix in runtime helpers so system guidance
 * and auto-capture routing do not rely on skill prose alone.
 *
 * Domain: Write, Proposal, Decision, Ingest, Source, Log, Wiki, Note.
 */

export type ContentClass =
  | "session_chronology"
  | "progress"
  | "log"
  | "working_context"
  | "active_context"
  | "preference"
  | "doctrine"
  | "people_fact"
  | "glossary"
  | "decision"
  | "source"
  | "uncertain_durable"
  | "unknown";

export type WritePolicyAction = "write" | "propose" | "decision" | "ingest";

export type WritePolicyTool =
  | "memory_write"
  | "memory_propose_write"
  | "memory_record_decision"
  | "memory_ingest_source";

export type WritePolicyInput = {
  /** Free text (user prompt, note body, or capture rationale). */
  text?: string;
  /** Intended vault-relative path under memory/, when known. */
  path?: string;
  /** Current project slug for path templates. */
  project?: string;
  /** True when a local path or URL Source is being offered. */
  hasSource?: boolean;
  /** True when title + summary + rationale for a Decision are all present. */
  hasCompleteDecision?: boolean;
  /** User explicitly asked for an immediate Write (not review). */
  explicitImmediateWrite?: boolean;
};

export type WritePolicyRoute = {
  contentClass: ContentClass;
  action: WritePolicyAction;
  tool: WritePolicyTool;
  /** Human-readable reason for the route (guidance + proposal rationale). */
  rationale: string;
  /** Suggested vault-relative target when path is implied by class/project. */
  suggestedPath?: string;
  /** Whether this class/path is allowed as a direct memory_write. */
  safeDirect: boolean;
};

const TOOL_BY_ACTION: Record<WritePolicyAction, WritePolicyTool> = {
  write: "memory_write",
  propose: "memory_propose_write",
  decision: "memory_record_decision",
  ingest: "memory_ingest_source",
};

/** Paths that may receive direct Write without a Proposal (chronology / progress style). */
const SAFE_DIRECT_EXACT = new Set([
  "memory/log.md",
  "memory/working-context.md",
]);

const PREFERENCE_CUES = [
  "i prefer",
  "my preference",
  "please always",
  "from now on",
  "default to",
  "for future answers",
  "don't ever",
  "do not ever",
  "always use",
  "never use",
] as const;

const DOCTRINE_CUES = [
  "project rule",
  "our rule",
  "we always",
  "we never",
  "doctrine",
  "coding standard",
  "house rule",
  "policy is",
  "must always",
  "must never",
] as const;

const PEOPLE_CUES = [
  "works at",
  "their email",
  "phone number",
  "reports to",
  "is the lead",
  "team member",
  "contact is",
  "person:",
  "people fact",
] as const;

const GLOSSARY_CUES = [
  "glossary",
  "means the same as",
  "also known as",
  "aka ",
  "term:",
  "definition:",
  "rename ",
  "alias for",
] as const;

const DECISION_CUES = [
  "we decided",
  "decision:",
  "chose to",
  "going with",
  "trade-off",
  "tradeoff",
  "rationale:",
  "because we",
  "instead of",
  "adopted",
] as const;

const PROGRESS_CUES = [
  "finished",
  "completed",
  "shipped",
  "merged",
  "progress:",
  "done with",
  "implemented",
  "fixed the",
] as const;

const SOURCE_URL_RE = /\bhttps?:\/\/\S+/i;
const SOURCE_PATH_RE =
  /(?:^|[\s`"'(])((?:\/|\.\/|\.\.\/)[^\s`"'<>]+|[A-Za-z]:\\[^\s`"'<>]+|file:\/\/\S+)/;

/**
 * Normalize a vault-relative path for policy checks (strip leading slashes, collapse //).
 */
export function normalizeMemoryPath(path: string | undefined): string {
  if (!path) return "";
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").trim();
}

/**
 * Safe direct Write targets: Log, working/active context, progress, and session notes.
 * Everything else defaults toward Proposal unless it is a Decision or Source.
 */
export function isSafeDirectWritePath(path: string | undefined, project?: string): boolean {
  const normalized = normalizeMemoryPath(path);
  if (!normalized || !normalized.startsWith("memory/")) return false;
  if (normalized.startsWith("sources/") || normalized.includes("/sources/")) return false;
  if (SAFE_DIRECT_EXACT.has(normalized)) return true;

  const slug = (project || "").trim();
  if (slug) {
    if (normalized === `memory/projects/${slug}/active-context.md`) return true;
    if (normalized === `memory/projects/${slug}/progress.md`) return true;
    if (normalized.startsWith(`memory/sessions/${slug}/`) && normalized.endsWith(".md")) return true;
  }

  // Template-shaped paths without a resolved project still count as chronology-style.
  if (normalized === "memory/projects/{project}/active-context.md") return true;
  if (normalized === "memory/projects/{project}/progress.md") return true;
  if (/^memory\/sessions\/[^/]+\/.+\.md$/.test(normalized)) return true;
  if (/^memory\/projects\/[^/]+\/active-context\.md$/.test(normalized)) return true;
  if (/^memory\/projects\/[^/]+\/progress\.md$/.test(normalized)) return true;

  return false;
}

function textIncludesAny(text: string, cues: readonly string[]): boolean {
  return cues.some((cue) => text.includes(cue));
}

function looksLikeSourceText(text: string): boolean {
  if (SOURCE_URL_RE.test(text)) return true;
  if (SOURCE_PATH_RE.test(text)) return true;
  return false;
}

/**
 * Classify content for write routing. Path hints win for known safe targets;
 * otherwise free-text cues map to preference / doctrine / decision / etc.
 */
export function classifyContentClass(input: WritePolicyInput): ContentClass {
  if (input.hasSource) return "source";

  const path = normalizeMemoryPath(input.path);
  const text = (input.text || "").replace(/\s+/g, " ").trim().toLowerCase();

  if (path === "memory/log.md" || path.endsWith("/log.md") && path.startsWith("memory/")) {
    return "log";
  }
  if (path === "memory/working-context.md") return "working_context";
  if (/\/active-context\.md$/.test(path)) return "active_context";
  if (/\/progress\.md$/.test(path)) return "progress";
  if (/^memory\/sessions\//.test(path)) return "session_chronology";
  if (/\/glossary\.md$/.test(path) || path === "memory/glossary.md") return "glossary";
  if (/\/system-patterns\.md$/.test(path) || /\/decisions\//.test(path)) {
    if (input.hasCompleteDecision || /\/decisions\//.test(path)) return "decision";
    return "doctrine";
  }

  if (text) {
    if (looksLikeSourceText(text) && (text.includes("ingest") || text.includes("import") || text.includes("add this file") || text.includes("this document") || text.includes("this image") || text.includes("this video") || text.includes("this url") || text.includes("this link"))) {
      return "source";
    }
    if (textIncludesAny(text, PREFERENCE_CUES)) return "preference";
    if (textIncludesAny(text, DOCTRINE_CUES)) return "doctrine";
    if (textIncludesAny(text, PEOPLE_CUES)) return "people_fact";
    if (textIncludesAny(text, GLOSSARY_CUES)) return "glossary";
    if (input.hasCompleteDecision || textIncludesAny(text, DECISION_CUES)) return "decision";
    if (textIncludesAny(text, PROGRESS_CUES)) return "progress";
  }

  if (input.hasCompleteDecision) return "decision";
  if (path && !isSafeDirectWritePath(path, input.project)) return "uncertain_durable";
  if (path && isSafeDirectWritePath(path, input.project)) {
    if (/\/progress\.md$/.test(path)) return "progress";
    if (/\/active-context\.md$/.test(path)) return "active_context";
    if (path === "memory/working-context.md") return "working_context";
    if (path === "memory/log.md") return "log";
    return "session_chronology";
  }

  return "unknown";
}

function defaultPathForClass(contentClass: ContentClass, project?: string): string | undefined {
  const slug = (project || "").trim();
  switch (contentClass) {
    case "log":
      return "memory/log.md";
    case "working_context":
      return "memory/working-context.md";
    case "active_context":
      return slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
    case "progress":
      return slug ? `memory/projects/${slug}/progress.md` : undefined;
    case "session_chronology":
      return slug ? `memory/sessions/${slug}/` : undefined;
    case "glossary":
      return "memory/glossary.md";
    case "doctrine":
      return slug ? `memory/projects/${slug}/system-patterns.md` : undefined;
    case "preference":
    case "people_fact":
    case "uncertain_durable":
    case "unknown":
      return slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
    case "decision":
      return slug ? `memory/projects/${slug}/decisions/` : undefined;
    case "source":
      return slug ? `memory/projects/${slug}/ingests/` : undefined;
    default:
      return undefined;
  }
}

/**
 * Map a content class to Write / Proposal / Decision / Ingest.
 * Safe chronology-style Notes may Write directly; durable prefs/doctrine propose;
 * complete Decisions use the Decision tool; Sources use Ingest.
 */
export function routeWritePolicy(input: WritePolicyInput): WritePolicyRoute {
  const contentClass = classifyContentClass(input);
  const path = normalizeMemoryPath(input.path) || defaultPathForClass(contentClass, input.project);
  const safeDirect = isSafeDirectWritePath(path, input.project);

  // Source always ingests (immutable boundary + generated Note).
  if (contentClass === "source" || input.hasSource) {
    return {
      contentClass: "source",
      action: "ingest",
      tool: TOOL_BY_ACTION.ingest,
      rationale: "Sources use Ingest; do not free-form Write or Propose the same raw Source.",
      suggestedPath: path || defaultPathForClass("source", input.project),
      safeDirect: false,
    };
  }

  // Complete Decision → dedicated Decision path (not ad-hoc write_file).
  if (contentClass === "decision" && (input.hasCompleteDecision || looksCompleteDecisionText(input.text))) {
    return {
      contentClass: "decision",
      action: "decision",
      tool: TOOL_BY_ACTION.decision,
      rationale: "Well-specified Decision with rationale uses memory_record_decision.",
      suggestedPath: path || defaultPathForClass("decision", input.project),
      safeDirect: false,
    };
  }

  // Decision language without complete fields → Proposal (never silent doctrine Write).
  if (contentClass === "decision") {
    return {
      contentClass: "decision",
      action: "propose",
      tool: TOOL_BY_ACTION.propose,
      rationale: "Decision language detected but title/summary/rationale are incomplete; queue a Proposal.",
      suggestedPath: path || defaultPathForClass("decision", input.project),
      safeDirect: false,
    };
  }

  // Preferences, doctrine, people, glossary, uncertain → Proposal by default.
  if (
    contentClass === "preference" ||
    contentClass === "doctrine" ||
    contentClass === "people_fact" ||
    contentClass === "glossary" ||
    contentClass === "uncertain_durable"
  ) {
    return {
      contentClass,
      action: "propose",
      tool: TOOL_BY_ACTION.propose,
      rationale: proposalRationale(contentClass),
      suggestedPath: path || defaultPathForClass(contentClass, input.project),
      safeDirect: false,
    };
  }

  // Chronology / progress / log / context — direct Write when path is safe.
  if (
    contentClass === "session_chronology" ||
    contentClass === "progress" ||
    contentClass === "log" ||
    contentClass === "working_context" ||
    contentClass === "active_context"
  ) {
    if (safeDirect || input.explicitImmediateWrite) {
      return {
        contentClass,
        action: "write",
        tool: TOOL_BY_ACTION.write,
        rationale: "Chronological / progress-style Wiki Note may Write directly.",
        suggestedPath: path,
        safeDirect: true,
      };
    }
    return {
      contentClass,
      action: "propose",
      tool: TOOL_BY_ACTION.propose,
      rationale: "Target is not a known safe direct path; default to Proposal.",
      suggestedPath: path,
      safeDirect: false,
    };
  }

  // Unknown: if user insisted on immediate write and path is safe, Write; else Propose.
  if (input.explicitImmediateWrite && safeDirect) {
    return {
      contentClass: "unknown",
      action: "write",
      tool: TOOL_BY_ACTION.write,
      rationale: "User requested immediate Write on a safe direct target.",
      suggestedPath: path,
      safeDirect: true,
    };
  }

  return {
    contentClass: "unknown",
    action: "propose",
    tool: TOOL_BY_ACTION.propose,
    rationale: "Ambiguous durable claim defaults to Proposal (review before Wiki mutation).",
    suggestedPath: path || defaultPathForClass("unknown", input.project),
    safeDirect: false,
  };
}

function proposalRationale(contentClass: ContentClass): string {
  switch (contentClass) {
    case "preference":
      return "Preferences default to Proposal so durable personal/project prefs are reviewed.";
    case "doctrine":
      return "Doctrine / rules default to Proposal; do not silent-Write project law.";
    case "people_fact":
      return "People facts default to Proposal (sensitive durable claims).";
    case "glossary":
      return "Glossary / naming changes default to Proposal when ambiguous.";
    case "uncertain_durable":
      return "Uncertain durable claim defaults to Proposal.";
    default:
      return "Durable claim defaults to Proposal.";
  }
}

function looksCompleteDecisionText(text: string | undefined): boolean {
  if (!text) return false;
  const lowered = text.toLowerCase();
  // Require explicit structure markers so casual "we decided… because…" stays Proposal.
  const hasTitle = /\btitle\s*:/.test(lowered) || /\bdecision\s*:/.test(lowered);
  const hasSummary = /\bsummary\s*:/.test(lowered) || /\bwe will\b/.test(lowered);
  const hasRationale = /\brationale\s*:/.test(lowered) || (/\bbecause\b/.test(lowered) && hasTitle && hasSummary);
  return hasTitle && hasSummary && hasRationale;
}

/**
 * Compact system-prompt guidance for a routed write policy.
 * Used when memory intent / significance is detected so the model is steered
 * to the correct tool without redesigning tool contracts.
 */
export function buildWritePolicyGuidance(route: WritePolicyRoute, options?: { targetPath?: string }): string {
  const target = options?.targetPath || route.suggestedPath;
  const targetHint = target ? ` Suggested target: ${target}.` : "";

  switch (route.action) {
    case "ingest":
      return (
        "Write policy: Source detected. Prefer memory_ingest_source (not free-form memory_write or memory_propose_write for the same Source)." +
        targetHint
      );
    case "decision":
      return (
        "Write policy: complete Decision. Prefer memory_record_decision with title, summary, and rationale." +
        targetHint
      );
    case "write":
      return (
        "Write policy: safe direct Write. Prefer memory_write for this chronological / progress-style Wiki Note or Log entry." +
        targetHint +
        " Do not use memory_write for preferences, doctrine, people facts, or ambiguous glossary changes."
      );
    case "propose":
    default:
      return (
        "Write policy: Proposal. Prefer memory_propose_write over memory_write." +
        ` ${route.rationale}` +
        targetHint +
        " If this is clearly a durable Decision with title, summary, and rationale, prefer memory_record_decision. If a Source path or URL is present, prefer memory_ingest_source."
      );
  }
}

/**
 * Content-class → action matrix for docs and status (stable, exhaustive).
 */
export function writePolicyMatrix(): Array<{
  contentClass: ContentClass;
  defaultAction: WritePolicyAction;
  tool: WritePolicyTool;
  notes: string;
}> {
  return [
    {
      contentClass: "session_chronology",
      defaultAction: "write",
      tool: "memory_write",
      notes: "Session notes under memory/sessions/<project>/",
    },
    {
      contentClass: "progress",
      defaultAction: "write",
      tool: "memory_write",
      notes: "Project progress.md restating completed work",
    },
    {
      contentClass: "log",
      defaultAction: "write",
      tool: "memory_write",
      notes: "memory/log.md operation Log",
    },
    {
      contentClass: "working_context",
      defaultAction: "write",
      tool: "memory_write",
      notes: "Cross-project Working context snapshot",
    },
    {
      contentClass: "active_context",
      defaultAction: "write",
      tool: "memory_write",
      notes: "Project Active context snapshot",
    },
    {
      contentClass: "preference",
      defaultAction: "propose",
      tool: "memory_propose_write",
      notes: "Durable prefs — review before Apply",
    },
    {
      contentClass: "doctrine",
      defaultAction: "propose",
      tool: "memory_propose_write",
      notes: "Rules / system patterns — never silent doctrine Write",
    },
    {
      contentClass: "people_fact",
      defaultAction: "propose",
      tool: "memory_propose_write",
      notes: "People facts are reviewable",
    },
    {
      contentClass: "glossary",
      defaultAction: "propose",
      tool: "memory_propose_write",
      notes: "Ambiguous naming / aliases",
    },
    {
      contentClass: "decision",
      defaultAction: "decision",
      tool: "memory_record_decision",
      notes: "Complete Decision (title, summary, rationale); incomplete → propose",
    },
    {
      contentClass: "source",
      defaultAction: "ingest",
      tool: "memory_ingest_source",
      notes: "Immutable Source boundary",
    },
    {
      contentClass: "uncertain_durable",
      defaultAction: "propose",
      tool: "memory_propose_write",
      notes: "When in doubt, Proposal",
    },
    {
      contentClass: "unknown",
      defaultAction: "propose",
      tool: "memory_propose_write",
      notes: "Default conservative route",
    },
  ];
}

/**
 * Choose a plausible Proposal target for explicit memory-language fallback.
 * Prefers policy routing over a single hard-coded active-context path.
 */
export function chooseWritePolicyTarget(input: WritePolicyInput): string {
  const route = routeWritePolicy(input);
  if (route.suggestedPath) {
    // Directory suggestions (decisions/, ingests/, sessions/) need a concrete file for append_file.
    if (route.suggestedPath.endsWith("/")) {
      const slug = (input.project || "").trim();
      if (route.contentClass === "decision" && slug) {
        return `memory/projects/${slug}/active-context.md`;
      }
      if (route.contentClass === "session_chronology" && slug) {
        const date = new Date().toISOString().slice(0, 10);
        return `memory/sessions/${slug}/${date}.md`;
      }
      if (slug) return `memory/projects/${slug}/active-context.md`;
      return "memory/working-context.md";
    }
    return route.suggestedPath;
  }
  const slug = (input.project || "").trim();
  return slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
}
