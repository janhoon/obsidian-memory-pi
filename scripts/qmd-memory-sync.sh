#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/qmd-memory-sync.sh [options]

Re-index the configured Obsidian memory vault with QMD and refresh embeddings.
Reads ~/.pi/agent/memory/config.json by default.

Options:
  --config <path>          Memory config path (default: ~/.pi/agent/memory/config.json)
  --no-embed              Run qmd update only; skip qmd embed
  --force-embed           Pass -f to qmd embed and rebuild all embeddings
  --pull                  Pass --pull to qmd update
  --cleanup               Run qmd cleanup before update
  --status-only           Print qmd status and exit
  --max-docs-per-batch N  qmd embed batch doc cap (default: 32)
  --max-batch-mb N        qmd embed batch MB cap (default: 8)
  -h, --help              Show this help

Examples:
  scripts/qmd-memory-sync.sh
  scripts/qmd-memory-sync.sh --no-embed
  scripts/qmd-memory-sync.sh --force-embed
  MEMORY_CONFIG=~/.pi/agent/memory/config.json scripts/qmd-memory-sync.sh
USAGE
}

CONFIG_PATH="${MEMORY_CONFIG:-$HOME/.pi/agent/memory/config.json}"
RUN_EMBED=1
FORCE_EMBED=0
PULL=0
CLEANUP=0
STATUS_ONLY=0
MAX_DOCS_PER_BATCH=32
MAX_BATCH_MB=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="${2:?--config requires a path}"
      shift 2
      ;;
    --no-embed)
      RUN_EMBED=0
      shift
      ;;
    --force-embed)
      FORCE_EMBED=1
      shift
      ;;
    --pull)
      PULL=1
      shift
      ;;
    --cleanup)
      CLEANUP=1
      shift
      ;;
    --status-only)
      STATUS_ONLY=1
      shift
      ;;
    --max-docs-per-batch)
      MAX_DOCS_PER_BATCH="${2:?--max-docs-per-batch requires a number}"
      shift 2
      ;;
    --max-batch-mb)
      MAX_BATCH_MB="${2:?--max-batch-mb requires a number}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Missing memory config: $CONFIG_PATH" >&2
  exit 1
fi

read_config() {
  python3 - "$CONFIG_PATH" "$1" <<'PY'
import json
import sys
from pathlib import Path
config = json.loads(Path(sys.argv[1]).read_text())
value = config.get(sys.argv[2], "")
print(value)
PY
}

QMD_COMMAND="$(read_config qmdCommand)"
QMD_COLLECTION="$(read_config qmdCollection)"
VAULT_PATH="$(read_config vaultPath)"

QMD_COMMAND="${QMD_COMMAND:-qmd}"
if [[ -z "$QMD_COLLECTION" ]]; then
  echo "Config is missing qmdCollection: $CONFIG_PATH" >&2
  exit 1
fi
if [[ -z "$VAULT_PATH" || ! -d "$VAULT_PATH" ]]; then
  echo "Config vaultPath is missing or not a directory: ${VAULT_PATH:-<empty>}" >&2
  exit 1
fi
if ! command -v "$QMD_COMMAND" >/dev/null 2>&1; then
  echo "qmdCommand is not on PATH: $QMD_COMMAND" >&2
  exit 1
fi

LOCK_ROOT="${XDG_RUNTIME_DIR:-/tmp}"
LOCK_DIR="$LOCK_ROOT/obsidian-memory-qmd-sync.${USER:-user}.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another QMD memory sync is already running: $LOCK_DIR" >&2
  exit 75
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

count_markdown() {
  find "$1" -type f -name '*.md' | wc -l | tr -d ' '
}

VAULT_MD_COUNT="$(count_markdown "$VAULT_PATH")"
MEMORY_MD_COUNT=0
if [[ -d "$VAULT_PATH/memory" ]]; then
  MEMORY_MD_COUNT="$(count_markdown "$VAULT_PATH/memory")"
fi

echo "QMD memory sync"
echo "- config:     $CONFIG_PATH"
echo "- qmd:        $QMD_COMMAND"
echo "- collection: $QMD_COLLECTION"
echo "- vault:      $VAULT_PATH"
echo "- markdown:   $VAULT_MD_COUNT vault files, $MEMORY_MD_COUNT under memory/"
echo

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  "$QMD_COMMAND" status
  exit 0
fi

if ! "$QMD_COMMAND" collection show "$QMD_COLLECTION" >/dev/null; then
  echo "QMD collection not found: $QMD_COLLECTION" >&2
  echo "Create it first, for example:" >&2
  echo "  qmd collection add <args for your qmd version>" >&2
  echo "Then verify with:" >&2
  echo "  qmd collection show $QMD_COLLECTION" >&2
  exit 1
fi

if [[ "$CLEANUP" -eq 1 ]]; then
  echo "==> qmd cleanup"
  "$QMD_COMMAND" cleanup
  echo
fi

UPDATE_ARGS=(update)
if [[ "$PULL" -eq 1 ]]; then
  UPDATE_ARGS+=(--pull)
fi

echo "==> qmd ${UPDATE_ARGS[*]}"
"$QMD_COMMAND" "${UPDATE_ARGS[@]}"
echo

if [[ "$RUN_EMBED" -eq 1 ]]; then
  EMBED_ARGS=(embed --max-docs-per-batch "$MAX_DOCS_PER_BATCH" --max-batch-mb "$MAX_BATCH_MB")
  if [[ "$FORCE_EMBED" -eq 1 ]]; then
    EMBED_ARGS+=( -f )
  fi
  echo "==> qmd ${EMBED_ARGS[*]}"
  "$QMD_COMMAND" "${EMBED_ARGS[@]}"
  echo
fi

echo "==> qmd status"
"$QMD_COMMAND" status
