// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCameraControlsPanel, type CameraControlsState, type CameraControlsOptions } from "../src/cameraControls";

const initial: CameraControlsState = {
  label: "Mini 2 · FC7303", gimbalMinDeg: -90, gimbalMaxDeg: 20, gimbalTargetDeg: 0,
  gimbalPitchDeg: 0, captureHeld: false, isCapturing: false, capturePhase: "idle",
  nodeIndex: 0, nodeCount: 0, blocked: null, paused: false, stillBusy: false,
};
const panels: ReturnType<typeof createCameraControlsPanel>[] = [];
afterEach(() => { for (const panel of panels.splice(0)) panel.destroy(); document.body.replaceChildren(); });
function setup(overrides: Partial<CameraControlsState> = {}, axes: Pick<CameraControlsOptions, "onGimbalRoll" | "onGimbalYaw"> = {}) {
  const commands = { onGimbalPitch: vi.fn(), onCapture: vi.fn(), onShutter: vi.fn() };
  const panel = createCameraControlsPanel({ document, ...commands, ...axes }); panels.push(panel);
  document.body.append(panel.element); panel.update({ ...initial, ...overrides });
  const button = (label: string) => panel.element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const range = panel.element.querySelector<HTMLInputElement>('[aria-label="Gimbal pitch"]')!;
  return { panel, commands, button, range };
}

describe("camera controls", () => {
  it("clamps manual pitch to each mount, preserves actual feedback, and sends five-degree nudges", () => {
    const { panel, commands, button, range } = setup({ gimbalTargetDeg: 18, gimbalPitchDeg: 10 });
    button("Tilt camera up").click();
    expect(commands.onGimbalPitch).toHaveBeenLastCalledWith(20);
    expect(button("Tilt camera up").disabled).toBe(true);
    expect(range.getAttribute("aria-valuetext")).toBe("20° target, 10° actual");
    button("Tilt camera down").click();
    expect(commands.onGimbalPitch).toHaveBeenLastCalledWith(15);
    panel.update({ ...initial, label: "Air 2S · FC3411", gimbalMaxDeg: 24, gimbalTargetDeg: 22 });
    button("Tilt camera up").click();
    expect(commands.onGimbalPitch).toHaveBeenLastCalledWith(24);
    panel.update({ ...initial, gimbalTargetDeg: -88 });
    button("Tilt camera down").click();
    expect(commands.onGimbalPitch).toHaveBeenLastCalledWith(-90);
    expect(button("Tilt camera down").disabled).toBe(true);
    range.value = "-45"; range.dispatchEvent(new Event("input"));
    expect(commands.onGimbalPitch).toHaveBeenLastCalledWith(-45);
  });

  it("offers roll/yaw only when the host supplies commands, and uses host bounds for nudges and zero resets", () => {
    const legacy = setup();
    expect(legacy.panel.element.querySelector('[aria-label="Gimbal roll"]')).toBeNull();
    expect(legacy.panel.element.querySelector('[aria-label="Gimbal yaw"]')).toBeNull();
    const onGimbalRoll = vi.fn(), onGimbalYaw = vi.fn();
    const { panel, button } = setup({
      gimbalRollMinDeg: -12, gimbalRollMaxDeg: 14, gimbalRollTargetDeg: 12, gimbalRollDeg: 7,
      gimbalYawMinDeg: -17, gimbalYawMaxDeg: 19, gimbalYawTargetDeg: -15, gimbalYawDeg: -9,
    }, { onGimbalRoll, onGimbalYaw });
    const roll = panel.element.querySelector<HTMLInputElement>('[aria-label="Gimbal roll"]')!;
    const yaw = panel.element.querySelector<HTMLInputElement>('[aria-label="Gimbal yaw"]')!;
    expect([roll.min, roll.max, yaw.min, yaw.max]).toEqual(['-12', '14', '-17', '19']);
    button('Roll camera right').click(); expect(onGimbalRoll).toHaveBeenLastCalledWith(14);
    expect(button('Roll camera right').disabled).toBe(true);
    expect(roll.getAttribute('aria-valuetext')).toBe('14° target, 7° actual');
    button('Roll camera left').click(); expect(onGimbalRoll).toHaveBeenLastCalledWith(9);
    button('Reset camera roll to zero').click(); expect(onGimbalRoll).toHaveBeenLastCalledWith(0);
    expect(button('Reset camera roll to zero').disabled).toBe(true);
    button('Turn camera left').click(); expect(onGimbalYaw).toHaveBeenLastCalledWith(-17);
    expect(button('Turn camera left').disabled).toBe(true);
    button('Turn camera right').click(); expect(onGimbalYaw).toHaveBeenLastCalledWith(-12);
    yaw.value = '8'; yaw.dispatchEvent(new Event('input')); expect(onGimbalYaw).toHaveBeenLastCalledWith(8);
    button('Reset camera yaw to zero').click(); expect(onGimbalYaw).toHaveBeenLastCalledWith(0);
  });

  it("defaults missing optional axis bounds to a disabled zero range and locks overrides during a sequence", () => {
    const onGimbalRoll = vi.fn(), onGimbalYaw = vi.fn();
    const { panel, button } = setup({}, { onGimbalRoll, onGimbalYaw });
    const roll = panel.element.querySelector<HTMLInputElement>('[aria-label="Gimbal roll"]')!;
    const yaw = panel.element.querySelector<HTMLInputElement>('[aria-label="Gimbal yaw"]')!;
    expect([roll.min, roll.max, yaw.min, yaw.max]).toEqual(['0', '0', '0', '0']);
    expect(roll.disabled && yaw.disabled).toBe(true);
    const overrides = { ...initial, gimbalRollMinDeg: -12, gimbalRollMaxDeg: 14, gimbalRollTargetDeg: 5,
      gimbalYawMinDeg: -17, gimbalYawMaxDeg: 19, gimbalYawTargetDeg: 10 };
    panel.update({ ...overrides, captureHeld: true });
    expect(roll.disabled && yaw.disabled).toBe(true);
    for (const label of ['Roll camera left', 'Roll camera right', 'Turn camera left', 'Turn camera right',
      'Reset camera roll to zero', 'Reset camera yaw to zero']) expect(button(label).disabled).toBe(true);
    roll.value = '8'; roll.dispatchEvent(new Event('input'));
    yaw.value = '8'; yaw.dispatchEvent(new Event('input'));
    expect(onGimbalRoll).not.toHaveBeenCalled(); expect(onGimbalYaw).not.toHaveBeenCalled();
    panel.element.remove(); panel.update(overrides); document.body.append(panel.element);
    expect(roll.disabled || yaw.disabled).toBe(false);
    expect([roll.value, yaw.value]).toEqual(['5', '10']);
    button('Reset camera yaw to zero').click(); expect(onGimbalYaw).toHaveBeenLastCalledWith(0);
  });

  it("starts a sequence, reports progress, locks competing commands and always allows a stop", () => {
    const { panel, commands, button, range } = setup();
    button("Take still").click(); expect(commands.onShutter).toHaveBeenCalledOnce();
    button("Start 360 capture").click(); expect(commands.onCapture).toHaveBeenLastCalledWith(true);
    panel.update({ ...initial, captureHeld: true, isCapturing: true, capturePhase: "capturing", nodeIndex: 3, nodeCount: 22,
      paused: true, blocked: "360 capture requires WebGPU.", stillBusy: true });
    expect(range.disabled).toBe(true);
    expect(button("Take still").disabled).toBe(true);
    expect(button("Tilt camera down").disabled).toBe(true);
    expect(button("Stop 360 capture").disabled).toBe(false);
    expect(panel.element.querySelector(".drone-camera-controls__hint")?.textContent).toBe("Resume flight to continue the 360.");
    expect(panel.element.querySelector('[role="status"]')?.textContent).toContain("Taking still · 4/22");
    const progress = panel.element.querySelector("progress")!;
    expect(progress.hidden).toBe(false); expect(progress.value).toBe(3); expect(progress.max).toBe(22);
    range.value = "-45"; range.dispatchEvent(new Event("input"));
    expect(commands.onGimbalPitch).not.toHaveBeenCalled();
    button("Stop 360 capture").click(); expect(commands.onCapture).toHaveBeenLastCalledWith(false);
  });

  it("shows the paused hint and blocks sequence start, then resumes without rebuilding the panel", () => {
    const { panel, commands, button } = setup({ paused: true });
    expect(button("Start 360 capture").disabled).toBe(true);
    expect(button("Take still").disabled).toBe(false);
    expect(panel.element.querySelector<HTMLElement>(".drone-camera-controls__hint")?.hidden).toBe(false);
    button("Start 360 capture").click(); expect(commands.onCapture).not.toHaveBeenCalled();
    panel.update(initial);
    expect(button("Start 360 capture").disabled).toBe(false);
    expect(panel.element.querySelector<HTMLElement>(".drone-camera-controls__hint")?.hidden).toBe(true);
  });

  it("shows platform refusals and transient failures with different retry behavior", () => {
    const { panel, button } = setup({ blocked: "360 capture requires WebGPU." });
    expect(button("Take still").disabled).toBe(true);
    expect(button("Start 360 capture").disabled).toBe(true);
    expect(panel.element.querySelector('[role="alert"]')?.textContent).toContain("requires WebGPU");
    panel.update({ ...initial, error: "GPU readback failed." });
    expect(panel.element.querySelector('[role="alert"]')?.textContent).toBe("GPU readback failed.");
    expect(button("Take still").disabled).toBe(false);
    expect(button("Start 360 capture").disabled).toBe(false);
    panel.update({ ...initial, stillBusy: true });
    expect(button("Take still").disabled).toBe(true);
    expect(button("Take still").getAttribute("aria-busy")).toBe("true");
  });

  it("retains live state across detach/reopen and cleans commands and help on destruction", () => {
    const { panel, commands, button } = setup();
    panel.element.remove();
    panel.update({ ...initial, gimbalTargetDeg: -30, isCapturing: true, nodeIndex: 5, nodeCount: 22, capturePhase: "slewing" });
    document.body.append(panel.element);
    expect(button("Stop 360 capture").disabled).toBe(false);
    expect(panel.element.querySelector('[role="status"]')?.textContent).toBe("Turning camera · 6/22");
    button("Stop 360 capture").click(); expect(commands.onCapture).toHaveBeenCalledExactlyOnceWith(false);
    const help = button("Explain camera capture"); help.click();
    expect(help.getAttribute("aria-expanded")).toBe("true");
    const stop = button("Stop 360 capture");
    panel.destroy(); stop.click();
    expect(commands.onCapture).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(panel.element.isConnected).toBe(false);
  });
});
