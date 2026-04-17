Audit the Obsidian memory wiki for stale, duplicated, weakly linked, or contradictory notes.

Checklist:
1. Start with `memory_audit` for a deterministic audit pass.
2. Use `memory_get` or `memory_search` only for the notes that need closer inspection.
3. Summarize issues by severity.
4. Propose the smallest safe set of changes.
5. If changes are approval-sensitive, queue them with `memory_propose_write`; otherwise use `memory_write`.
6. Append a log entry for meaningful audit passes.
