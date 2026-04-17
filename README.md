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
  - `/memory-status`
  - `/memory-search <query>`
  - `/memory-review [list|show|pick|apply|discard] [id|next|all]`
  - `/memory-audit-now [scope] [project] [staleDays]`
  - `/memory-init-config`
  - `/memory-reload`
  - automatic pre-answer memory recall heuristics via `before_agent_start`
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
- source-ingest automation
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

## Suggested next steps

1. Copy `config.example.json` to `config.json`
2. Set `vaultPath` and `qmdCollection`
3. Copy the vault templates into an Obsidian vault
4. Index the vault with QMD
5. Reload Pi

## Related docs

- `docs/blueprint.md`
- `templates/vault/`
- `~/.pi/agent/memory/README.md`
