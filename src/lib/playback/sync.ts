export const PLAYBACK_START_DELAY_MS = 1200;
export const READINESS_TIMEOUT_MS = 8000;
export const HEARTBEAT_INTERVAL_MS = 1000;

export const YOUTUBE_DEADBAND_SECONDS = 0.16;
export const YOUTUBE_RATE_START_THRESHOLD = 0.22;
export const YOUTUBE_HARD_SEEK_THRESHOLD = 1.6;
export const YOUTUBE_IMMEDIATE_SEEK_THRESHOLD = 2.6;
export const YOUTUBE_SEEK_COOLDOWN_MS = 2500;
export const DEFAULT_YOUTUBE_STARTUP_DELAY_MS = 350;
export const MAX_YOUTUBE_STARTUP_DELAY_MS = 1500;

export const AUDIO_DEADBAND_SECONDS = 0.05;
export const AUDIO_RATE_START_THRESHOLD = 0.08;
export const AUDIO_HARD_SEEK_THRESHOLD = 0.75;
export const AUDIO_SEEK_COOLDOWN_MS = 900;

export type DriftCorrectionPlan =
  | { action: "none"; rate: 1 }
  | { action: "rate"; rate: number; resetAfterMs: number }
  | { action: "seek"; rate: 1; targetPosition: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Projects a sender's reported position forward to the local server-clock time
 * when playback is active.
 */
export function computeTargetPosition(
  basePosition: number,
  isPlaying: boolean,
  sentAtMs: number | undefined,
  serverNowMs: number
): number {
  if (!Number.isFinite(basePosition)) return 0;

  if (!isPlaying || typeof sentAtMs !== "number" || !Number.isFinite(sentAtMs)) {
    return Math.max(0, basePosition);
  }

  const elapsedSeconds = Math.max(0, (serverNowMs - sentAtMs) / 1000);
  return Math.max(0, basePosition + elapsedSeconds);
}

/**
 * Updates the exponential moving average of player startup/seek latency.
 */
export function updateEmaLatencyMs(
  currentEstimateMs: number,
  measuredMs: number,
  maxMs = MAX_YOUTUBE_STARTUP_DELAY_MS
): number {
  if (!Number.isFinite(measuredMs) || measuredMs < 0) {
    return currentEstimateMs;
  }

  const bounded = clamp(measuredMs, 0, maxMs);
  return Math.round(currentEstimateMs * 0.6 + bounded * 0.4);
}

/**
 * Chooses a tiered drift correction for the YouTube IFrame player:
 * - Deadband: leave rate at 1.0x
 * - Medium drift: smoothly nudge playbackRate using YouTube's supported rates
 *   to avoid triggering buffering stalls from frequent seekTo() calls
 * - Large drift: hard seek ahead by estimated startup latency
 */
export function planYouTubeDriftCorrection(params: {
  targetPosition: number;
  localPosition: number;
  availableRates: number[];
  currentRate: number;
  estimatedStartupMs: number;
  allowHardSeek: boolean;
}): DriftCorrectionPlan {
  const {
    targetPosition,
    localPosition,
    availableRates,
    currentRate,
    estimatedStartupMs,
    allowHardSeek,
  } = params;

  const drift = targetPosition - localPosition;
  const absDrift = Math.abs(drift);

  if (absDrift <= YOUTUBE_DEADBAND_SECONDS) {
    return { action: "none", rate: 1 };
  }

  if (absDrift > YOUTUBE_HARD_SEEK_THRESHOLD && allowHardSeek) {
    const seekLeadSeconds = clamp(estimatedStartupMs / 1000, 0.1, 0.9);
    return {
      action: "seek",
      rate: 1,
      targetPosition: Math.max(0, targetPosition + seekLeadSeconds),
    };
  }

  // Hysteresis prevents oscillating on and off right around the threshold.
  if (currentRate === 1 && absDrift < YOUTUBE_RATE_START_THRESHOLD) {
    return { action: "none", rate: 1 };
  }

  const sortedRates = [...availableRates]
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);

  let chosenRate: number | undefined;
  if (drift > 0) {
    // Behind target: pick the gentlest speed-up rate (e.g. 1.25x, or 1.1x if supported)
    chosenRate = sortedRates.find((r) => r > 1.02 && r <= 1.5);
  } else {
    // Ahead of target: pick the gentlest slow-down rate (e.g. 0.75x, or 0.9x if supported)
    const slower = sortedRates.filter((r) => r < 0.98 && r >= 0.5);
    chosenRate = slower[slower.length - 1];
  }

  if (!chosenRate) {
    if (allowHardSeek && absDrift > 0.5) {
      const seekLeadSeconds = clamp(estimatedStartupMs / 1000, 0.1, 0.9);
      return {
        action: "seek",
        rate: 1,
        targetPosition: Math.max(0, targetPosition + seekLeadSeconds),
      };
    }
    return { action: "none", rate: 1 };
  }

  const rateDelta = Math.abs(chosenRate - 1);
  // Leave a small 40ms margin so we do not overshoot past zero drift.
  const remainingToClose = Math.max(0.05, absDrift - 0.04);
  const resetAfterMs = clamp((remainingToClose / rateDelta) * 1000, 250, 4000);

  return {
    action: "rate",
    rate: chosenRate,
    resetAfterMs: Math.round(resetAfterMs),
  };
}

/**
 * Chooses a tiered drift correction for HTML5 audio using continuous
 * playbackRate adjustments for small/medium drift and seeking only on large gaps.
 */
export function planAudioDriftCorrection(params: {
  targetPosition: number;
  localPosition: number;
  currentRate: number;
  allowHardSeek: boolean;
}): DriftCorrectionPlan {
  const { targetPosition, localPosition, currentRate, allowHardSeek } = params;

  const drift = targetPosition - localPosition;
  const absDrift = Math.abs(drift);

  if (absDrift <= AUDIO_DEADBAND_SECONDS) {
    return { action: "none", rate: 1 };
  }

  if (absDrift > AUDIO_HARD_SEEK_THRESHOLD && allowHardSeek) {
    return {
      action: "seek",
      rate: 1,
      targetPosition: Math.max(0, targetPosition + 0.02),
    };
  }

  if (currentRate === 1 && absDrift < AUDIO_RATE_START_THRESHOLD) {
    return { action: "none", rate: 1 };
  }

  const rate = Number(clamp(1 + drift * 0.2, 0.94, 1.06).toFixed(3));
  const rateDelta = Math.abs(rate - 1);
  const resetAfterMs =
    rateDelta > 0.001
      ? Math.round(clamp((absDrift / rateDelta) * 1000, 300, 3500))
      : 1000;

  return {
    action: "rate",
    rate,
    resetAfterMs,
  };
}
