# obsidian-memory-pi

A Pi package blueprint and MVP scaffold for a markdown-first memory system built on:

- **Obsidian** for the canonical knowledge graph
- **QMD** for local retrieval and ranking
- **Pi extensions + skills + prompts** for native orchestration

## Current scope

This package is the first implementation pass. It currently provides:

- a Pi extension with:
  - `memory_status`
  - `memory_search`
  - `memory_get`
  - `memory_write`
  - `memory_propose_write`
  - `memory_review_status`
  - `memory_audit`
  - `memory_record_decision`
  - `memory_ingest_source`
  - `/memory-status`
  - `/memory-search <query>`
  - `/memory-ingest [--kind image|video|audio|document] [--copy|--no-copy] [--no-refresh] <path-or-url> [title]`
  - `/memory-review [list|show|pick|apply|discard] [id|next|all]`
  - `/memory-audit-now [scope] [project] [staleDays]`
  - `/memory-init-config`
  - `/memory-reload`
  - automatic pre-answer memory recall heuristics via `before_agent_start`
  - below-editor memory activity indicators for recall, reads, searches, writes, review, and audit operations
  - configurable auto-recall timeout / activity-clear delay under `autoRecall.timeoutMs` and `autoRecall.clearDelayMs`
  - automatic proposal queuing for explicit `remember this` / `save this` style requests
  - automatic session-note writing on session start and agent completion
  - pre-compaction session flushing before Pi compresses context
- memory workflow skills:
  - `memory-recall`
  - `memory-maintainer`
  - `memory-ingest`
  - `memory-audit`
- prompt templates:
  - `/memory-load`
  - `/memory-audit`
  - `/memory-decide`
- starter vault templates for an Obsidian wiki layout

## What is still intentionally light

This is still an early system, not the finished product. The following are still roadmap items:

- stronger memory write schemas for facts / insights / preferences
- background QMD syncing and richer health widgets
- smarter contradiction detection beyond heuristic candidates
- richer source-ingest automation beyond the initial Docling local-path/URL flow
- richer policy for where auto-captured facts should land beyond active-context / working-context
- richer review workflows beyond the current widget + picker

## Package layout

```text
obsidian-memory-pi/
├── docs/
├── extensions/
│   └── obsidian-memory/
├── prompts/
├── skills/
└── templates/
```

## Install options

### Option 1: local package path

```bash
pi install ~/.pi/packages/obsidian-memory-pi
```

### Option 2: global Pi settings

Add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-web-access",
    "/home/janhoon/.dotfiles/pi/.pi/packages/obsidian-memory-pi"
  ]
}
```

## Runtime config

The extension reads configuration from:

```text
~/.pi/agent/memory/config.json
```

A starter file is available at:

```text
~/.pi/agent/memory/config.example.json
```

Automatic recall uses `autoRecall.timeoutMs` (default `60000`) and `autoRecall.clearDelayMs` (default `5000`) when those fields are omitted from config.

Media/source ingest uses Docling as an external command. By default the extension runs `docling` and `ffmpeg` from `PATH`; override these under `ingest.doclingCommand` and `ingest.ffmpegCommand` if you use wrappers such as `uvx docling`. `memory_ingest_source` and `/memory-ingest` accept local paths and `http(s)` URLs, write generated notes directly under `memory/projects/<project>/ingests/`, store raw/derived artifacts under `sources/media/`, and refresh QMD by default.

## Media/source ingest

After Docling is available on `PATH`, users can ingest sources with:

```bash
/memory-ingest ./diagram.png "Architecture diagram"
/memory-ingest https://example.com/report.pdf
/memory-ingest --kind video ./demo.mp4 "Demo walkthrough"
```

Agents can also call `memory_ingest_source` with `kind: "video"` for direct video URLs or paths that lack a recognizable extension. Video ingest references the raw video by default, samples frames with `ffmpeg`, runs Docling/OCR over sampled frames, and stores derived artifacts under `sources/media/`.

## Suggested next steps

1. Copy `config.example.json` to `config.json`
2. Set `vaultPath` and `qmdCollection`
3. Copy the vault templates into an Obsidian vault
4. Index the vault with QMD
5. Install Docling if you want source/media ingest, for example `pipx install docling`, `uv tool install docling`, or configure `ingest.doclingCommand` to a working command
6. Reload Pi

## Related docs

- `docs/blueprint.md`
- `templates/vault/`
- `~/.pi/agent/memory/README.md`
