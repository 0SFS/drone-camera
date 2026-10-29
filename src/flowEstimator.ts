const STRIDE = 16;
export const CONFIDENCE_MIN = 1e-4;

export interface FlowSample { x: number; y: number; confidence: number }

export interface FlowEstimate {
  source: "visual" | "imu";
  deltaYawRad: number;
  deltaPitchRad: number;
  omegaRadPerSec: number;
  confidence: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Stride-16 median Lucas–Kanade flow, in radians of yaw and gimbal pitch. */
export function estimateFlow(
  samples: readonly FlowSample[],
  flowHeight: number,
  vfovRad: number,
  dtFrame: number,
): FlowEstimate {
  const empty: FlowEstimate = { source: "imu", deltaYawRad: 0, deltaPitchRad: 0, omegaRadPerSec: 0, confidence: 0 };
  if (dtFrame <= 0 || dtFrame > 0.1 || !samples.length) return empty;
  const picked = samples.filter((_, index) => index % STRIDE === 0);
  const structured = picked.filter(sample => sample.confidence > CONFIDENCE_MIN);
  const confidence = median(picked.map(sample => sample.confidence));
  if (confidence <= CONFIDENCE_MIN || structured.length < 0.2 * picked.length) return empty;
  const fPx = (flowHeight / 2) / Math.tan(vfovRad / 2);
  const deltaYawRad = Math.atan(median(picked.map(sample => sample.x)) / fPx);
  const deltaPitchRad = Math.atan(-median(picked.map(sample => sample.y)) / fPx);
  return {
    source: "visual",
    deltaYawRad,
    deltaPitchRad,
    omegaRadPerSec: Math.hypot(deltaYawRad, deltaPitchRad) / dtFrame,
    confidence,
  };
}

export function blurLimitRadPerSec(captureHeight: number, vfovRad: number, exposureDen: number): number {
  const fCapture = (captureHeight / 2) / Math.tan(vfovRad / 2);
  return 0.5 / (fCapture * (1 / exposureDen));
}
