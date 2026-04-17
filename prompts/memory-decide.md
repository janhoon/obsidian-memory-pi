---
description: Record a durable project decision in the Obsidian memory wiki
---
Record a durable decision in the Obsidian memory wiki.

Decision topic: $@

Workflow:
1. If the decision is under-specified, ask concise follow-up questions for:
   - summary
   - rationale
   - alternatives considered
   - consequences
2. Once you have enough detail, call `memory_record_decision`.
3. Default to the current project unless the user specifies another one.
4. After recording it, summarize the saved note path and mention any related notes that should also be updated.
