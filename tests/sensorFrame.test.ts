import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbstractMesh, Scene, UniversalCamera } from "@babylonjs/core";
import { createSensorPreviewRig, sensorPreviewSize } from "../src/sensorFrame";
import type { CameraProfile } from "../src/profile";

const state = vi.hoisted(() => ({
  submitted: false,
  rendered: 0,
  renderedFov: 0,
  disposedTargets: 0,
  targets: [] as { name: string; size: { width: number; height: number }; renderListPredicate?: (mesh: unknown) => boolean }[],
}));
vi.mock("@babylonjs/core", () => ({
  Constants: { TEXTURETYPE_UNSIGNED_BYTE: 0, TEXTURE_NEAREST_SAMPLINGMODE: 1, TEXTUREFORMAT_RGBA: 5 },
  UniversalCamera: { FOVMODE_VERTICAL_FIXED: 0 },
  RenderTargetTexture: class {
    constructor(public name: string, public size: { width: number; height: number }, scene: { customRenderTargets: unknown[] }) {
      scene.customRenderTargets.push(this); state.targets.push(this);
    }
    activeCamera?: UniversalCamera;
    render() { state.rendered++; state.renderedFov = this.activeCamera?.fov ?? 0; state.submitted = false; }
    getInternalTexture() { return { _hardwareTexture: { underlyingResource: { usage: 1 } } }; }
    dispose() { state.disposedTargets++; }
  },
}));

beforeEach(() => {
  state.submitted = false; state.rendered = state.disposedTargets = 0; state.targets.length = 0;
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1 });
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 2, MAP_READ: 4 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => vi.unstubAllGlobals());

const profile = { sensorW: 2, sensorH: 2, vfovRad: 1 } as CameraProfile;
const sensorCamera = () => ({ fov: 1, fovMode: 0, getProjectionMatrix: vi.fn() }) as unknown as UniversalCamera;
function rig(map?: Promise<void>, mode = "webgpu") {
  let bytes = new Uint8Array(0);
  const destroy = vi.fn();
  const unmap = vi.fn();
  const getMappedRange = vi.fn(() => bytes.buffer);
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256e6 },
    createBuffer: ({ size }: { size: number }) => {
      bytes = new Uint8Array(size);
      return { mapAsync: () => map ?? Promise.resolve(), getMappedRange, unmap, destroy };
    },
    createCommandEncoder: () => ({
      copyTextureToBuffer() {
        expect(state.submitted).toBe(true);
        bytes.set([1, 2, 3, 255, 4, 5, 6, 255], 0);
        bytes.set([7, 8, 9, 255, 10, 11, 12, 255], 256);
      },
      finish() { return {}; },
    }),
    queue: { submit() {} },
  } as unknown as GPUDevice;
  const scene = { customRenderTargets: [] } as unknown as Scene;
  const engine = { _device: device, flushFramebuffer() { state.submitted = true; } };
  const includeMesh = vi.fn((mesh: AbstractMesh) => mesh.name !== "own-aircraft");
  return { preview: createSensorPreviewRig(scene, mode, engine, includeMesh), scene, destroy, unmap, getMappedRange };
}

describe("sensor preview frames", () => {
  it("uses the selected lens, submits draws, and returns upright pixels without GPU padding", async () => {
    const { preview, scene } = rig();
    const camera = sensorCamera();
    try {
      const frame = await preview.read(camera, profile);
      expect(frame).toEqual({ width: 2, height: 2,
        rgba: new Uint8Array([7, 8, 9, 255, 10, 11, 12, 255, 1, 2, 3, 255, 4, 5, 6, 255]) });
      expect(camera.fov).toBe(1);
      expect(scene.customRenderTargets).toEqual([]);
      const predicate = state.targets[0]!.renderListPredicate!;
      expect(predicate({ name: "terrain", isEnabled: () => true, isVisible: true })).toBe(true);
      expect(predicate({ name: "own-aircraft", isEnabled: () => true, isVisible: true })).toBe(false);
      expect(predicate({ name: "hidden", isEnabled: () => true, isVisible: false })).toBe(false);
      await preview.read(camera, profile);
      expect(state.targets).toHaveLength(1);
    } finally { preview.dispose(); }
    expect(state.disposedTargets).toBe(1);
  });
  it("rejects overlapping reads and discards a frame when disposed during mapping", async () => {
    let release!: () => void;
    const pendingMap = new Promise<void>(resolve => { release = resolve; });
    const { preview, destroy, unmap, getMappedRange } = rig(pendingMap);
    const camera = sensorCamera();
    camera.fov = 1.2;
    const first = preview.read(camera, profile, 640, .4);
    expect(state.renderedFov).toBe(.4);
    expect(camera.fov).toBe(1.2);
    expect(camera.getProjectionMatrix).toHaveBeenCalledWith(true);
    const rejection = expect(first).rejects.toThrow("disposed");
    await expect(preview.read(camera, profile)).rejects.toThrow("already being read");
    expect(state.rendered).toBe(1);
    preview.dispose(); preview.dispose(); release();
    await rejection;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(getMappedRange).not.toHaveBeenCalled();
    expect(unmap).not.toHaveBeenCalled();
    await expect(preview.read(camera, profile)).rejects.toThrow("disposed");
  });
  it("refuses WebGL before allocating or rendering", async () => {
    const { preview } = rig(undefined, "webgl2");
    await expect(preview.read({} as UniversalCamera, profile)).rejects.toThrow("requires WebGPU");
    expect(state.targets).toHaveLength(0);
    preview.dispose();
  });
  it("magnifies the preview without changing the capture lens, and caps zoom-out at its native view", async () => {
    const { preview } = rig();
    const camera = sensorCamera();
    camera.fov = 1.2; camera.fovMode = 1;
    await preview.read(camera, profile, 640, .4);
    expect(state.renderedFov).toBe(.4);
    expect(camera.fov).toBe(1.2); expect(camera.fovMode).toBe(1);
    expect(profile.vfovRad).toBe(1);
    await preview.read(camera, profile, 640, 2);
    expect(state.renderedFov).toBe(1);
    expect(camera.fov).toBe(1.2);
    preview.dispose();
  });
});

it("caps preview work and preserves camera aspect within GPU texture and padded-buffer limits", () => {
  const mini = { sensorW: 4000, sensorH: 3000 };
  const air = { sensorW: 5472, sensorH: 3648 };
  expect(sensorPreviewSize(mini, 1000, 8192, 256e6)).toEqual({ width: 640, height: 480 });
  expect(sensorPreviewSize(air, 640, 8192, 256e6)).toEqual({ width: 640, height: 427 });
  const small = sensorPreviewSize(mini, 640, 256, 32_768);
  expect(small.width).toBeLessThanOrEqual(256);
  expect(Math.abs(small.height / small.width - .75)).toBeLessThan(.01);
  expect(Math.ceil(small.width * 4 / 256) * 256 * small.height).toBeLessThanOrEqual(32_768);
  expect(() => sensorPreviewSize(mini, 640, 8192, 128)).toThrow("unsupported");
});
