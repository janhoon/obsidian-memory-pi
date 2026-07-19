/**
 * Decision note helpers — IDs, index lines, and supersession links.
 * Pure transforms so incomplete supersession refs fail safely without IO.
 */

export type DecisionStatus = "proposed" | "adopted" | "superseded" | "rejected";

const DECISION_ID_RE = /\bDEC-(\d+)\b/i;

export function sanitizeDecisionTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || "Untitled decision";
}

/** Extract DEC-NNN from a free-form supersedes ref (id, path, or note title). */
export function parseDecisionId(ref: string | undefined | null): string | undefined {
  if (!ref) return undefined;
  const match = ref.trim().match(DECISION_ID_RE);
  if (!match) return undefined;
  return `DEC-${String(match[1]).padStart(3, "0")}`;
}

export function decisionNoteFileName(decisionId: string, title: string): string {
  return `${decisionId} - ${sanitizeDecisionTitle(title)}.md`;
}

export type DecisionNoteParams = {
  decisionId: string;
  project: string;
  title: string;
  summary: string;
  rationale: string;
  alternatives?: string;
  consequences?: string;
  status: string;
  date: string;
  /** Prior Decision id this one supersedes (DEC-NNN). */
  supersedes?: string;
  /** Wikilink label for the prior Decision. */
  supersedesTitle?: string;
  /** When this Decision was itself superseded. */
  supersededBy?: string;
  supersededByTitle?: string;
};

export function buildDecisionNote(params: DecisionNoteParams): string {
  const title = sanitizeDecisionTitle(params.title);
  const front: string[] = [
    "---",
    "type: decision",
    "scope: project",
    `project: ${params.project}`,
    "relevance: high",
    `status: ${params.status}`,
    `decision_id: ${params.decisionId}`,
    `last_reviewed: ${params.date}`,
  ];
  if (params.supersedes) {
    front.push(`supersedes: ${params.supersedes}`);
  }
  if (params.supersededBy) {
    front.push(`superseded_by: ${params.supersededBy}`);
  }
  front.push("---");

  const sections = [
    ...front,
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
  if (params.supersedes) {
    const label = params.supersedesTitle
      ? `[[${params.supersedes} - ${sanitizeDecisionTitle(params.supersedesTitle)}|${params.supersedes}]]`
      : `[[${params.supersedes}]]`;
    sections.push("", "## Supersedes", "", `This Decision supersedes ${label}.`, "");
  }
  if (params.supersededBy) {
    const label = params.supersededByTitle
      ? `[[${params.supersededBy} - ${sanitizeDecisionTitle(params.supersededByTitle)}|${params.supersededBy}]]`
      : `[[${params.supersededBy}]]`;
    sections.push("", "## Superseded by", "", `Superseded by ${label}.`, "");
  }

  return sections.join("\n").replace(/\n+$/, "\n");
}

/**
 * Mark a prior Decision Note as superseded and link forward.
 * Returns undefined if the content is not a recognizable Decision Note.
 */
export function markDecisionSuperseded(
  content: string,
  options: { newDecisionId: string; newTitle: string; date?: string },
): string | undefined {
  if (!content || !/decision_id\s*:/i.test(content) && !/^#\s*DEC-\d+/im.test(content)) {
    // Still try if it looks like our template
    if (!/^---[\s\S]*?---/.test(content) && !/^#\s*DEC-/im.test(content)) {
      return undefined;
    }
  }

  let next = content;
  const date = options.date || new Date().toISOString().slice(0, 10);
  const newId = options.newDecisionId;
  const newTitle = sanitizeDecisionTitle(options.newTitle);

  // Frontmatter status
  if (/^status:\s*\S+/m.test(next)) {
    next = next.replace(/^status:\s*\S+/m, "status: superseded");
  } else if (/^---\n([\s\S]*?)\n---/.test(next)) {
    next = next.replace(/^---\n([\s\S]*?)\n---/, (block) => {
      if (/^status:/m.test(block)) return block;
      return block.replace(/\n---\s*$/, `\nstatus: superseded\n---`);
    });
  }

  // superseded_by frontmatter
  if (/^superseded_by:\s*/m.test(next)) {
    next = next.replace(/^superseded_by:\s*.*$/m, `superseded_by: ${newId}`);
  } else if (/^---\n([\s\S]*?)\n---/.test(next)) {
    next = next.replace(/^---\n([\s\S]*?)\n---/, (fm) => fm.replace(/\n---\s*$/, `\nsuperseded_by: ${newId}\n---`));
  }

  // last_reviewed
  if (/^last_reviewed:\s*/m.test(next)) {
    next = next.replace(/^last_reviewed:\s*.*$/m, `last_reviewed: ${date}`);
  }

  const link = `[[${newId} - ${newTitle}|${newId}]]`;
  const section = `\n## Superseded by\n\nSuperseded by ${link}.\n`;
  if (/^## Superseded by\b/m.test(next)) {
    next = next.replace(/^## Superseded by\b[\s\S]*?(?=^## |\s*$)/m, `## Superseded by\n\nSuperseded by ${link}.\n\n`);
  } else {
    next = next.replace(/\s*$/, "") + "\n" + section;
  }

  return next.endsWith("\n") ? next : next + "\n";
}

export function buildDecisionIndexHeader(project: string, date = new Date().toISOString().slice(0, 10)): string {
  return [
    "---",
    "type: context",
    "scope: project",
    "relevance: medium",
    `last_reviewed: ${date}`,
    "---",
    "# Decision index",
    "",
    `Project: ${project}`,
    "",
    "## Active",
    "",
    "## Superseded",
    "",
  ].join("\n");
}

export function buildDecisionIndexEntry(params: {
  decisionId: string;
  title: string;
  summary: string;
  status: string;
  date: string;
  supersedes?: string;
  supersededBy?: string;
}): string {
  const safeTitle = sanitizeDecisionTitle(params.title);
  const shortSummary = params.summary.replace(/\s+/g, " ").trim();
  let extra = "";
  if (params.supersedes) extra += ` (supersedes ${params.supersedes})`;
  if (params.supersededBy) extra += ` (superseded by ${params.supersededBy})`;
  return `- ${params.date} — [[${params.decisionId} - ${safeTitle}|${params.decisionId}]] — ${params.status} — ${shortSummary}${extra}\n`;
}

/**
 * Insert or update a decision line in the index, keeping Active vs Superseded sections.
 * Fail-soft: if structure is unexpected, append under the appropriate heading or at end.
 */
export function upsertDecisionIndexEntry(
  indexContent: string,
  entry: {
    decisionId: string;
    title: string;
    summary: string;
    status: string;
    date: string;
    supersedes?: string;
    supersededBy?: string;
  },
): string {
  let content = indexContent || "";
  if (!content.trim()) {
    content = buildDecisionIndexHeader("unknown");
  }

  // Ensure section headings exist.
  if (!/^## Active\b/m.test(content)) {
    content = content.replace(/\s*$/, "\n\n## Active\n\n");
  }
  if (!/^## Superseded\b/m.test(content)) {
    content = content.replace(/\s*$/, "\n\n## Superseded\n\n");
  }

  // Drop existing index lines for this decision id only (not "supersedes DEC-00N" mentions).
  const idToken = entry.decisionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRe = new RegExp(
    `^- [^\\n]*\\[\\[[^\\]|]*${idToken}[^\\]|]*\\|${idToken}\\]\\][^\\n]*\\n?`,
    "gmi",
  );
  content = content.replace(lineRe, "");

  const line = buildDecisionIndexEntry(entry).replace(/\n$/, "");
  const isSuperseded = entry.status.toLowerCase() === "superseded";
  const heading = isSuperseded ? "## Superseded" : "## Active";

  const headingRe = new RegExp(`^(${heading}\\b[^\\n]*\\n)`, "mi");
  if (headingRe.test(content)) {
    content = content.replace(headingRe, `$1\n${line}\n`);
  } else {
    content = content.replace(/\s*$/, `\n\n${heading}\n\n${line}\n`);
  }

  // Collapse excessive blank lines
  return content.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

/**
 * Resolve a supersedes ref against decision filenames in a directory listing.
 * Returns the matching file name and parsed id, or a structured error.
 */
export function resolveSupersedesRef(
  ref: string,
  decisionFiles: readonly string[],
): { ok: true; decisionId: string; fileName: string; title: string } | { ok: false; error: string } {
  const trimmed = ref.trim();
  if (!trimmed) {
    return { ok: false, error: "supersedes ref is empty" };
  }

  const decisionId = parseDecisionId(trimmed);
  if (!decisionId) {
    return {
      ok: false,
      error: `Could not parse Decision id from supersedes ref "${trimmed}". Use a DEC-NNN id (for example DEC-001).`,
    };
  }

  const matches = decisionFiles.filter((name) => {
    const base = name.replace(/\.md$/i, "");
    return base.toUpperCase().startsWith(decisionId.toUpperCase());
  });

  if (matches.length === 0) {
    return {
      ok: false,
      error: `No Decision Note found for ${decisionId}. Incomplete supersession ref — not writing either Note.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Ambiguous supersedes ref ${decisionId} matched multiple files: ${matches.join(", ")}`,
    };
  }

  const fileName = matches[0];
  const titlePart = fileName.replace(/\.md$/i, "").replace(new RegExp(`^${decisionId}\\s*-\\s*`, "i"), "");
  return { ok: true, decisionId, fileName, title: titlePart || decisionId };
}

/** Compute next DEC-NNN from existing decision file names. */
export function nextDecisionIdFromNames(fileNames: readonly string[]): string {
  let maxId = 0;
  for (const name of fileNames) {
    const match = name.match(/^DEC-(\d+)/i);
    if (!match) continue;
    maxId = Math.max(maxId, Number(match[1]));
  }
  return `DEC-${String(maxId + 1).padStart(3, "0")}`;
}
