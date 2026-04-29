---
name: memory-ingest
description: Ingest new sources into the Obsidian memory wiki by summarizing the source, updating relevant notes, linking related pages, and logging the operation.
---

# Memory Ingest

Use this skill when a new article, document, image, video, transcript, or research result should become part of the persistent wiki.

## Workflow

1. Treat `sources/` as immutable.
2. If the user provides a local path or `http(s)` URL, prefer `memory_ingest_source` to run the Docling-backed ingest flow.
3. For videos, expect the ingest flow to attempt transcript/ASR plus sampled-frame OCR.
4. Read the generated memory note and/or derived source markdown when follow-up synthesis is needed.
5. Identify which existing notes should change.
6. Update summaries, concepts, project pages, or decisions conservatively.
7. Append a short entry to `memory/log.md` if you make additional manual edits.
8. If the result is novel and synthesis-heavy, create or update an insight note.

## Rules

- Do not manually duplicate the raw source into the wiki; use `memory_ingest_source` for trusted automated source notes and provenance.
- Prefer synthesis over transcript-like copying when making follow-up manual edits.
- Call out contradictions when new information challenges existing notes.
- Keep wikilinks explicit and useful.
