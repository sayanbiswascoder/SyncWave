
import { createClient } from "@/lib/supabase/client";

export type ServerClock = {
  offsetMs: number;
  rttMs: number;
  syncedAtPerf: number;
  now: () => number;
};

type ClockSample = {
  rttMs: number;
  serverAtPerfZero: number;
  epochOffsetMs: number;
};

const PROBE_COUNT = 6;
const MAX_CLOCK_AGE_MS = 5 * 60 * 1000;

export async function syncServerClock(): Promise<ServerClock> {
  const supabase = createClient();
  const samples: ClockSample[] = [];
  let lastError: Error | null = null;

  for (let i = 0; i < PROBE_COUNT; i++) {
    const startedPerf = performance.now();
    const startedEpoch = Date.now();

    const { data, error } = await supabase.rpc("get_server_time_ms");

    const finishedPerf = performance.now();

    if (error) {
      lastError = new Error(`Clock sync failed: ${error.message}`);
      continue;
    }

    const serverTime = Number(data);
    if (!Number.isFinite(serverTime)) {
      lastError = new Error("Invalid server time");
      continue;
    }

    const rttMs = Math.max(0, finishedPerf - startedPerf);
    const midPerf = (startedPerf + finishedPerf) / 2;
    const midEpoch = startedEpoch + rttMs / 2;

    samples.push({
      rttMs,
      serverAtPerfZero: serverTime - midPerf,
      epochOffsetMs: serverTime - midEpoch,
    });
  }

  if (samples.length === 0) {
    throw lastError ?? new Error("Clock sync failed: no valid samples");
  }

  // Discard the very first probe when enough subsequent probes succeeded,
  // since cold HTTP/TLS setup often introduces asymmetric latency.
  const candidates =
    samples.length >= 4 ? samples.slice(1) : samples;

  candidates.sort((a, b) => a.rttMs - b.rttMs);

  const selectedCount = Math.min(3, Math.max(1, Math.ceil(candidates.length / 2)));
  const best = candidates.slice(0, selectedCount);

  const avgServerAtPerfZero =
    best.reduce((sum, s) => sum + s.serverAtPerfZero, 0) / best.length;
  const avgEpochOffsetMs =
    best.reduce((sum, s) => sum + s.epochOffsetMs, 0) / best.length;
  const avgRttMs =
    best.reduce((sum, s) => sum + s.rttMs, 0) / best.length;

  return {
    offsetMs: Math.round(avgEpochOffsetMs),
    rttMs: Math.round(avgRttMs),
    syncedAtPerf: performance.now(),
    now: () => avgServerAtPerfZero + performance.now(),
  };
}

/**
 * Re-synchronizes the server clock while protecting a tight existing sync
 * from being overwritten by a transient high-RTT network spike.
 */
export async function resyncServerClock(
  current: ServerClock | null
): Promise<ServerClock> {
  const candidate = await syncServerClock();

  if (!current) {
    return candidate;
  }

  const ageMs = performance.now() - current.syncedAtPerf;
  const isStale = ageMs >= MAX_CLOCK_AGE_MS;
  const isMuchWorseRtt =
    candidate.rttMs > Math.max(200, current.rttMs * 2);

  if (!isStale && isMuchWorseRtt) {
    return current;
  }

  return candidate;
}
