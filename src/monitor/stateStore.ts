import type { StreamRuntimeState, StreamCheckResult } from "../types";

const states = new Map<string, StreamRuntimeState>();
const lastResults = new Map<string, StreamCheckResult>();

function defaultState(): StreamRuntimeState {
  return {
    lastStatus: "OK",
    phase: "STABLE",
    suspectAttempt: 0,
    suspectSince: null,
    isChecking: false,
    pendingRetryTimer: null,
    lastAlertAt: null,
    lastMediaSequence: null,
    lastSegmentUri: null,
    lastManifestChangeAt: null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
  };
}

export function getState(id: string): StreamRuntimeState {
  let state = states.get(id);
  if (!state) {
    state = defaultState();
    states.set(id, state);
  }
  return state;
}

export function setState(id: string, state: StreamRuntimeState): void {
  states.set(id, state);
}

export function setLastResult(id: string, result: StreamCheckResult): void {
  lastResults.set(id, result);
}

/** Xóa state của 1 luồng đã biến mất khỏi danh sách giám sát (VD Partner gỡ kênh) - chống rò rỉ. */
export function removeState(id: string): void {
  const state = states.get(id);
  if (state?.pendingRetryTimer) clearTimeout(state.pendingRetryTimer);
  states.delete(id);
  lastResults.delete(id);
}

export function getAllLastResults(): StreamCheckResult[] {
  return Array.from(lastResults.values());
}

export function getAllStates(): Map<string, StreamRuntimeState> {
  return states;
}

/** Hủy mọi timer retry đang chờ trên tất cả luồng - dùng khi shutdown để tiến trình thoát sạch. */
export function clearAllPendingRetries(): void {
  for (const state of states.values()) {
    if (state.pendingRetryTimer) {
      clearTimeout(state.pendingRetryTimer);
      state.pendingRetryTimer = null;
    }
  }
}
