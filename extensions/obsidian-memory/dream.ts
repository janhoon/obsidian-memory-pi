/**
 * Manual Dream: consolidate recent Session notes into semantic Wiki Notes.
 *
 * Direct Writes only for safe chronology/progress/context targets.
 * Sensitive durable claims become Proposals. Never hard-delete Notes.
 *
 * Domain: Dream, Session note, Active context, Wiki, Note, Proposal, Log, Decision.
 */

export type DreamConfig = {
  /** Lookback window in days for Session notes (inclusive of today). */
  lookbackDays: number;
  /** Soft char budget when refreshing Active context / MEMORY index. */
  maxContextChars: number;
  /** Max extract-style Proposals Dream may queue in one pass. */
  maxProposals: number;
};

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  lookbackDays: 3,
  maxContextChars: 4_000,
  maxProposals: 5,
};

export type DreamCandidateKind =
  | "progress"
  | "active_focus"
  | "preference"
  | "decision"
  | "doctrine"
  | "glossary"
  | "people"
  | "other";

export type DreamCandidate = {
  kind: DreamCandidateKind;
  text: string;
  /** Session note path this came from. */
  sourcePath: string;
  /** Direct write vs proposal. */
  action: "write" | "propose";
  targetPath: string;
};

export type DreamDirectWrite = {
  path: string;
  /** Full replacement body for write_file, or append chunk for append. */
  content: string;
  mode: "write_file" | "append_file";
  reason: string;
};

export type DreamProposalDraft = {
  sourceTag: "dream";
  kind: DreamCandidateKind;
  targetPath: string;
  title: string;
  rationale: string;
  content: string;
  action: "append_file";
};

export type DreamPlan = {
  project: string;
  lookbackDays: number;
  sessionPaths: string[];
  candidates: DreamCandidate[];
  directWrites: DreamDirectWrite[];
  proposals: DreamProposalDraft[];
  logEntry: string;
  /** High-level summary for operator notify. */
  summary: string;
};

const PREFERENCE_RE =
  /\b(i prefer|my preference|please always|from now on|default to|always use|never use|for future answers)\b/i;
const DECISION_RE = /\b(we decided|decision:|chose to|going with|trade-?off|adopted|instead of)\b/i;
const DOCTRINE_RE = /\b(project rule|our rule|we always|we never|doctrine|must always|must never|house rule)\b/i;
const GLOSSARY_RE = /\b(glossary|also known as|aka |means the same|term:|definition:|alias for)\b/i;
const PEOPLE_RE = /\b(works at|reports to|is the lead|team member|contact is|their email)\b/i;
const PROGRESS_RE =
  /\b(finished|completed|shipped|merged|implemented|fixed the|done with|released|launched)\b/i;
const FOCUS_RE = /\b(next step|in progress|working on|focus:|blocker|todo:|plan to)\b/i;

/**
 * Extract durable-looking bullet / line candidates from Session note markdown.
 */
export function extractSessionCandidates(sessionPath: string, content: string): Array<{ text: string; sourcePath: string }> {
  const lines = content.split("\n");
  const out: Array<{ text: string; sourcePath: string }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Session entries: "- User: …", "- Assistant: …", free bullets
    let text = line;
    if (/^[-*]\s+/.test(text)) text = text.replace(/^[-*]\s+/, "");
    if (/^(User|Assistant|Tools|Trigger|Signal|reason):\s*/i.test(text)) {
      text = text.replace(/^(User|Assistant|Tools|Trigger|Signal|reason):\s*/i, "");
    }
    text = text.replace(/^#+\s*/, "").trim();
    if (text.length < 12) continue;
    if (/^session_start\b/i.test(text)) continue;
    if (/^turn\b/i.test(text) && text.length < 20) continue;
    out.push({ text, sourcePath: sessionPath });
  }
  return out;
}

export function classifyDreamCandidate(
  text: string,
  project?: string,
): { kind: DreamCandidateKind; action: "write" | "propose"; targetPath: string } {
  const slug = (project || "").trim();
  const active = slug ? `memory/projects/${slug}/active-context.md` : "memory/working-context.md";
  const progress = slug ? `memory/projects/${slug}/progress.md` : "memory/working-context.md";
  const glossary = "memory/glossary.md";
  const patterns = slug ? `memory/projects/${slug}/system-patterns.md` : "memory/working-context.md";

  if (PREFERENCE_RE.test(text)) {
    return { kind: "preference", action: "propose", targetPath: active };
  }
  if (DOCTRINE_RE.test(text)) {
    return { kind: "doctrine", action: "propose", targetPath: patterns };
  }
  if (PEOPLE_RE.test(text)) {
    return { kind: "people", action: "propose", targetPath: active };
  }
  if (GLOSSARY_RE.test(text)) {
    return { kind: "glossary", action: "propose", targetPath: glossary };
  }
  if (DECISION_RE.test(text)) {
    // Incomplete decision → Proposal (not silent Decision Write)
    return { kind: "decision", action: "propose", targetPath: active };
  }
  if (PROGRESS_RE.test(text)) {
    return { kind: "progress", action: "write", targetPath: progress };
  }
  if (FOCUS_RE.test(text)) {
    return { kind: "active_focus", action: "write", targetPath: active };
  }
  return { kind: "other", action: "propose", targetPath: active };
}

function dedupeTexts(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * Refresh Active context under budget: keep frontmatter if present, replace body sections with consolidated bullets.
 */
export function buildActiveContextDreamBody(
  existing: string | undefined,
  focusBullets: string[],
  options: { maxChars: number; date: string },
): string {
  const bullets = dedupeTexts(focusBullets).slice(0, 12);
  const focusBlock =
    bullets.length > 0 ? bullets.map((b) => `- ${b}`).join("\n") : "- (no new focus bullets from Session notes)";

  let body = [
    `# Active context`,
    "",
    "## In progress",
    "",
    focusBlock,
    "",
    "## Risks / blockers",
    "",
    "- (review Session notes if blockers were mentioned)",
    "",
    "## Next step",
    "",
    bullets[0] ? `- ${bullets[0]}` : "- Continue from latest Session note.",
    "",
    `_(Dream-refreshed ${options.date})_`,
    "",
  ].join("\n");

  // Preserve frontmatter from existing Note when present.
  if (existing && /^---\n[\s\S]*?\n---/.test(existing)) {
    const fm = existing.match(/^---\n[\s\S]*?\n---/)![0];
    // bump last_reviewed if present
    const fmUpdated = fm.replace(/^last_reviewed:\s*.*$/m, `last_reviewed: ${options.date}`);
    body = `${fmUpdated}\n${body}`;
  } else {
    body =
      [
        "---",
        "type: context",
        "scope: project",
        "relevance: high",
        `last_reviewed: ${options.date}`,
        "---",
        "",
      ].join("\n") + body;
  }

  if (body.length > options.maxChars) {
    const marker = "\n\n…(truncated for Dream budget)\n";
    body = body.slice(0, Math.max(0, options.maxChars - marker.length)).trimEnd() + marker;
  }
  return body.endsWith("\n") ? body : body + "\n";
}

/**
 * Refresh project MEMORY index under budget (pointers over prose).
 */
export function buildMemoryIndexDreamBody(
  existing: string | undefined,
  options: {
    maxChars: number;
    date: string;
    focusBullets: string[];
    decisionPointers: string[];
    riskBullets: string[];
  },
): string {
  const focus = dedupeTexts(options.focusBullets).slice(0, 5);
  const decisions = dedupeTexts(options.decisionPointers).slice(0, 5);
  const risks = dedupeTexts(options.riskBullets).slice(0, 5);

  let body = [
    "# MEMORY index",
    "",
    "Short, budgeted project index for the session core pack. **Pointers over prose.**",
    "",
    `_(Dream-refreshed ${options.date})_`,
    "",
    "## Focus",
    "",
    focus.length ? focus.map((b) => `- ${b}`).join("\n") : "- (see Active context)",
    "",
    "## Key Decisions",
    "",
    decisions.length ? decisions.map((b) => `- ${b}`).join("\n") : "- (none extracted this pass)",
    "",
    "## Risks",
    "",
    risks.length ? risks.map((b) => `- ${b}`).join("\n") : "- (none extracted this pass)",
    "",
    "## Pointers",
    "",
    "- [[active-context]] — current work / next step",
    "- [[progress]] — what shipped recently",
    "- [[overview]] — goal and constraints",
    "- [[decisions/index|decisions]] — full Decision log",
    "",
  ].join("\n");

  if (existing && /^---\n[\s\S]*?\n---/.test(existing)) {
    const fm = existing.match(/^---\n[\s\S]*?\n---/)![0];
    const fmUpdated = fm.replace(/^last_reviewed:\s*.*$/m, `last_reviewed: ${options.date}`);
    body = `${fmUpdated}\n${body}`;
  } else {
    body =
      [
        "---",
        "type: index",
        "scope: project",
        "relevance: high",
        `last_reviewed: ${options.date}`,
        "---",
        "",
      ].join("\n") + body;
  }

  if (body.length > options.maxChars) {
    const marker = "\n\n…(truncated for Dream budget)\n";
    body = body.slice(0, Math.max(0, options.maxChars - marker.length)).trimEnd() + marker;
  }
  return body.endsWith("\n") ? body : body + "\n";
}

export function buildProgressAppend(progressBullets: string[], date: string): string | undefined {
  const bullets = dedupeTexts(progressBullets);
  if (bullets.length === 0) return undefined;
  return [
    `\n## [${date}] Dream progress promotion`,
    "",
    ...bullets.map((b) => `- ${b}`),
    "",
  ].join("\n");
}

/**
 * Plan a Dream pass from already-loaded Session note contents.
 * Pure: no IO, no deletes.
 */
export function planDreamPass(input: {
  project: string;
  sessionNotes: Array<{ path: string; content: string }>;
  existingActiveContext?: string;
  existingMemoryIndex?: string;
  config?: Partial<DreamConfig>;
  date?: string;
}): DreamPlan {
  const config: DreamConfig = {
    lookbackDays: input.config?.lookbackDays ?? DEFAULT_DREAM_CONFIG.lookbackDays,
    maxContextChars: input.config?.maxContextChars ?? DEFAULT_DREAM_CONFIG.maxContextChars,
    maxProposals: input.config?.maxProposals ?? DEFAULT_DREAM_CONFIG.maxProposals,
  };
  const project = input.project.trim() || "unknown";
  const date = input.date || new Date().toISOString().slice(0, 10);

  const raw: Array<{ text: string; sourcePath: string }> = [];
  for (const note of input.sessionNotes) {
    raw.push(...extractSessionCandidates(note.path, note.content));
  }

  const candidates: DreamCandidate[] = [];
  for (const item of raw) {
    const classified = classifyDreamCandidate(item.text, project);
    candidates.push({
      kind: classified.kind,
      text: item.text,
      sourcePath: item.sourcePath,
      action: classified.action,
      targetPath: classified.targetPath,
    });
  }

  const focusBullets = candidates
    .filter((c) => c.kind === "active_focus" || c.kind === "progress")
    .map((c) => c.text);
  const progressBullets = candidates.filter((c) => c.kind === "progress").map((c) => c.text);
  const decisionPointers = candidates.filter((c) => c.kind === "decision").map((c) => c.text);
  const riskBullets = candidates
    .filter((c) => /\b(risk|blocker|blocked|uncertain)\b/i.test(c.text))
    .map((c) => c.text);

  const directWrites: DreamDirectWrite[] = [];

  // Always refresh Active context when we have any session material or focus/progress.
  if (input.sessionNotes.length > 0) {
    directWrites.push({
      path: `memory/projects/${project}/active-context.md`,
      content: buildActiveContextDreamBody(input.existingActiveContext, focusBullets, {
        maxChars: config.maxContextChars,
        date,
      }),
      mode: "write_file",
      reason: "Dream refresh of Active context under budget",
    });

    directWrites.push({
      path: `memory/projects/${project}/MEMORY.md`,
      content: buildMemoryIndexDreamBody(input.existingMemoryIndex, {
        maxChars: Math.min(config.maxContextChars, 3_000),
        date,
        focusBullets,
        decisionPointers,
        riskBullets,
      }),
      mode: "write_file",
      reason: "Dream refresh of MEMORY index under budget",
    });
  }

  const progressAppend = buildProgressAppend(progressBullets, date);
  if (progressAppend) {
    directWrites.push({
      path: `memory/projects/${project}/progress.md`,
      content: progressAppend,
      mode: "append_file",
      reason: "Dream promotion of progress bullets",
    });
  }

  // Proposals for sensitive kinds (capped).
  const proposalCandidates = candidates.filter((c) => c.action === "propose");
  const proposals: DreamProposalDraft[] = [];
  const seen = new Set<string>();
  for (const c of proposalCandidates) {
    if (proposals.length >= config.maxProposals) break;
    const key = `${c.kind}:${c.text.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const stamp = `${date}`;
    proposals.push({
      sourceTag: "dream",
      kind: c.kind,
      targetPath: c.targetPath,
      title: `dream-${c.kind}`,
      rationale: `Dream promotion: ${c.kind} from Session note ${c.sourcePath}. Review before Apply — never silent doctrine Write.`,
      action: "append_file",
      content: [
        `\n## [${stamp}] Dream capture (${c.kind})`,
        "",
        `- Source Session note: \`${c.sourcePath}\``,
        `- Kind: ${c.kind}`,
        "",
        c.text,
        "",
        "_Queued by Dream — review before Apply. Dream does not hard-delete Wiki Notes._",
        "",
      ].join("\n"),
    });
  }

  const touched = [
    ...directWrites.map((w) => w.path),
    ...proposals.map((p) => p.targetPath),
  ];
  const uniqueTouched = [...new Set(touched)];

  const logEntry = [
    `\n## [${date}] dream | manual`,
    "",
    `- Project: \`${project}\``,
    `- Session notes: ${input.sessionNotes.length} (lookback ${config.lookbackDays}d)`,
    `- Direct Writes: ${directWrites.length}`,
    `- Proposals: ${proposals.length}`,
    `- Touched: ${uniqueTouched.map((p) => `\`${p}\``).join(", ") || "(none)"}`,
    "",
  ].join("\n");

  // Log is always a direct write (safe path).
  directWrites.push({
    path: "memory/log.md",
    content: logEntry,
    mode: "append_file",
    reason: "Dream Log entry",
  });

  const summary = [
    `Dream (manual) for ${project}:`,
    `- Session notes considered: ${input.sessionNotes.map((n) => n.path).join(", ") || "(none)"}`,
    `- Direct Writes: ${directWrites.length}`,
    `- Proposals: ${proposals.length}`,
    `- Candidates classified: ${candidates.length}`,
  ].join("\n");

  return {
    project,
    lookbackDays: config.lookbackDays,
    sessionPaths: input.sessionNotes.map((n) => n.path),
    candidates,
    directWrites,
    proposals,
    logEntry,
    summary,
  };
}

/** List YYYY-MM-DD dates in lookback window ending at `today` (inclusive). */
export function dreamLookbackDates(lookbackDays: number, today = new Date()): string[] {
  const days = Math.max(1, Math.floor(lookbackDays));
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function sessionNotePath(project: string, date: string): string {
  return `memory/sessions/${project}/${date}.md`;
}

export function withDreamDefaults(partial?: Partial<DreamConfig>): DreamConfig {
  return {
    lookbackDays:
      Number.isFinite(partial?.lookbackDays) && (partial?.lookbackDays ?? 0) > 0
        ? (partial?.lookbackDays as number)
        : DEFAULT_DREAM_CONFIG.lookbackDays,
    maxContextChars:
      Number.isFinite(partial?.maxContextChars) && (partial?.maxContextChars ?? 0) > 0
        ? (partial?.maxContextChars as number)
        : DEFAULT_DREAM_CONFIG.maxContextChars,
    maxProposals:
      Number.isFinite(partial?.maxProposals) && (partial?.maxProposals ?? 0) > 0
        ? (partial?.maxProposals as number)
        : DEFAULT_DREAM_CONFIG.maxProposals,
  };
}
