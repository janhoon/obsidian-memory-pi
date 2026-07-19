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

- **ingest**: process new sources into maintained notes; media/source ingests may write generated notes under `memory/projects/<project>/ingests/` and artifacts under `sources/media/`
- **query**: answer from the wiki and file back important synthesis
- **maintain**: keep active context, progress, and decisions current
- **audit**: check for stale, missing, duplicated, or contradictory notes

## Core files

- `index.md`
- `log.md`
- `working-context.md`
- `triggers.md`
- `glossary.md`

## Project files (per project)

- `projects/<project>/active-context.md` — current focus / next step
- `projects/<project>/progress.md` — what shipped recently
- `projects/<project>/overview.md` — goal and constraints
- `projects/<project>/MEMORY.md` — short budgeted project index for the session core pack
- `projects/<project>/decisions/` — Decision notes + index (Active vs Superseded; optional `supersedes` / `superseded_by` links)
- `projects/<project>/system-patterns.md` — durable patterns (usually Proposal-first)

### Project MEMORY index Note

`memory/projects/<project>/MEMORY.md` is an optional, always-on-when-present index Note:

- sections: **Focus**, **Key Decisions**, **Risks**, **Pointers**
- **pointers over prose** — detail lives in topic Notes (Active context, Decisions, progress, overview)
- hard size budget: keep well under `coreLoad.maxFileChars` (default 6000); the core pack also enforces `coreLoad.maxTotalChars` (default 14000) across Working context + Active context + MEMORY
- over-budget content is **truncated on inject**, not expanded into every turn
- projects without the Note continue to work unchanged (core pack skips missing files)
- humans and later Dream maintenance may edit it freely; agents should keep it short

## Writing rules

- write concise summaries, not transcripts, except generated source-ingest notes that preserve extracted text for retrieval and later audit
- preserve wikilinks where they add navigation value
- prefer one durable fact per note section
- decisions should include rationale
- session notes are short-lived and chronological

## Write-policy matrix (content class → action)

Runtime write-policy helpers steer tools; do not rely on skill prose alone.

| Content class | Default action | Safe direct Write? |
| --- | --- | --- |
| Session chronology (`memory/sessions/…`) | Write | yes |
| Progress (`…/progress.md`) | Write | yes |
| Log (`memory/log.md`) | Write | yes |
| Working / Active context | Write | yes |
| Project MEMORY index | Write | yes (keep under budget; pointers only) |
| Preference | Proposal | no |
| Doctrine / rules / system patterns | Proposal | no |
| People fact | Proposal | no |
| Glossary (ambiguous naming) | Proposal | no |
| Decision (title + summary + rationale) | Decision record | no (use Decision tool) |
| Source (path/URL/media) | Ingest | no (use Ingest) |
| Uncertain durable claim | Proposal | no |

Safe direct targets stay limited to chronological / progress-style Wiki Notes and the Log. Wrong durable Memory is worse than none: preferences and doctrine default to Proposal.
