---
type: rule
scope: global
relevance: high
last_reviewed: 2026-04-15
---
# Memory schema

## Layers

1. `sources/` — immutable raw inputs
2. `memory/` — maintained wiki
3. `AGENTS.md` — router instructions for the agent

## Operations

- **ingest**: process new sources into maintained notes
- **query**: answer from the wiki and file back important synthesis
- **maintain**: keep active context, progress, and decisions current
- **audit**: check for stale, missing, duplicated, or contradictory notes

## Core files

- `index.md`
- `log.md`
- `working-context.md`
- `triggers.md`
- `glossary.md`

## Writing rules

- write concise summaries, not transcripts
- preserve wikilinks where they add navigation value
- prefer one durable fact per note section
- decisions should include rationale
- session notes are short-lived and chronological
