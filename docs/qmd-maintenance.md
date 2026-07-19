# QMD maintenance for Obsidian memory

QMD is the retrieval index for the Obsidian memory vault. The markdown files remain canonical; QMD must be refreshed whenever memory files change enough that search/recall quality matters.

## Current sync script

Use the repo script:

```bash
npm run qmd:sync
# or directly
scripts/qmd-memory-sync.sh
```

The script reads `~/.pi/agent/memory/config.json`, then:

1. validates `vaultPath`, `qmdCommand`, and `qmdCollection`
2. verifies the QMD collection exists
3. runs `qmd update`
4. runs `qmd embed` with conservative CPU-friendly batch limits
5. prints `qmd status`

Useful variants:

```bash
npm run qmd:status            # status only
npm run qmd:update            # update lexical/file index only, skip embeddings
scripts/qmd-memory-sync.sh --force-embed
scripts/qmd-memory-sync.sh --cleanup
scripts/qmd-memory-sync.sh --pull
```

## Recommended operating process

### After meaningful memory writes

Run the lightweight update path if you need immediate keyword recall:

```bash
npm run qmd:update
```

Run full sync if semantic/hybrid recall should see the change immediately:

```bash
npm run qmd:sync
```

### End of work session

Run full sync after durable memory maintenance or session synthesis:

```bash
npm run qmd:sync
```

Then verify:

```bash
npm run qmd:status
qmd search "recent project or decision term" -c obsidian-memory -n 5
qmd query "recent project or decision term" -c obsidian-memory -n 5 --no-rerank
```

### Weekly or after bulk changes

Run a clean refresh:

```bash
scripts/qmd-memory-sync.sh --cleanup
```

Use `--force-embed` only after QMD embedding-model changes, chunking changes, or suspected vector corruption:

```bash
scripts/qmd-memory-sync.sh --force-embed
```

## Keeping up with QMD behavior changes

When QMD changes version or behavior, do a compatibility pass:

1. Capture baseline:
   ```bash
   qmd --help
   qmd status
   qmd collection show obsidian-memory
   ```
2. Check whether commands/flags used by `scripts/qmd-memory-sync.sh` still exist:
   - `qmd update`
   - `qmd update --pull`
   - `qmd embed`
   - `qmd embed -f`
   - `qmd embed --max-docs-per-batch`
   - `qmd embed --max-batch-mb`
   - `qmd status`
   - `qmd collection show`
3. Run smoke tests:
   ```bash
   npm run qmd:sync
   qmd search "memory audit" -c obsidian-memory -n 5
   qmd query "what did we decide about browser automation" -c obsidian-memory -n 5 --no-rerank
   qmd get qmd://obsidian-memory/memory/index.md
   ```
4. Record any changed command semantics in this document and in durable memory if it affects future agent behavior.
5. If QMD changed chunking or embedding behavior, run:
   ```bash
   scripts/qmd-memory-sync.sh --force-embed
   ```

## Extension automation (debounced dirty sync)

The Pi extension keeps a dirty flag after durable wiki writes and refreshes QMD on a debounce so Auto-recall / Search can see new Notes without a stampede of child processes.

Config (`~/.pi/agent/memory/config.json`):

```json
"qmdSync": {
  "enabled": true,
  "mode": "update",
  "debounceMs": 30000,
  "embed": "end_of_session",
  "markSessionNotesDirty": false,
  "showStaleInWidget": true
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch for auto dirty + debounced refresh |
| `mode` | Default operator/debounced path: `update` (lexical only) or `full` (update + embed) |
| `debounceMs` | Coalesce window after a dirty mark (default 30s ≈ “within about a minute”) |
| `embed` | `manual` (never auto-embed), `end_of_session` (embed on session_shutdown when needed), `after_update` (embed after every debounced update) |
| `markSessionNotesDirty` | When false (default), session-note appends do not dirty the index |
| `showStaleInWidget` | Show `QMD stale` / `QMD syncing…` in the below-editor widget |

### What marks dirty

- `memory_write`
- `memory_record_decision`
- Review proposal **Apply** (`/memory-review apply` / pick)
- `memory_ingest_source` when it did **not** already refresh QMD (successful ingest refresh **clears** dirty)
- Session-note / pre-compaction appends only when `markSessionNotesDirty` is true

### Operator command

```text
/memory-qmd-sync            # uses config.qmdSync.mode
/memory-qmd-sync update     # foreground qmd update only
/memory-qmd-sync full       # update + embed
/memory-qmd-sync full --force-embed
```

Concurrent writes and concurrent sync requests share one in-flight QMD process; a write that lands mid-sync keeps the index dirty and schedules another debounced pass.

The shell script remains the canonical cron/systemd entrypoint outside Pi:

```bash
scripts/qmd-memory-sync.sh
```
