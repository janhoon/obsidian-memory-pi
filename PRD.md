# PRD: Visible Memory Activity Indicators

## Summary

When `obsidian-memory-pi` performs memory recall or memory tool operations, Pi can appear frozen because memory work may happen before the visible agent turn starts. Add clear, compact below-editor activity indicators so the user can see when memory is being invoked, what category of work is happening, and whether it completed, failed, or timed out.

## Problem

Automatic pre-answer memory recall runs in `before_agent_start` and blocks the agent until recall finishes. This is intentional because retrieved memory is often important context for the response. However, while QMD lookup is running there is currently no live UI indicator, so the session appears unresponsive.

The same visibility gap exists for explicit memory tool operations such as `memory_search`, `memory_get`, `memory_write`, `memory_propose_write`, `memory_review_status`, `memory_audit`, and `memory_record_decision`.

## Goals

- Keep automatic pre-answer memory recall blocking.
- Show a compact static activity line in the existing below-editor memory widget/status area.
- Cover both automatic pre-answer recall and explicit memory tools, including writes.
- Restore the normal memory widget after operation completion/failure/timeout.
- Add configurable pre-answer recall timeout settings under existing `autoRecall` config.
- Preserve current recall behavior: QMD search snippets only; do not read full notes during pre-answer recall.

## Non-goals

- Do not make pre-answer recall asynchronous/backgrounded.
- Do not change recall search semantics or ranking behavior.
- Do not introduce a manual cancel/skip flow for recall.
- Do not add a separate faster auto-recall mode.
- Do not apply the new timeout to explicit memory tools yet.
- Do not show full user queries in the widget.

## Requirements

### 1. Pre-answer recall remains blocking

Automatic recall must finish before the agent starts responding, unless it times out or fails. This preserves the current behavior where retrieved memory can be injected before the model answers.

### 2. Configurable pre-answer recall timeout

Add these settings under existing `autoRecall` config:

```json
{
  "autoRecall": {
    "timeoutMs": 60000,
    "clearDelayMs": 5000
  }
}
```

Behavior:

- `timeoutMs` defaults to `60000`.
- Timeout applies per QMD attempt.
- Timeout is currently only for automatic pre-answer recall.
- `clearDelayMs` defaults to `5000`.
- `clearDelayMs` controls how long completion/failure/timeout activity remains visible before restoring the normal widget.

### 3. Below-editor activity indicator

Use the existing memory widget/status area below the editor, in line with the current `🧠 memory` widget that shows pending review, session notes, and auto capture.

The indicator should be compact and static. No live spinner or elapsed timer is required.

### 4. Activity text

Use compact text such as:

- Automatic recall running: `recalling memory: searching QMD`
- Explicit search: `memory: searching…`
- Explicit read: `memory: reading working-context.md`
- Explicit write: `memory: writing active-context.md`
- Other tools: `memory: checking status…`, `memory: auditing…`, etc.

Keep the widget compact and do not show the full user query.

### 5. Completion/failure/timeout states

After an operation finishes, briefly show a compact result line before restoring the normal memory widget.

Examples:

- `memory: search complete`
- `memory: read complete`
- `memory: write complete`
- `memory: search failed`
- `memory: write failed`
- Pre-answer recall timeout: `memory recall timed out; continuing`
- Pre-answer recall failure: `memory recall failed; continuing`

Failure messages should indicate failure only. Do not include detailed error text in the widget.

### 6. Restore normal widget

After `autoRecall.clearDelayMs`, restore the normal memory widget content exactly as before:

- pending review count
- session notes state
- auto capture state
- pending proposal details when present
- pending memory intent details when present

### 7. Most recent operation only

If multiple memory operations overlap, the widget should show only the most recent/current memory activity. It should not render a list of all active operations.

### 8. Existing transcript behavior

Do not add timeout/failure transcript messages for pre-answer recall. Timeout and failure should be visible briefly in the widget only, then clear.

Successful auto recall should keep the current behavior of injecting the `obsidian-memory-context` message when results are found.

## Implementation notes

Likely implementation area: `extensions/obsidian-memory/index.ts`.

Suggested approach:

1. Extend `MemoryConfig.autoRecall` with:
   - `timeoutMs: number`
   - `clearDelayMs: number`
2. Add defaults in `withDefaults()`:
   - `timeoutMs: 60000`
   - `clearDelayMs: 5000`
3. Add in-memory activity state, for example:
   - current activity id
   - status: `running | complete | failed | timed_out`
   - compact label/message
4. Update `buildWidgetLines()` / `setStatus()` to include the current activity line in the existing below-editor memory widget.
5. Wrap pre-answer recall in activity updates:
   - set running: `recalling memory: searching QMD`
   - on success: `memory recall complete`
   - on timeout: `memory recall timed out; continuing`
   - on failure: `memory recall failed; continuing`
   - clear after `clearDelayMs`
6. Wrap registered memory tools in activity updates:
   - show operation-specific running line
   - show operation-specific complete/failed line
   - clear after `clearDelayMs`
7. Ensure stale clear timers do not clear a newer activity. Use an activity id/token check before clearing.

## Acceptance criteria

- When auto recall triggers, the below-editor memory widget immediately shows `recalling memory: searching QMD`.
- Auto recall still blocks the agent response until recall succeeds, fails, or times out.
- A slow auto recall times out according to `autoRecall.timeoutMs` and briefly shows `memory recall timed out; continuing`.
- A failed auto recall briefly shows `memory recall failed; continuing`.
- Explicit memory tools show compact running activity and then compact `complete` or `failed` status.
- Completion/failure/timeout messages clear after `autoRecall.clearDelayMs` and the original memory widget returns.
- Only the most recent memory operation is shown if operations overlap.
- No full user query is displayed in the widget.
- Current auto recall result injection behavior remains unchanged.

## Test plan

Manual tests:

1. Trigger auto recall with a prompt containing a recall pattern such as `continue` or `project status`.
2. Confirm the below-editor widget shows `recalling memory: searching QMD` before the assistant response begins.
3. Confirm successful recall injects the existing `Auto memory recall for project ...` context message when results are found.
4. Configure a very low `autoRecall.timeoutMs`, trigger auto recall, and confirm timeout text appears briefly then clears.
5. Run `memory_search`, `memory_get`, and a memory write/proposal tool; confirm running and completion states appear briefly.
6. Cause a memory tool failure; confirm a compact failed status appears without detailed error text.
7. Confirm the normal memory widget is restored after 5 seconds.
