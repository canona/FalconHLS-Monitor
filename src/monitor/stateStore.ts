import type { StreamRuntimeState, StreamCheckResult } from "../types";

const states = new Map<string, StreamRuntimeState>();
const lastResults = new Map<string, StreamCheckResult>();

function defaultState(): StreamRuntimeState {
  return {
    lastStatus: "OK",
    lastAlertAt: null,
    lastMediaSequence: null,
    lastSegmentUri: null,
    lastManifestChangeAt: null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
  };
}

export function getState(streamName: string): StreamRuntimeState {
  let state = states.get(streamName);
  if (!state) {
    state = defaultState();
    states.set(streamName, state);
  }
  return state;
}

export function setState(streamName: string, state: StreamRuntimeState): void {
  states.set(streamName, state);
}

export function setLastResult(streamName: string, result: StreamCheckResult): void {
  lastResults.set(streamName, result);
}

export function getAllLastResults(): StreamCheckResult[] {
  return Array.from(lastResults.values());
}
