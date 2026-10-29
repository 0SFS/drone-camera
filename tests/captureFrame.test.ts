import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCaptureRig } from "../src/captureFrame";
import type { CameraProfile } from "../src/profile";
import type { JpegShotMeta } from "../src/jpegExif";
import type { Scene, UniversalCamera } from "@babylonjs/core";
import jpeg from "jpeg-js";

const state = vi.hoisted(() => ({ pending: false, submitted: false }));
vi.mock("@babylonjs/core", () => ({
  Constants: { TEXTURETYPE_UNSIGNED_BYTE: 0, TEXTURE_NEAREST_SAMPLINGMODE: 1, TEXTUREFORMAT_RGBA: 5 },
  UniversalCamera: { FOVMODE_VERTICAL_FIXED: 0 },
  RenderTargetTexture: class {
    constructor(_name: string, _size: unknown, scene: { customRenderTargets: unknown[] }) { scene.customRenderTargets.push(this); }
    render() { state.pending = true; }
    getInternalTexture() { return { _hardwareTexture: { underlyingResource: { usage: 1 } } }; }
    dispose() {}
  },
}));

beforeEach(() => {
  state.pending = state.submitted = false;
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1 });
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 2, MAP_READ: 4 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => vi.unstubAllGlobals());
const profile = { sensorW: 2, sensorH: 2, vfovRad: 1, jpegQuality: 92 } as CameraProfile;
const meta: Omit<JpegShotMeta, "width" | "height" | "scale" | "focalPx"> = {
  model: "FC7303", make: "DJI", software: "0SFS", xmpNamespace: "http://www.dji.com/drone-dji/1.0/",
  exposureDen: 1000, focalMm: 4.36, focal35mm: 25.43, when: new Date("2026-10-28T00:00:00Z"),
  yawDeg: 0, pitchDeg: 0, rollDeg: 0, gimbalPitchDeg: 0, aglM: 10, mslM: 300,
};
function rig() {
  let bytes = new Uint8Array(0);
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256e6 },
    createBuffer: ({ size }: { size: number }) => {
      bytes = new Uint8Array(size);
      return { mapAsync: async () => {}, getMappedRange: () => bytes.buffer, unmap() {}, destroy() {} };
    },
    createCommandEncoder: () => ({
      copyTextureToBuffer() {
        // A direct GPU copy sees only submitted draw commands.
        if (state.submitted) {
          bytes.set([180, 60, 30, 255, 180, 60, 30, 255], 0);
          bytes.set([30, 60, 180, 255, 30, 60, 180, 255], 256);
        }
      },
      finish() { return {}; },
    }),
    queue: { submit() {} },
  } as unknown as GPUDevice;
  const scene = { customRenderTargets: [] } as unknown as Scene;
  const engine = { _device: device, flushFramebuffer() { state.submitted = state.pending; state.pending = false; } };
  return createCaptureRig(scene, "webgpu", engine);
}

it("submits offscreen draws before readback and encodes those pixels", async () => {
  const capture = rig();
  try {
    const shot = await capture.capture({} as UniversalCamera, profile, meta);
    const decoded = jpeg.decode(shot.jpeg, { useTArray: true });
    expect([decoded.width, decoded.height]).toEqual([2, 2]);
    // The last GPU row is the first JPEG row, with GPU padding removed.
    expect(decoded.data[2]).toBeGreaterThan(160);
    expect(decoded.data[8]).toBeGreaterThan(160);
    expect(decoded.data[1]).toBeGreaterThan(50);
  } finally { capture.dispose(); }
});
it("submits the proxy image before optical flow can read it", async () => {
  const capture = rig();
  try {
    expect(await capture.proxy({} as UniversalCamera, profile)).not.toBeNull();
    expect(state.submitted).toBe(true);
  } finally { capture.dispose(); }
});
