import type { CameraProfile } from "./profile";

export interface GridNode { pitchDeg: number; yawDeg: number }

/**
 * 30% overlap: the step between optical axes is at most 0.70 of the covered field.
 * Pitch is degrees, negative down. Yaw is degrees clockwise from north.
 */
export function sphericalGrid(profile: Pick<CameraProfile, "hfovRad" | "vfovRad"> & { gimbalMaxDeg: number; gridOverlap: number }): GridNode[] {
  const pitchMin = -90 * Math.PI / 180;
  const pitchMax = profile.gimbalMaxDeg * Math.PI / 180;
  const span = pitchMax - pitchMin;
  const vStepMax = profile.gridOverlap * profile.vfovRad;
  let rings = 2;
  while (span / (rings - 1) > vStepMax + 1e-12) rings += 1;
  const nodes: GridNode[] = [];
  for (let i = 0; i < rings; i++) {
    const pitch = pitchMin + i * span / (rings - 1);
    let nYaw = 1;
    const cosine = Math.cos(pitch);
    if (Math.abs(cosine) >= 1e-4) {
      const coverage = 2 * Math.atan(Math.tan(profile.hfovRad / 2) / Math.abs(cosine));
      if (coverage < 2 * Math.PI) nYaw = Math.ceil((2 * Math.PI) / (profile.gridOverlap * coverage));
    }
    const yawStep = 2 * Math.PI / nYaw;
    for (let k = 0; k < nYaw; k++) {
      nodes.push({ pitchDeg: pitch * 180 / Math.PI, yawDeg: k * yawStep * 180 / Math.PI });
    }
  }
  return nodes;
}
