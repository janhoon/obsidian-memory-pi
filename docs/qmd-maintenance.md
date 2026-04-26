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

## Future automation inside the Pi extension

The next extension-level improvement should be a debounced background sync:

- Add config such as:
  ```json
  "qmdSync": {
    "enabled": true,
    "mode": "update",
    "debounceMs": 30000,
    "embed": "manual"
  }
  ```
- After `memory_write`, `memory_record_decision`, applied review proposals, session note writes, and pre-compaction flushes, mark QMD dirty.
- Debounce `qmd update` so multiple writes in one turn cause one refresh.
- Keep `qmd embed` manual or end-of-session by default because embeddings can be slow on CPU.
- Add a `/memory-qmd-sync` command for explicit foreground refresh and a widget warning when QMD is stale.

Until that lands, use `scripts/qmd-memory-sync.sh` as the canonical manual/cron/systemd entrypoint.
