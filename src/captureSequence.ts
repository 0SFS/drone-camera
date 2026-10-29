export interface CaptureCommand {
  pitch: number;
  roll: number;
  vertical: number;
  yaw: number;
  yawMode: "angularVelocity" | "angle";
  yawAngleDeg: number | null;
  gimbalPitchDeg: number;
  sport: boolean;
  shutter: boolean;
  capture360: boolean;
}
import type { GridNode } from "./sphericalGrid";
import { shotName, storeZip, type ZipEntry } from "./zipStore";

export type CapturePhase = "idle" | "slewing" | "optical-flow-fine-align" | "settling-zero-velocity" | "capturing" | "next-node" | "zip-export" | "done" | "aborted";

export interface SequenceShot {
  jpeg: Uint8Array;
  pitchDeg: number;
  yawDeg: number;
  slewTimeout: boolean;
  blurRisk: boolean;
}

export interface CaptureSequence {
  phase(): CapturePhase;
  nodeIndex(): number;
  nodeCount(): number;
  isCapturing(): boolean;
  isSettled(): boolean;
  command(base: CaptureCommand): CaptureCommand;
  step(input: SequenceStep): void;
  reset(): void;
}

export interface SequenceStep {
  dt: number;
  capture360: boolean;
  psiDeg: number;
  gimbalDeg: number;
  flowSource: "visual" | "imu";
  deltaYawDeg: number;
  deltaPitchDeg: number;
  omegaGate: number;
  omegaBlur: number;
  capture: () => Promise<Uint8Array>;
  download: (entries: ZipEntry[]) => void;
  grid: () => GridNode[];
}

function wrapDeg(deg: number): number {
  return Math.atan2(Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180)) * 180 / Math.PI;
}

/** Spherical still sequence. It only rewrites the stick command; JSBSim stays with the controller. */
export function createCaptureSequence(): CaptureSequence {
  let phase: CapturePhase = "idle";
  let nodes: GridNode[] = [];
  let index = 0;
  let elapsed = 0;
  let settledSteps = 0;
  let slewTimeout = false;
  let blurRisk = false;
  let shots: SequenceShot[] = [];
  let pending: Promise<void> | null = null;
  let yawTarget = 0;
  let pitchTarget = 0;
  let sumYaw = 0;
  let sumPitch = 0;
  const node = () => nodes[index];
  const live = () => phase === "slewing" || phase === "optical-flow-fine-align" || phase === "settling-zero-velocity" || phase === "capturing" || phase === "next-node" || phase === "zip-export";
  return {
    phase: () => phase,
    nodeIndex: () => index,
    nodeCount: () => nodes.length,
    isCapturing: () => live(),
    isSettled: () => (phase === "settling-zero-velocity" && settledSteps >= 6) || phase === "capturing",
    command(base) {
      if (!live()) return base;
      return {
        ...base,
        pitch: 0, roll: 0, vertical: 0, yaw: 0,
        yawMode: "angle",
        yawAngleDeg: yawTarget,
        gimbalPitchDeg: pitchTarget,
        capture360: true,
      };
    },
    reset() {
      phase = "idle";
      nodes = [];
      index = 0;
      shots = [];
      pending = null;
    },
    step(input) {
      if (!input.capture360 && phase !== "idle" && phase !== "done" && phase !== "capturing") {
        phase = "aborted";
      }
      if (phase === "aborted") { phase = "idle"; shots = []; return; }
      if (phase === "done") {
        if (!input.capture360) phase = "idle";
        return;
      }
      if (phase === "idle") {
        if (!input.capture360) return;
        nodes = input.grid();
        index = 0;
        shots = [];
        elapsed = 0;
        slewTimeout = false;
        const first = node();
        if (!first) { phase = "done"; return; }
        yawTarget = first.yawDeg;
        pitchTarget = first.pitchDeg;
        phase = "slewing";
        return;
      }
      const current = node();
      if (!current) { phase = "zip-export"; }
      if (phase === "slewing" && current) {
        yawTarget = current.yawDeg;
        pitchTarget = current.pitchDeg;
        elapsed += input.dt;
        const aimed = Math.abs(wrapDeg(input.psiDeg - current.yawDeg)) < 3 && Math.abs(input.gimbalDeg - current.pitchDeg) < 1;
        if (aimed || elapsed >= 8) {
          slewTimeout = !aimed;
          elapsed = 0;
          sumYaw = 0;
          sumPitch = 0;
          phase = input.flowSource === "imu" ? "settling-zero-velocity" : "optical-flow-fine-align";
          settledSteps = 0;
        }
        return;
      }
      if (phase === "optical-flow-fine-align" && current) {
        if (input.flowSource === "visual") {
          sumYaw += input.deltaYawDeg;
          sumPitch += input.deltaPitchDeg;
        } else {
          const decay = Math.exp(-input.dt / 0.5);
          sumYaw *= decay;
          sumPitch *= decay;
        }
        const yawError = wrapDeg(current.yawDeg - (input.psiDeg + sumYaw));
        const pitchError = current.pitchDeg - (input.gimbalDeg + sumPitch);
        yawTarget = current.yawDeg + Math.min(2, Math.max(-2, yawError));
        pitchTarget = current.pitchDeg + Math.min(2, Math.max(-2, pitchError));
        elapsed += input.dt;
        if (elapsed >= 0.6 || (Math.abs(yawError) < 0.15 && Math.abs(pitchError) < 0.15)) {
          elapsed = 0;
          settledSteps = 0;
          phase = "settling-zero-velocity";
        }
        return;
      }
      if (phase === "settling-zero-velocity") {
        elapsed += input.dt;
        settledSteps = input.omegaGate < input.omegaBlur ? settledSteps + 1 : 0;
        if (settledSteps >= 6 || elapsed >= 2) {
          blurRisk = settledSteps < 6;
          phase = "capturing";
        }
        return;
      }
      if (phase === "capturing" && current && !pending) {
        const shot = current;
        const timedOut = slewTimeout;
        const risk = blurRisk;
        pending = input.capture().then(jpeg => {
          shots.push({ jpeg, pitchDeg: shot.pitchDeg, yawDeg: shot.yawDeg, slewTimeout: timedOut, blurRisk: risk });
          phase = "next-node";
        }).catch(() => {
          phase = "aborted";
        }).finally(() => { pending = null; });
        return;
      }
      if (phase === "next-node") {
        index += 1;
        elapsed = 0;
        slewTimeout = false;
        blurRisk = false;
        if (index >= nodes.length) phase = "zip-export";
        else {
          const next = node();
          if (next) { yawTarget = next.yawDeg; pitchTarget = next.pitchDeg; }
          phase = "slewing";
        }
        return;
      }
      if (phase === "zip-export") {
        const entries: ZipEntry[] = shots.map((shot, shotIndex) => ({
          name: shotName(shotIndex, shot.pitchDeg, shot.yawDeg),
          bytes: shot.jpeg,
        }));
        entries.push({
          name: "manifest.json",
          bytes: new TextEncoder().encode(JSON.stringify({ grid: nodes, shots }, null, 2)),
        });
        input.download(entries);
        phase = "done";
      }
    },
  };
}

export function sequenceZip(entries: ZipEntry[]): Uint8Array {
  return storeZip(entries);
}
