---
name: memory-audit
description: Audit the Obsidian memory wiki for staleness, missing links, duplication, contradictions, and structural drift. Use when the user asks to review or clean up the knowledge base.
---

# Memory Audit

Use this skill for maintenance passes over the wiki.

## Audit checklist

- stale working-context or progress notes
- orphan pages with weak linking
- repeated notes covering the same decision
- contradictory summaries
- missing project pages for frequently referenced topics
- glossary gaps for names, aliases, or codenames

## Workflow

1. Start with `memory_audit` for a deterministic pass.
2. Read flagged notes with `memory_get` or `memory_search` only when you need more context.
3. Group issues by severity.
4. Report proposed changes clearly.
5. Apply low-risk fixes directly only when the user asked for cleanup, otherwise ask first.
6. Queue approval-sensitive fixes with `memory_propose_write`.
7. Log important audit passes in `memory/log.md`.
