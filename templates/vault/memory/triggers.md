---
type: rule
scope: global
relevance: high
last_reviewed: 2026-04-15
---
# Memory triggers

## Loading triggers

Load project memory when the conversation includes:

- continue / catch up / last session
- what did we decide
- why did we do this
- project status
- architecture or system pattern questions

### Session core pack (always-on, budgeted)

On session start (or first turn when configured), inject when present:

1. `memory/working-context.md`
2. `memory/projects/<project>/active-context.md`
3. `memory/projects/<project>/MEMORY.md` (optional project MEMORY index)

Missing Notes are skipped. Over-budget content is truncated on inject. Prefer the MEMORY index for pointers; use Search/Read for detail.

## Writing triggers

Consider filing updates when the conversation establishes:

- a durable decision and its rationale → Decision path when complete; otherwise Proposal
- a stable preference or rule → Proposal (never silent doctrine Write)
- a new glossary term or alias → Proposal when naming is ambiguous
- a meaningful project status / progress change → direct Write on progress / active context (and refresh MEMORY index pointers if focus/risks shifted)
- a research insight worth preserving → Proposal unless it is pure progress chronology
- a Source path or URL → Ingest
- explicit memory language like `remember this`, `save this`, or `make a note` → write-policy router chooses tool

## Continuity triggers

- before compaction, flush a concise session summary into `memory/sessions/<project>/YYYY-MM-DD.md`
- default explicit memory captures to reviewable Proposals unless the target is a safe direct Write path (Log, progress, session notes, working/active context)
