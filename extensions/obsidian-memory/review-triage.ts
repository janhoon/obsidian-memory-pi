/**
 * TUI overlay for Proposal Triage.
 *
 * Domain: Triage, Inspect, Proposal, Apply, Discard.
 */

import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  buildTriageViewModel,
  getPendingReviewProposals,
  handleTriageKey,
  type ReviewProposal,
  type TriageViewModel,
} from "./review-queue.js";

export type TriageTheme = {
  fg: (color: string, text: string) => string;
};

export type TriageOverlayResult = "leave" | "empty";

type TriageOverlayOptions = {
  theme: TriageTheme;
  requestRender: () => void;
  getQueue: () => ReviewProposal[];
  currentProject?: string;
  onResolve: (action: "apply" | "discard", proposal: ReviewProposal) => Promise<void>;
  onNotify?: (message: string, level?: "info" | "warning" | "error") => void;
  done: (result: TriageOverlayResult) => void;
};

function wrapPlain(text: string, width: number): string[] {
  const lines = wrapTextWithAnsi(text.replace(/\r\n/g, "\n"), Math.max(1, width));
  return lines.length > 0 ? lines : [""];
}

export class ReviewTriageOverlay {
  private expanded = false;
  private scroll = 0;
  private busy = false;
  private closed = false;
  private proposal: ReviewProposal | undefined;
  private readonly options: TriageOverlayOptions;

  constructor(options: TriageOverlayOptions) {
    this.options = options;
    this.proposal = getPendingReviewProposals(options.getQueue(), options.currentProject)[0];
  }

  handleInput(data: string): boolean {
    if (this.closed || this.busy) return true;

    if (matchesKey(data, "up")) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.options.requestRender();
      return true;
    }
    if (matchesKey(data, "down")) {
      this.scroll += 1;
      this.options.requestRender();
      return true;
    }
    if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, this.scroll - 8);
      this.options.requestRender();
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.scroll += 8;
      this.options.requestRender();
      return true;
    }

    const action = matchesKey(data, "escape")
      ? "leave"
      : matchesKey(data, "e")
        ? "toggle-expand"
        : matchesKey(data, "a")
          ? "apply"
          : matchesKey(data, "d")
            ? "discard"
            : handleTriageKey(data);
    if (action === "leave") {
      this.finish("leave");
      return true;
    }
    if (action === "toggle-expand") {
      this.expanded = !this.expanded;
      this.scroll = 0;
      this.options.requestRender();
      return true;
    }
    if (action === "apply" && this.proposal) {
      void this.resolveFocused("apply");
      return true;
    }
    if (action === "discard" && this.proposal) {
      void this.resolveFocused("discard");
      return true;
    }
    return true;
  }

  render(width: number): string[] {
    const inner = Math.max(24, width);
    const theme = this.options.theme;
    if (!this.proposal) {
      return [truncateToWidth(theme.fg("dim", "No pending Proposals."), inner)];
    }

    const view = this.view();
    const border = "─".repeat(Math.max(1, inner - 2));
    const lines = [
      theme.fg("accent", `╭${border}╮`),
      this.frame(theme.fg("accent", "Triage"), inner, theme),
      this.frame(theme.fg("warning", `${view.index + 1} of ${view.total} · ${view.currentProjectCount} this project`), inner, theme),
      this.frame(`${theme.fg("text", view.id)} · ${view.project} · ${view.source} · ${view.action}`, inner, theme),
      this.frame(theme.fg("dim", view.path), inner, theme),
      this.frame("", inner, theme),
      this.frame(theme.fg("muted", "Rationale"), inner, theme),
      ...wrapPlain(view.rationale, Math.max(1, inner - 4)).map((line) => this.frame(line, inner, theme)),
      this.frame("", inner, theme),
      this.frame(theme.fg("muted", view.expanded ? "Content" : "Preview"), inner, theme),
      ...this.bodyLines(view, Math.max(1, inner - 4)).map((line) => this.frame(line, inner, theme)),
      this.frame("", inner, theme),
      this.frame(theme.fg("dim", `a Apply  d Discard  ${view.expanded ? "e Collapse" : "e Expand"}  esc Leave`), inner, theme),
      theme.fg("accent", `╰${border}╯`),
    ];
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate(): void {
    this.proposal = getPendingReviewProposals(this.options.getQueue(), this.options.currentProject)[0];
    this.expanded = false;
    this.scroll = 0;
  }

  private view(): TriageViewModel {
    return buildTriageViewModel(
      this.proposal as ReviewProposal,
      this.options.getQueue(),
      this.options.currentProject,
      this.expanded,
    );
  }

  private bodyLines(view: TriageViewModel, width: number): string[] {
    const visible = 12;
    const raw = view.expanded ? view.contentLines : view.previewLines;
    const wrapped = raw.flatMap((line) => wrapPlain(line, width));
    const maxScroll = Math.max(0, wrapped.length - visible);
    this.scroll = Math.min(this.scroll, maxScroll);
    const windowed = wrapped.slice(this.scroll, this.scroll + visible);
    if (wrapped.length > this.scroll + visible) {
      windowed.push(`… +${wrapped.length - this.scroll - visible} more`);
    }
    return windowed;
  }

  private frame(text: string, width: number, theme: TriageTheme): string {
    const inner = Math.max(1, width - 2);
    const padded = truncateToWidth(` ${text}`, inner, "…", true);
    return `${theme.fg("accent", "│")}${padded}${theme.fg("accent", "│")}`;
  }

  private async resolveFocused(action: "apply" | "discard"): Promise<void> {
    const proposal = this.proposal;
    if (!proposal) {
      this.finish("empty");
      return;
    }
    this.busy = true;
    try {
      await this.options.onResolve(action, proposal);
      const next = getPendingReviewProposals(this.options.getQueue(), this.options.currentProject)[0];
      if (!next) {
        this.finish("empty");
        return;
      }
      this.proposal = next;
      this.expanded = false;
      this.scroll = 0;
      this.options.requestRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onNotify?.(message, "error");
    } finally {
      this.busy = false;
    }
  }

  private finish(result: TriageOverlayResult): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done(result);
  }
}
