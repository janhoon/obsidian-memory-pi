import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "dream-idle.ts");

const {
  withDreamIdleDefaults,
  createDreamIdleState,
  markDreamIdleAgentStart,
  markDreamIdleAgentEnd,
  markAutoDreamRan,
  evaluateDreamIdleTrigger,
  formatDreamIdleStatus,
  DEFAULT_DREAM_IDLE_CONFIG,
} = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);

const cfg = withDreamIdleDefaults({
  enabled: true,
  idleMinutes: 1,
  minSessionTurns: 2,
  checkIntervalMs: 10_000,
});

// Disabled never runs
{
  const state = createDreamIdleState(0);
  const d = evaluateDreamIdleTrigger({ ...cfg, enabled: false }, state, 120_000);
  assert.equal(d.shouldRun, false);
  assert.match(d.reason, /disabled/);
}

// Mid-turn never runs
{
  let state = createDreamIdleState(0);
  state = markDreamIdleAgentEnd(state, 1_000);
  state = markDreamIdleAgentEnd(state, 2_000);
  state = markDreamIdleAgentStart(state, 3_000);
  const d = evaluateDreamIdleTrigger(cfg, state, 3_000 + 120_000);
  assert.equal(d.shouldRun, false);
  assert.match(d.reason, /agent turn active/);
}

// Not enough turns
{
  let state = createDreamIdleState(0);
  state = markDreamIdleAgentEnd(state, 1_000);
  state = { ...state, agentTurnActive: false, lastActivityAt: 1_000 };
  const d = evaluateDreamIdleTrigger(cfg, state, 1_000 + 120_000);
  assert.equal(d.shouldRun, false);
  assert.match(d.reason, /session activity 1\/2/);
}

// Enough turns but not idle
{
  let state = createDreamIdleState(0);
  state = markDreamIdleAgentEnd(state, 1_000);
  state = markDreamIdleAgentEnd(state, 2_000);
  const d = evaluateDreamIdleTrigger(cfg, state, 2_000 + 10_000);
  assert.equal(d.shouldRun, false);
  assert.match(d.reason, /idle/);
}

// Ready to run
{
  let state = createDreamIdleState(0);
  state = markDreamIdleAgentEnd(state, 1_000);
  state = markDreamIdleAgentEnd(state, 2_000);
  const d = evaluateDreamIdleTrigger(cfg, state, 2_000 + 60_000);
  assert.equal(d.shouldRun, true);
  if (d.shouldRun) {
    assert.equal(d.sessionTurns, 2);
  }
}

// One-shot: after auto dream, no thrash until re-armed
{
  let state = createDreamIdleState(0);
  state = markDreamIdleAgentEnd(state, 1_000);
  state = markDreamIdleAgentEnd(state, 2_000);
  state = markAutoDreamRan(state, 2_000 + 60_000);
  // still idle long enough but consumed and turns reset
  let d = evaluateDreamIdleTrigger(cfg, state, 2_000 + 60_000 + 120_000);
  assert.equal(d.shouldRun, false);

  // new turns re-arm after minSessionTurns, then need idle again
  state = markDreamIdleAgentEnd(state, 200_000);
  state = markDreamIdleAgentEnd(state, 201_000);
  d = evaluateDreamIdleTrigger(cfg, state, 201_000 + 60_000);
  assert.equal(d.shouldRun, true);
}

assert.equal(DEFAULT_DREAM_IDLE_CONFIG.enabled, false);
assert.match(formatDreamIdleStatus(cfg, createDreamIdleState(0), 0), /Idle Dream: on/);

console.log("dream-idle.test.mjs: all assertions passed");
