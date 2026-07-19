---
name: memory-maintainer
description: Maintain the Obsidian memory wiki after meaningful progress, decisions, new durable facts, or clarified project status. Use when conversation outcomes should be filed back into long-term memory.
---

# Memory Maintainer

Use this skill when the conversation produced information worth keeping.

## Writing policy

Runtime helpers encode the same content-class matrix the extension uses for system guidance (`write-policy`). Prefer that routing over improvising tool choice.

### Content class → action

| Class | Action | Tool |
| --- | --- | --- |
| session chronology, progress, log, working/active context | Write | `memory_write` |
| preference, doctrine, people fact, glossary, uncertain durable | Proposal | `memory_propose_write` |
| complete Decision (title + summary + rationale) | Decision | `memory_record_decision` |
| Source (path/URL/media) | Ingest | `memory_ingest_source` |

### Safe to write immediately

- `memory/log.md`
- current working-context summaries
- project `active-context.md` and `progress.md` that restate explicit work completed
- session notes under `memory/sessions/<project>/`

### Prefer confirmation first (Proposal)

- durable preferences
- people facts
- project doctrine / rules / system patterns
- glossary additions with ambiguous naming
- any durable claim you are unsure about

When a decision is clearly approved and well-specified, prefer `memory_record_decision` over ad-hoc file edits.
When the user explicitly says things like “remember this”, “save this”, or “make a note”, prefer a reviewable durable capture via `memory_propose_write` unless they clearly want an immediate write on a safe direct target.
Sources (files, URLs, media) use `memory_ingest_source`, not free-form Write/Proposal of the raw Source.

## Workflow

1. Identify what actually changed and which content class it is.
2. Prefer `memory_write` only for safe direct wiki updates; use `memory_propose_write` for confirmation-first updates.
3. Use `memory_record_decision` for approved, well-specified decisions.
4. Use `memory_ingest_source` when a Source path or URL should enter the wiki.
5. Keep edits small and specific.
6. Never write under `sources/` as wiki content.
7. If the update is durable and high-signal, also append a concise log entry.
8. When in doubt, propose the write before making it.

## Good targets

- `memory/working-context.md`
- `memory/projects/<project>/active-context.md`
- `memory/projects/<project>/progress.md`
- `memory/projects/<project>/decisions/*.md`
- `memory/log.md`
