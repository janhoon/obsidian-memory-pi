---
name: memory-maintainer
description: Maintain the Obsidian memory wiki after meaningful progress, decisions, new durable facts, or clarified project status. Use when conversation outcomes should be filed back into long-term memory.
---

# Memory Maintainer

Use this skill when the conversation produced information worth keeping.

## Writing policy

### Safe to write immediately

- `memory/log.md`
- current working-context summaries
- progress notes that restate explicit work completed

### Prefer confirmation first

- durable preferences
- decision records
- people facts
- project doctrine / rules
- glossary additions with ambiguous naming

When a decision is clearly approved and well-specified, prefer `memory_record_decision` over ad-hoc file edits.
When the user explicitly says things like “remember this”, “save this”, or “make a note”, prefer a reviewable durable capture via `memory_propose_write` unless they clearly want an immediate write.

## Workflow

1. Identify what actually changed.
2. Prefer `memory_write` for safe direct wiki updates and `memory_propose_write` for confirmation-first updates.
3. Use `memory_record_decision` for approved, well-specified decisions.
4. Keep edits small and specific.
5. Never write under `sources/`.
6. If the update is durable and high-signal, also append a concise log entry.
7. When in doubt, propose the write before making it.

## Good targets

- `memory/working-context.md`
- `memory/projects/<project>/active-context.md`
- `memory/projects/<project>/progress.md`
- `memory/projects/<project>/decisions/*.md`
- `memory/log.md`
