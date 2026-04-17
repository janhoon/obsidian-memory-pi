---
name: memory-recall
description: Retrieve durable context from the Obsidian memory wiki when the user asks to continue, catch up, remember prior decisions, explain why something was done, or answer from long-term project memory.
---

# Memory Recall

Use this skill when the request depends on prior context that may not be in the current chat.

## Workflow

1. Call `memory_status` if memory readiness is unclear.
2. Call `memory_search` before broad file reads.
3. Default to `scope: project` unless the user clearly wants cross-project or personal/global memory.
4. Read only the top 1-3 notes in full with `memory_get`.
5. Cite paths clearly in your answer.
6. If relevant context is missing, say so explicitly instead of inventing it.

## Retrieval heuristics

Prefer, in order:

- `memory/projects/<project>/active-context.md`
- decision notes
- project overview / system-pattern notes
- `memory/working-context.md`
- glossary / schema / trigger files only when they help disambiguate names or conventions

## Output style

- Start with the answer, not the retrieval process.
- Mention the most relevant note paths.
- Distinguish between:
  - established memory
  - recent session context
  - open uncertainty
