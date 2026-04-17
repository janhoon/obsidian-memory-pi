---
name: memory-ingest
description: Ingest new sources into the Obsidian memory wiki by summarizing the source, updating relevant notes, linking related pages, and logging the operation.
---

# Memory Ingest

Use this skill when a new article, document, transcript, or research result should become part of the persistent wiki.

## Workflow

1. Treat `sources/` as immutable.
2. Read the new source.
3. Identify which existing notes should change.
4. Update summaries, concepts, project pages, or decisions conservatively.
5. Append a short entry to `memory/log.md`.
6. If the result is novel and synthesis-heavy, create or update an insight note.

## Rules

- Do not duplicate the raw source into the wiki.
- Prefer synthesis over transcript-like copying.
- Call out contradictions when new information challenges existing notes.
- Keep wikilinks explicit and useful.
