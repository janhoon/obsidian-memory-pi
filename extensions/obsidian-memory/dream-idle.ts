/**
 * Idle / scheduled Dream trigger policy (pure).
 *
 * Automatic Dream runs only when idle + activity thresholds are met,
 * never mid-turn, at most once until conditions reset, fully disable-able.
 *
 * Domain: Session note, Log, Dream.
 */

export type DreamIdleConfig = {
  /** Master switch for automatic Dream (manual /memory-dream always works). */
  enabled: boolean;
  /** Minutes of no agent activity before an automatic Dream may run. */
  idleMinutes: number;
  /** Minimum completed agent turns (session activity) since last auto Dream / reset. */
  minSessionTurns: number;
  /** How often to evaluate thresholds (ms). */
  checkIntervalMs: number;
};

export const DEFAULT_DREAM_IDLE_CONFIG: DreamIdleConfig = {
  enabled: false,
  idleMinutes: 30,
  minSessionTurns: 3,
  checkIntervalMs: 60_000,
};

export type DreamIdleState = {
  /** Wall clock of last user/agent activity (input, before_agent_start, agent_end). */
  lastActivityAt: number;
  /** Completed agent turns since last auto Dream (or session start). */
  sessionTurnsSinceDream: number;
  /** True while an agent turn is in flight. */
  agentTurnActive: boolean;
  /** True after an auto Dream until activity resets the gate. */
  autoDreamConsumed: boolean;
  /** Timestamp of last automatic Dream (for status). */
  lastAutoDreamAt?: number;
};

export type DreamIdleDecision =
  | { shouldRun: false; reason: string }
  | { shouldRun: true; reason: string; idleMs: number; sessionTurns: number };

export function withDreamIdleDefaults(partial?: Partial<DreamIdleConfig>): DreamIdleConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_DREAM_IDLE_CONFIG.enabled,
    idleMinutes:
      Number.isFinite(partial?.idleMinutes) && (partial?.idleMinutes ?? 0) > 0
        ? (partial?.idleMinutes as number)
        : DEFAULT_DREAM_IDLE_CONFIG.idleMinutes,
    minSessionTurns:
      Number.isFinite(partial?.minSessionTurns) && (partial?.minSessionTurns ?? 0) > 0
        ? (partial?.minSessionTurns as number)
        : DEFAULT_DREAM_IDLE_CONFIG.minSessionTurns,
    checkIntervalMs:
      Number.isFinite(partial?.checkIntervalMs) && (partial?.checkIntervalMs ?? 0) >= 5_000
        ? (partial?.checkIntervalMs as number)
        : DEFAULT_DREAM_IDLE_CONFIG.checkIntervalMs,
  };
}

export function createDreamIdleState(now = Date.now()): DreamIdleState {
  return {
    lastActivityAt: now,
    sessionTurnsSinceDream: 0,
    agentTurnActive: false,
    autoDreamConsumed: false,
  };
}

/** Touch activity clock (user input, tool UI, etc.). */
export function noteDreamIdleActivity(state: DreamIdleState, now = Date.now()): DreamIdleState {
  return { ...state, lastActivityAt: now };
}

export function markDreamIdleAgentStart(state: DreamIdleState, now = Date.now()): DreamIdleState {
  return {
    ...state,
    agentTurnActive: true,
    lastActivityAt: now,
  };
}

export function markDreamIdleAgentEnd(state: DreamIdleState, now = Date.now()): DreamIdleState {
  return {
    ...state,
    agentTurnActive: false,
    lastActivityAt: now,
    sessionTurnsSinceDream: state.sessionTurnsSinceDream + 1,
    // New activity after a consumed auto Dream re-arms once enough turns accumulate again.
    // autoDreamConsumed stays true until we explicitly reset after a run decision path.
  };
}

/**
 * After a successful automatic Dream: consume the slot and zero the turn counter
 * so another auto Dream requires fresh activity + idle again.
 */
export function markAutoDreamRan(state: DreamIdleState, now = Date.now()): DreamIdleState {
  return {
    ...state,
    autoDreamConsumed: true,
    sessionTurnsSinceDream: 0,
    lastAutoDreamAt: now,
    lastActivityAt: now,
  };
}

/**
 * After enough new turns post-auto-Dream, clear the consumed flag so idle can fire again.
 * Called from evaluate when turns exceed threshold while consumed.
 */
export function maybeRearmAutoDream(state: DreamIdleState, minSessionTurns: number): DreamIdleState {
  if (!state.autoDreamConsumed) return state;
  if (state.sessionTurnsSinceDream < minSessionTurns) return state;
  return {
    ...state,
    autoDreamConsumed: false,
  };
}

/**
 * Decide whether an automatic Dream should run now.
 * Never mid-turn; respects enabled + idle + activity + one-shot until reset.
 */
export function evaluateDreamIdleTrigger(
  config: DreamIdleConfig,
  state: DreamIdleState,
  now = Date.now(),
): DreamIdleDecision {
  if (!config.enabled) {
    return { shouldRun: false, reason: "idle Dream disabled" };
  }
  if (state.agentTurnActive) {
    return { shouldRun: false, reason: "agent turn active" };
  }

  const rearmed = maybeRearmAutoDream(state, config.minSessionTurns);
  if (rearmed.autoDreamConsumed) {
    return {
      shouldRun: false,
      reason: `auto Dream already ran; need ${config.minSessionTurns} new turns to re-arm (have ${rearmed.sessionTurnsSinceDream})`,
    };
  }

  if (rearmed.sessionTurnsSinceDream < config.minSessionTurns) {
    return {
      shouldRun: false,
      reason: `session activity ${rearmed.sessionTurnsSinceDream}/${config.minSessionTurns} turns`,
    };
  }

  const idleMs = Math.max(0, now - rearmed.lastActivityAt);
  const needMs = Math.max(0, config.idleMinutes) * 60_000;
  if (idleMs < needMs) {
    return {
      shouldRun: false,
      reason: `idle ${Math.round(idleMs / 1000)}s < ${config.idleMinutes * 60}s`,
    };
  }

  return {
    shouldRun: true,
    reason: `idle ${Math.round(idleMs / 1000)}s with ${rearmed.sessionTurnsSinceDream} turns`,
    idleMs,
    sessionTurns: rearmed.sessionTurnsSinceDream,
  };
}

export function formatDreamIdleStatus(config: DreamIdleConfig, state: DreamIdleState, now = Date.now()): string {
  if (!config.enabled) return "Idle Dream: off";
  const idleSec = Math.round(Math.max(0, now - state.lastActivityAt) / 1000);
  const last = state.lastAutoDreamAt ? new Date(state.lastAutoDreamAt).toISOString() : "never";
  return `Idle Dream: on · idle ${idleSec}s / ${config.idleMinutes * 60}s · turns ${state.sessionTurnsSinceDream}/${config.minSessionTurns}${state.autoDreamConsumed ? " · consumed" : ""}${state.agentTurnActive ? " · mid-turn" : ""} · last auto ${last}`;
}
