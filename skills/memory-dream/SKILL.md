---
name: memory-dream
description: Run a manual Dream pass to consolidate recent Session notes into semantic Wiki Notes (Active context, MEMORY index, progress) and queue Proposals for sensitive claims. Use when the user asks to dream, consolidate memory, promote session notes, or refresh project continuity Notes.
---

# Memory Dream (manual)

Dream consolidates short-lived Session chronology into durable Wiki structure.

## When to use

- User asks to `/memory-dream`, “run dream”, “consolidate session notes”, or “promote memory”
- End of a work block when Session notes are noisy and Active context is stale

## Rules

1. Prefer the `/memory-dream` operator command (or the extension’s Dream planner) over free-form file edits.
2. **Direct Write only** for safe targets: Active context, MEMORY index (under budget), progress, Log.
3. **Proposal only** for preferences, doctrine, people facts, glossary, incomplete Decisions.
4. **Never hard-delete** Wiki Notes. Destructive cleanup stays Proposal-only (or Audit enqueue).
5. Always append a Log entry that Dream ran.
6. After Wiki mutations, QMD should be marked dirty (the extension does this).

## Workflow

1. Confirm project slug (`memory_status` if unsure).
2. Run `/memory-dream` (optional lookback days).
3. Review queued Proposals via `/memory-review` or `memory_review_status`.
4. Apply only what the human accepts.

## Out of scope

- Idle/automatic Dream scheduling (separate ticket)
- Silent doctrine Writes
- Full Decision recording without title/summary/rationale (use `memory_record_decision` when complete)
