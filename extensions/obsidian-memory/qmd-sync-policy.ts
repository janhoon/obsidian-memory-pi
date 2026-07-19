export type QmdSyncMode = "update" | "full";
export type QmdEmbedMode = "manual" | "end_of_session" | "after_update";

export type QmdSyncPolicyConfig = {
  mode: QmdSyncMode;
  embed: QmdEmbedMode;
};

export type QmdIndexUiState = {
  dirty: boolean;
  syncing: boolean;
  lastError?: string;
};

/** Whether a debounced background sync should run embed after update. */
export function shouldIncludeEmbedForDebouncedSync(config: QmdSyncPolicyConfig): boolean {
  if (config.mode === "full") return true;
  return config.embed === "after_update";
}

/** Whether session_shutdown should include embed when the index is dirty. */
export function shouldIncludeEmbedForSessionEnd(config: QmdSyncPolicyConfig): boolean {
  return config.embed === "end_of_session" || config.mode === "full";
}

/** Widget label for QMD index health (activity line may override this). */
export function formatQmdIndexWidgetLabel(indexState?: QmdIndexUiState): string | undefined {
  if (!indexState) return undefined;
  if (indexState.syncing) return "QMD syncing…";
  if (indexState.dirty) return "QMD stale";
  if (indexState.lastError) return "QMD sync failed";
  return undefined;
}

/**
 * Decide whether a completed sync should clear the dirty flag.
 * Dirty is cleared only when no write landed at/after sync start.
 */
export function shouldClearDirtyAfterSync(options: {
  dirtyAtBefore: number | undefined;
  dirtyAtAfter: number | undefined;
  startedAt: number;
}): boolean {
  const { dirtyAtBefore, dirtyAtAfter, startedAt } = options;
  if (dirtyAtAfter === undefined) return true;
  if (dirtyAtAfter === dirtyAtBefore) return true;
  return dirtyAtAfter <= startedAt;
}
