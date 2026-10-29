import { createActionIcon, createHelpTooltip, createIconButton, setIconButtonLabel } from "@foss-earth/ui/browser";
import "./cameraControls.css";

export interface CameraControlsState {
  label: string;
  gimbalMinDeg: number;
  gimbalMaxDeg: number;
  gimbalTargetDeg: number;
  gimbalPitchDeg: number;
  gimbalRollMinDeg?: number;
  gimbalRollMaxDeg?: number;
  gimbalRollTargetDeg?: number;
  gimbalRollDeg?: number;
  gimbalYawMinDeg?: number;
  gimbalYawMaxDeg?: number;
  gimbalYawTargetDeg?: number;
  gimbalYawDeg?: number;
  captureHeld: boolean;
  isCapturing: boolean;
  capturePhase: string;
  nodeIndex: number;
  nodeCount: number;
  blocked: string | null;
  /** A previous capture failed; unlike blocked, this still permits a retry. */
  error?: string | null;
  paused: boolean;
  stillBusy: boolean;
}

export interface CameraControlsOptions {
  document: Document;
  /** Optional host-owned preview slot; this panel imports no preview provider. */
  preview?: HTMLElement;
  onGimbalPitch(deg: number): void;
  onGimbalRoll?(deg: number): void;
  onGimbalYaw?(deg: number): void;
  onCapture(on: boolean): void;
  onShutter(): void;
}

const PHASE_LABELS: Readonly<Record<string, string>> = {
  idle: "Ready", slewing: "Turning camera", "optical-flow-fine-align": "Aligning",
  "settling-zero-velocity": "Settling", capturing: "Taking photo", "next-node": "Next photo",
  "zip-export": "Preparing download", done: "Download ready", aborted: "Stopped",
};
const degrees = (value: number): string => `${Number(value.toFixed(1))}°`;

/** Camera actions and telemetry only: the host owns commands, capture and the mounting lifecycle. */
export function createCameraControlsPanel(options: CameraControlsOptions): {
  element: HTMLElement;
  update(state: CameraControlsState): void;
  destroy(): void;
} {
  const { document } = options;
  const element = document.createElement("section");
  element.className = "drone-camera-controls";
  element.setAttribute("aria-label", "Camera controls");
  const identity = document.createElement("strong");
  identity.className = "drone-camera-controls__identity";
  element.append(identity);
  const gimbal = document.createElement("div");
  gimbal.className = "drone-camera-controls__gimbal";
  const preview = document.createElement("div");
  preview.className = "drone-camera-controls__preview";
  if (options.preview) preview.append(options.preview);
  else {
    preview.classList.add("drone-camera-controls__preview--absent");
    preview.textContent = "Preview unavailable";
  }
  element.append(gimbal);

  const group = (name: string, parent = element): HTMLElement => {
    const row = document.createElement("div");
    row.className = "foss-earth-choice-group drone-camera-controls__group";
    row.setAttribute("role", "group"); row.setAttribute("aria-label", name);
    parent.append(row);
    return row;
  };
  let destroyed = false;
  let active = false;
  let activeIcon = false;
  const cleanups: (() => void)[] = [];
  const on = (node: HTMLElement, type: string, handler: () => void): void => {
    node.addEventListener(type, handler);
    cleanups.push(() => node.removeEventListener(type, handler));
  };
  interface AxisState { min: number; max: number; target: number; actual: number }
  interface AxisOptions {
    label: string;
    downLabel: string;
    upLabel: string;
    explanation: string;
    onChange(deg: number): void;
    read(state: CameraControlsState): AxisState;
    reset?: boolean;
    vertical?: boolean;
  }
  const createAxis = (axis: AxisOptions) => {
    const name = axis.label.toLowerCase();
    const row = group(`Gimbal ${name} controls`, gimbal);
    row.classList.add("drone-camera-controls__axis", `drone-camera-controls__axis--${name}`);
    const controls = document.createElement("div");
    controls.className = "drone-camera-controls__axis-inputs";
    const heading = document.createElement("span"); heading.textContent = axis.label;
    const down = createIconButton(document, { icon: "download", label: axis.downLabel });
    const up = createIconButton(document, { icon: "upload", label: axis.upLabel });
    const range = document.createElement("input");
    range.type = "range"; range.step = "1"; range.disabled = true;
    range.setAttribute("aria-label", `Gimbal ${name}`);
    if (axis.vertical) range.setAttribute("aria-orientation", "vertical");
    const angles = document.createElement("output");
    angles.className = "drone-camera-controls__angles";
    angles.setAttribute("aria-label", `Gimbal target and actual ${name}`);
    const explanation = document.createElement("p"); explanation.textContent = axis.explanation;
    const help = createHelpTooltip({ label: `Explain gimbal ${name}`, content: explanation });
    const reset = axis.reset ? createIconButton(document, { icon: "reset", label: `Reset camera ${name} to zero` }) : null;
    controls.append(...(axis.vertical ? [up, range, down] : [down, range, up]));
    if (reset) controls.append(reset);
    controls.append(help.element);
    row.append(heading, ...(axis.vertical ? [controls, angles] : [angles, controls]));
    let limits: AxisState | null = null;
    let target = 0;
    const show = (): void => {
      if (!limits) return;
      range.value = String(target);
      range.setAttribute("aria-valuetext", `${degrees(target)} target, ${degrees(limits.actual)} actual`);
      const text = `Target ${degrees(target)} · Actual ${degrees(limits.actual)}`;
      if (angles.textContent !== text) angles.textContent = text;
      down.disabled = active || target <= limits.min;
      up.disabled = active || target >= limits.max;
      if (reset) reset.disabled = active || target === Math.min(limits.max, Math.max(limits.min, 0));
    };
    const command = (requested: number): void => {
      if (destroyed || !limits || range.disabled || !Number.isFinite(requested)) return;
      target = Math.min(limits.max, Math.max(limits.min, requested));
      show(); axis.onChange(target);
    };
    on(range, "input", () => command(Number(range.value)));
    on(down, "click", () => { if (!down.disabled) command(target - 5); });
    on(up, "click", () => { if (!up.disabled) command(target + 5); });
    if (reset) on(reset, "click", () => { if (!reset.disabled) command(0); });
    down.disabled = up.disabled = true;
    if (reset) reset.disabled = true;
    return {
      element: row,
      update(state: CameraControlsState) {
        const next = axis.read(state);
        const min = Number.isFinite(next.min) ? next.min : 0;
        const max = Math.max(min, Number.isFinite(next.max) ? next.max : 0);
        limits = { min, max, target: next.target, actual: Number.isFinite(next.actual) ? next.actual : 0 };
        target = Math.min(max, Math.max(min, Number.isFinite(next.target) ? next.target : 0));
        range.min = String(min); range.max = String(max);
        range.disabled = active || min === max;
        show();
      },
      destroy() { help.destroy(); },
    };
  };
  const pitch = createAxis({
    label: "Pitch", downLabel: "Tilt camera down", upLabel: "Tilt camera up", vertical: true,
    explanation: "Set the gimbal's target pitch. The actual angle follows at the camera's slew rate. A 360 sequence positions the gimbal automatically and temporarily locks manual pitch.",
    onChange: options.onGimbalPitch,
    read: state => ({ min: state.gimbalMinDeg, max: state.gimbalMaxDeg, target: state.gimbalTargetDeg, actual: state.gimbalPitchDeg }),
  });
  const roll = options.onGimbalRoll ? createAxis({
    label: "Roll", downLabel: "Roll camera left", upLabel: "Roll camera right", reset: true,
    explanation: "Roll is a manual offset from the stabilized level horizon. Set 0° or use Reset to restore level. The readout shows target and actual offsets; a 360 sequence temporarily locks manual overrides.",
    onChange: options.onGimbalRoll,
    read: state => ({ min: state.gimbalRollMinDeg ?? 0, max: state.gimbalRollMaxDeg ?? 0,
      target: state.gimbalRollTargetDeg ?? 0, actual: state.gimbalRollDeg ?? 0 }),
  }) : null;
  const yaw = options.onGimbalYaw ? createAxis({
    label: "Yaw", downLabel: "Turn camera left", upLabel: "Turn camera right", reset: true,
    explanation: "Yaw is a manual offset from the stabilized forward direction. Set 0° or use Reset to face forward again. The readout shows target and actual offsets; a 360 sequence temporarily locks manual overrides.",
    onChange: options.onGimbalYaw,
    read: state => ({ min: state.gimbalYawMinDeg ?? 0, max: state.gimbalYawMaxDeg ?? 0,
      target: state.gimbalYawTargetDeg ?? 0, actual: state.gimbalYawDeg ?? 0 }),
  }) : null;
  // The host's optional preview stays a replaceable component in the center.
  // Keep the same arrangement even when no preview mod is installed.
  if (roll) gimbal.append(roll.element);
  gimbal.append(preview, pitch.element);
  if (yaw) gimbal.append(yaw.element);
  const axes = [pitch, ...(roll ? [roll] : []), ...(yaw ? [yaw] : [])];

  const capture = group("Capture");
  const still = createIconButton(document, { icon: "crosshair", label: "Take still" });
  still.classList.add("drone-camera-controls__command");
  const stillLabel = document.createElement("span"); stillLabel.textContent = "Take still"; still.append(stillLabel);
  const sphere = createIconButton(document, { icon: "play", label: "Start 360 capture" });
  sphere.classList.add("drone-camera-controls__command");
  const sphereLabel = document.createElement("span"); sphereLabel.textContent = "Start 360"; sphere.append(sphereLabel);
  const captureExplanation = document.createElement("p");
  captureExplanation.textContent = "A still downloads one photo in a zip. A 360 sequence turns the aircraft and gimbal, takes overlapping photos, then downloads them together. Stopping finishes any photo already being read and cancels the remaining sequence.";
  const captureHelp = createHelpTooltip({ label: "Explain camera capture", content: captureExplanation });
  capture.append(still, sphere, captureHelp.element);

  const status = document.createElement("p");
  status.className = "drone-camera-controls__status"; status.setAttribute("role", "status");
  const progress = document.createElement("progress");
  progress.setAttribute("aria-label", "360 capture progress"); progress.hidden = true;
  const paused = document.createElement("p");
  paused.className = "drone-camera-controls__hint"; paused.hidden = true;
  paused.textContent = "Resume flight to move the gimbal or start a 360.";
  const error = document.createElement("p");
  error.className = "drone-camera-controls__error"; error.setAttribute("role", "alert"); error.hidden = true;
  element.append(status, progress, paused, error);

  on(still, "click", () => { if (!destroyed && !still.disabled) options.onShutter(); });
  on(sphere, "click", () => { if (!destroyed && !sphere.disabled) options.onCapture(!active); });
  still.disabled = sphere.disabled = true;

  return {
    element,
    update(next): void {
      if (destroyed) return;
      active = next.captureHeld || next.isCapturing;
      if (identity.textContent !== next.label) identity.textContent = next.label;
      for (const axis of axes) axis.update(next);
      still.disabled = next.stillBusy || Boolean(next.blocked) || active;
      still.setAttribute("aria-busy", String(next.stillBusy));
      sphere.disabled = !active && (next.paused || Boolean(next.blocked) || next.stillBusy);
      sphere.setAttribute("aria-pressed", String(active));
      setIconButtonLabel(sphere, active ? "Stop 360 capture" : "Start 360 capture");
      sphereLabel.textContent = active ? "Stop 360" : "Start 360";
      if (activeIcon !== active) {
        activeIcon = active;
        sphere.querySelector("svg")!.replaceWith(createActionIcon(document, active ? "close" : "play"));
        sphere.dataset.icon = active ? "close" : "play";
      }
      const count = Math.max(0, Math.floor(next.nodeCount));
      const index = Math.max(0, Math.floor(next.nodeIndex));
      const phase = next.captureHeld && !next.isCapturing && next.capturePhase === "idle"
        ? "Starting 360" : PHASE_LABELS[next.capturePhase] ?? next.capturePhase;
      const completed = next.capturePhase === "done" ? count : Math.min(count, index);
      const current = Math.min(count, index + 1);
      const text = `${next.stillBusy ? "Taking still" : phase}${count && (active || next.capturePhase === "done") ? ` · ${next.capturePhase === "done" ? count : current}/${count}` : ""}`;
      if (status.textContent !== text) status.textContent = text;
      progress.hidden = !active || count === 0;
      progress.max = Math.max(1, count); progress.value = completed;
      paused.hidden = !next.paused;
      paused.textContent = active ? "Resume flight to continue the 360." : "Resume flight to move the gimbal or start a 360.";
      const failure = next.blocked ?? next.error ?? "";
      error.hidden = !failure;
      if (error.textContent !== failure) error.textContent = failure;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of cleanups) cleanup();
      for (const axis of axes) axis.destroy();
      captureHelp.destroy();
      element.remove();
    },
  };
}
