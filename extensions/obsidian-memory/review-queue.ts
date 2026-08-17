/**
 * Review queue order, targeting, and Triage view model.
 *
 * Overlay, slash, and memory_review_resolve are surfaces over one Review resolve
 * operation. This module is the shared seam.
 *
 * Domain: Proposal, Review queue, Triage, Inspect, Apply, Discard, Review resolve.
 */

export type ReviewProposalAction = "append_log" | "append_file" | "write_file";
export type ReviewProposalStatus = "pending" | "applied" | "discarded";
export type ReviewProposalSource = "assistant" | "auto" | "manual";

export type ReviewProposal = {
  id: string;
  createdAt: string;
  project?: string;
  source: ReviewProposalSource;
  /** Stable origin for metrics (extract/dream/audit/explicit/fallback). Survives Apply. */
  origin?: string;
  rationale?: string;
  action: ReviewProposalAction;
  path?: string;
  title?: string;
  content: string;
  status: ReviewProposalStatus;
};

export const TRIAGE_SHORTCUT = "ctrl+shift+m";
export const TRIAGE_PREVIEW_LINES = 10;
export const TRIAGE_KEYS = {
  apply: "a",
  discard: "d",
  expand: "e",
  leave: "escape",
} as const;

export type ReviewResolveAction = "apply" | "discard";

export type ReviewResolveTarget =
  | { kind: "ids"; ids: string[] }
  | { kind: "next" }
  | { kind: "all" }
  | { kind: "project"; project?: string };

export type ReviewResolveRequest = {
  action: ReviewResolveAction;
  target: "ids" | "next" | "all" | "project";
  ids?: string[];
  project?: string;
};

export type ReviewResolvePlan =
  | { ok: true; action: ReviewResolveAction; proposals: ReviewProposal[] }
  | { ok: false; reason: string };

export type TriageKeyAction = "apply" | "discard" | "toggle-expand" | "leave" | "ignore";

export type TriageViewModel = {
  id: string;
  project: string;
  source: ReviewProposalSource;
  action: ReviewProposalAction;
  path: string;
  rationale: string;
  previewLines: string[];
  contentLines: string[];
  expanded: boolean;
  index: number;
  total: number;
  currentProjectCount: number;
};

function createdAtMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameProject(proposal: Pick<ReviewProposal, "project">, project?: string): boolean {
  if (!project) return false;
  return (proposal.project ?? "") === project;
}

export function resolveProposalTarget(proposal: Pick<ReviewProposal, "action" | "path">): string {
  return proposal.action === "append_log" ? "memory/log.md" : proposal.path?.trim() || "(missing path)";
}

/** Pending Proposals in Triage order: current project oldest first, then the rest oldest first. */
export function getPendingReviewProposals(queue: ReviewProposal[], currentProject?: string): ReviewProposal[] {
  const pending = queue.filter((item) => item.status === "pending");
  const byOldest = (a: ReviewProposal, b: ReviewProposal) => createdAtMs(a.createdAt) - createdAtMs(b.createdAt);
  if (!currentProject) {
    return [...pending].sort(byOldest);
  }
  const here = pending.filter((item) => sameProject(item, currentProject)).sort(byOldest);
  const rest = pending.filter((item) => !sameProject(item, currentProject)).sort(byOldest);
  return [...here, ...rest];
}

export function countCurrentProjectPending(queue: ReviewProposal[], currentProject?: string): number {
  return getPendingReviewProposals(queue, currentProject).filter((item) => sameProject(item, currentProject)).length;
}

export function findReviewProposal(
  queue: ReviewProposal[],
  token: string | undefined,
  currentProject?: string,
): ReviewProposal | undefined {
  const pending = getPendingReviewProposals(queue, currentProject);
  if (!token || token === "next") return pending[0];
  const match = (item: ReviewProposal) => item.id === token || item.id.startsWith(token);
  return pending.find(match) ?? queue.find(match);
}

export function parseReviewResolveRequest(input: ReviewResolveRequest): ReviewResolveTarget | { error: string } {
  if (input.target === "ids") {
    const ids = (input.ids ?? []).map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return { error: "target=ids requires one or more ids." };
    return { kind: "ids", ids };
  }
  if (input.target === "next") return { kind: "next" };
  if (input.target === "all") return { kind: "all" };
  return { kind: "project", project: input.project?.trim() || undefined };
}

export function planReviewResolve(
  queue: ReviewProposal[],
  request: ReviewResolveRequest,
  currentProject?: string,
): ReviewResolvePlan {
  const parsed = parseReviewResolveRequest(request);
  if ("error" in parsed) return { ok: false, reason: parsed.error };

  const pending = getPendingReviewProposals(queue, currentProject);

  if (parsed.kind === "next") {
    const next = pending[0];
    if (!next) return { ok: false, reason: "No pending Proposals." };
    return { ok: true, action: request.action, proposals: [next] };
  }

  if (parsed.kind === "all") {
    if (pending.length === 0) return { ok: false, reason: "No pending Proposals." };
    return { ok: true, action: request.action, proposals: pending };
  }

  if (parsed.kind === "project") {
    const project = parsed.project || currentProject;
    if (!project) return { ok: false, reason: "target=project requires a project slug." };
    const scoped = getPendingReviewProposals(queue, project).filter((item) => sameProject(item, project));
    if (scoped.length === 0) return { ok: false, reason: `No pending Proposals for project ${project}.` };
    return { ok: true, action: request.action, proposals: scoped };
  }

  const found: ReviewProposal[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const matchId = (item: ReviewProposal, id: string) => item.id === id || item.id.startsWith(id);
  for (const id of parsed.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const proposal = pending.find((item) => matchId(item, id)) ?? queue.find((item) => matchId(item, id));
    if (!proposal) {
      missing.push(id);
      continue;
    }
    if (proposal.status !== "pending") {
      missing.push(`${id} (${proposal.status})`);
      continue;
    }
    found.push(proposal);
  }
  if (missing.length > 0) {
    return { ok: false, reason: `Unknown or not pending: ${missing.join(", ")}.` };
  }
  if (found.length === 0) return { ok: false, reason: "No matching pending Proposals." };
  return { ok: true, action: request.action, proposals: found };
}

export function handleTriageKey(data: string): TriageKeyAction {
  if (data === "\x1b" || data === "escape" || data === "esc" || data === TRIAGE_KEYS.leave) return "leave";
  const key = data.trim().toLowerCase();
  if (key === "a" || key === TRIAGE_KEYS.apply) return "apply";
  if (key === "d" || key === TRIAGE_KEYS.discard) return "discard";
  if (key === "e" || key === TRIAGE_KEYS.expand) return "toggle-expand";
  return "ignore";
}

function splitContentLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

export function buildTriageViewModel(
  proposal: ReviewProposal,
  queue: ReviewProposal[],
  currentProject?: string,
  expanded = false,
): TriageViewModel {
  const pending = getPendingReviewProposals(queue, currentProject);
  const index = Math.max(0, pending.findIndex((item) => item.id === proposal.id));
  const contentLines = splitContentLines(proposal.content);
  return {
    id: proposal.id,
    project: proposal.project?.trim() || "(none)",
    source: proposal.source,
    action: proposal.action,
    path: resolveProposalTarget(proposal),
    rationale: proposal.rationale?.trim() || "(none)",
    previewLines: contentLines.slice(0, TRIAGE_PREVIEW_LINES),
    contentLines,
    expanded,
    index,
    total: pending.length,
    currentProjectCount: countCurrentProjectPending(queue, currentProject),
  };
}

export function formatTriageLines(view: TriageViewModel): string[] {
  const bodyLabel = view.expanded ? "Content" : "Preview";
  const body = view.expanded ? view.contentLines : view.previewLines;
  const expandHint = view.expanded ? "e Collapse" : "e Expand";
  return [
    `Review ${view.index + 1} of ${view.total} · ${view.currentProjectCount} this project`,
    `${view.id} · ${view.project} · ${view.source} · ${view.action}`,
    view.path,
    "",
    "Rationale:",
    view.rationale,
    "",
    `${bodyLabel}:`,
    ...body,
    "",
    `a Apply  d Discard  ${expandHint}  esc Leave`,
  ];
}

export function formatReviewList(queue: ReviewProposal[], currentProject?: string): string {
  const pending = getPendingReviewProposals(queue, currentProject);
  if (pending.length === 0) return "No pending review proposals.";
  return pending.map((proposal) => `- ${renderProposalPreview(proposal)}`).join("\n");
}

export function renderProposalPreview(proposal: ReviewProposal): string {
  const preview = proposal.content.replace(/\s+/g, " ").trim().slice(0, 100);
  return `${proposal.id} · ${proposal.action} · ${resolveProposalTarget(proposal)}${preview ? ` · ${preview}` : ""}`;
}

export function formatProposalDetails(proposal: ReviewProposal): string {
  return [
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
}

export function formatReviewWidgetCue(input: {
  pendingCount: number;
  next?: Pick<ReviewProposal, "id" | "project" | "action" | "path">;
  shortcut?: string;
}): { nextLine?: string; hintLine?: string } {
  if (input.pendingCount <= 0 || !input.next) return {};
  const project = input.next.project?.trim() || "(none)";
  return {
    nextLine: `next ${input.next.id} · ${project} · ${resolveProposalTarget(input.next)}`,
    hintLine: input.shortcut ?? TRIAGE_SHORTCUT,
  };
}

export function formatResolveResult(action: ReviewResolveAction, proposals: ReviewProposal[]): string {
  const verb = action === "apply" ? "Applied" : "Discarded";
  const ids = proposals.map((proposal) => proposal.id).join(", ");
  return `${verb} ${proposals.length} review proposal(s): ${ids}.`;
}
