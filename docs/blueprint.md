# Obsidian Memory Pi Package Blueprint

## Goal

Make persistent memory feel native inside Pi by combining:

1. **Obsidian markdown files** as the source of truth
2. **QMD** as the retrieval sidecar
3. **Pi extension hooks** for automatic memory recall and memory-writing workflows

## Principles

- markdown is canonical
- raw sources are immutable
- QMD only helps find the right files
- Pi decides when memory should be fetched or written
- durable writes are conservative and reviewable by default, except trusted source/media ingest flows that write generated notes directly
- sparse loading beats dumping the whole vault into context

## Package components

### Extension

Primary runtime surface.

Responsibilities:

- load config from `~/.pi/agent/memory/config.json`
- detect the current project namespace from cwd / git root
- expose model-callable tools:
  - `memory_status`
  - `memory_search`
  - `memory_get`
  - `memory_write`
  - `memory_propose_write`
  - `memory_review_status`
  - `memory_audit`
  - `memory_record_decision`
  - `memory_ingest_source`
- auto-inject relevant memory before answers when triggers match
- write automatic session summaries under `memory/sessions/<project>/YYYY-MM-DD.md`
- auto-queue review proposals when the user explicitly says things like `remember this` or `save this`
- flush a compact session snapshot before Pi compacts context
- expose operator commands:
  - `/memory-status`
  - `/memory-search <query>`
  - `/memory-review [list|show|pick|apply|discard] [id|next|all]`
  - `/memory-ingest [--kind image|video|audio|document] [--copy|--no-copy] [--no-refresh] <path-or-url> [title]`
  - `/memory-audit-now [scope] [project] [staleDays]`
  - `/memory-init-config`
  - `/memory-reload`

### Skills

Workflow instructions loaded on demand.

- `memory-recall` → sparse retrieval strategy
- `memory-maintainer` → how and when to write durable memory
- `memory-ingest` → process new sources into the wiki
- `memory-audit` → lint and health-check the wiki

### Prompt templates

Thin forcing functions for manual workflows.

- `/memory-load`
- `/memory-audit`
- `/memory-decide`

### Vault templates

Starter markdown files for the canonical wiki layout.

## Event hook plan

### `session_start`

- load runtime config
- load the review queue
- detect project slug
- set status line / widget
- surface misconfiguration clearly
- append a session-start marker to today's session note

### `before_agent_start`

- detect continuity / memory / decision / context language
- show a compact below-editor recall activity indicator while QMD lookup is running
- run a lightweight QMD lookup
- inject compact memory context
- instruct the model to call `memory_get` for full-note reads when needed
- nudge the model toward `memory_propose_write` or `memory_record_decision` when explicit memory-intent language is detected

### `agent_end`

Current behavior:

- append a concise session-note entry for each completed user prompt
- record the last user request, assistant summary, and tool names
- auto-queue a fallback review proposal when the user explicitly asked to remember something and no memory tool was called

### `session_before_compact`

Current behavior:

- flush a compact deterministic summary of the soon-to-be-compacted span into the session note
- preserve a brief file-ops snapshot before context compression

### review queue

Current behavior:

- queue durable memory proposals via `memory_propose_write`
- let the user list/show/pick/apply/discard proposals from `/memory-review`

## Tool contracts

### `memory_status`

Return:

- config path
- vault path
- project slug
- QMD collection / command
- readiness / warnings
- best-effort QMD health preview

### `memory_search`

Inputs:

- `query`
- `scope`: `project | global | session | all`
- `mode`: `keyword | semantic | hybrid`
- `limit`
- optional `project`

Behavior:

- shells out to QMD
- parses JSON results
- filters by scope prefixes
- returns snippets + file metadata

### `memory_get`

Inputs:

- vault-relative path from `memory_search`
- optional line offset / limit

Behavior:

- reads directly from the vault
- supports docid fallback through `qmd get`

### `memory_write`

Inputs:

- `append_log`
- `append_file`
- `write_file`

Guardrails:

- writes only under `memory/`
- blocks writes to `sources/`
- uses Pi's file mutation queue

### `memory_propose_write`

Inputs:

- same shape as `memory_write`
- optional `rationale`
- optional `project`

Behavior:

- stores a pending write in `~/.pi/agent/memory/review-queue.json`
- does not mutate the vault immediately
- surfaces the proposal via `/memory-review` and `memory_review_status`

### `memory_audit`

Inputs:

- optional `scope`
- optional `project`
- optional `staleDays`

Behavior:

- scans markdown notes under `memory/`
- reports stale notes, broken wikilinks, orphan candidates, duplicate titles, exact duplicate bodies, and heuristic contradiction candidates

### `memory_record_decision`

Inputs:

- `title`
- `summary`
- `rationale`
- optional `alternatives`
- optional `consequences`
- optional `status`
- optional `project`
- optional `date`

Behavior:

- creates `DEC-XXX - Title.md` under `memory/projects/<project>/decisions/`
- appends an entry to `memory/projects/<project>/decisions/index.md`
- appends a log entry to `memory/log.md`

### `memory_ingest_source`

Inputs:

- `source`: local file path, `file://` URL, or `http(s)` URL
- optional `kind`: `auto | document | image | video | audio`
- optional `title`
- optional `project`
- optional `tags`
- optional `copySource`
- optional `refreshIndex`
- optional `targetPath` under `memory/`

Behavior:

- shells out to Docling (`ingest.doclingCommand`) to convert source material to Markdown
- for videos, attempts Docling ASR and `ffmpeg` frame sampling followed by Docling OCR on sampled frames
- copies non-video raw sources into `sources/media/<project>/...` when they are below the configured size limit
- stores full derived Markdown and sampled frames under `sources/media/<project>/...`
- writes a generated memory note directly under `memory/projects/<project>/ingests/` by default
- appends a log entry to `memory/log.md`
- runs QMD update/embed by default so the generated note participates in retrieval

## Canonical vault shape

```text
vault/
├── AGENTS.md
├── sources/
│   └── media/
└── memory/
    ├── schema.md
    ├── index.md
    ├── log.md
    ├── working-context.md
    ├── triggers.md
    ├── glossary.md
    ├── global/
    ├── projects/
    │   └── <project>/ingests/
    └── sessions/
```

## Configuration surface

```json
{
  "vaultPath": "/absolute/path/to/obsidian-vault",
  "qmdCommand": "qmd",
  "qmdCollection": "obsidian-memory",
  "defaultSearchMode": "hybrid",
  "defaultLimit": 5,
  "routerFiles": [
    "memory/schema.md",
    "memory/index.md",
    "memory/working-context.md",
    "memory/triggers.md",
    "memory/glossary.md"
  ],
  "scopePrefixes": {
    "global": [
      "memory/schema.md",
      "memory/index.md",
      "memory/triggers.md",
      "memory/glossary.md",
      "memory/working-context.md",
      "memory/global/"
    ],
    "projectTemplate": "memory/projects/{project}/",
    "sessionTemplate": "memory/sessions/{project}/"
  },
  "autoRecall": {
    "enabled": true,
    "maxResults": 4,
    "timeoutMs": 60000,
    "clearDelayMs": 5000,
    "triggerPatterns": [
      "continue",
      "last session",
      "what did we decide",
      "why did we",
      "remember",
      "context",
      "catch up"
    ]
  },
  "autoSessionNotes": {
    "enabled": true,
    "maxAssistantChars": 280,
    "includeTools": true
  },
  "autoPropose": {
    "enabled": true,
    "triggerPatterns": [
      "remember this",
      "save this",
      "make a note",
      "note this"
    ]
  },
  "preCompactionFlush": {
    "enabled": true,
    "maxTurns": 8,
    "includeFiles": true
  },
  "ingest": {
    "doclingCommand": "docling",
    "ffmpegCommand": "ffmpeg",
    "doclingTimeoutMs": 120000,
    "ffmpegTimeoutMs": 120000,
    "qmdSyncAfterIngest": true,
    "qmdUpdateTimeoutMs": 60000,
    "qmdEmbedTimeoutMs": 180000,
    "maxSourceCopyBytes": 26214400,
    "maxExtractedCharsInMemory": 50000,
    "videoFrameIntervalSec": 30,
    "maxVideoFrames": 12,
    "doclingImageExportMode": "placeholder"
  }
}
```

## Rollout plan

### Phase 1

- package scaffold
- config file convention
- QMD-backed read tools
- manual commands
- auto recall injection

### Phase 2

- working-context / log write helpers
- review queue commands + widget
- automatic session notes
- explicit-memory auto capture
- pre-compaction flush
- better project mapping
- initial Docling-backed source ingest flow

### Phase 3

- richer routing for auto-captured memories
- smarter contradiction detection
- background indexing status
- deeper review UI and triage flows
