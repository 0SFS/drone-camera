import type { AbstractMesh, Scene, UniversalCamera } from "@babylonjs/core";
import type { CameraProfile } from "./profile";
import { createSensorRenderer, type SensorEngine } from "./sensorRender";

export interface SensorFrame {
  width: number;
  height: number;
  /** Tightly packed, upright RGBA pixels, independent of the display canvas. */
  rgba: Uint8Array;
}

export interface SensorPreviewRig {
  /** A narrower FOV magnifies only this preview, preserving the camera's capture lens. */
  read(camera: UniversalCamera, profile: CameraProfile, width?: number, verticalFovRad?: number): Promise<SensorFrame>;
  dispose(): void;
}

/** Bound preview work to a small image while retaining the selected sensor aspect. */
export function sensorPreviewSize(profile: Pick<CameraProfile, "sensorW" | "sensorH">,
  requestedWidth: number, maxTexture: number, maxBuffer: number): { width: number; height: number } {
  const aspect = profile.sensorH / profile.sensorW;
  if (!(Number.isFinite(aspect) && aspect > 0 && maxTexture >= 2 && maxBuffer >= 512)) {
    throw new Error("Camera preview dimensions are unsupported.");
  }
  let width = Math.max(2, Math.min(640, profile.sensorW, Number.isFinite(requestedWidth) ? Math.round(requestedWidth) : 640,
    Math.floor(maxTexture), Math.floor(maxTexture / aspect)));
  let height = Math.max(2, Math.round(width * aspect));
  while (Math.ceil(width * 4 / 256) * 256 * height > maxBuffer) {
    if (width <= 2) throw new Error("Camera preview exceeds the WebGPU buffer limit.");
    width -= 1;
    height = Math.max(2, Math.round(width * aspect));
  }
  return { width, height };
}

/** Optional preview transport. No JPEG, flow or flight-controller code is imported. */
export function createSensorPreviewRig(scene: Scene, mode: string, engine: SensorEngine,
  includeMesh?: (mesh: AbstractMesh) => boolean): SensorPreviewRig {
  const sensor = createSensorRenderer(scene, engine, includeMesh);
  let disposed = false;
  let reading = false;
  return {
    async read(camera, profile, width = 640, verticalFovRad = profile.vfovRad) {
      if (disposed) throw new Error("Camera preview is disposed.");
      if (mode !== "webgpu") throw new Error("Camera preview requires WebGPU.");
      const device = engine._device;
      if (!device) throw new Error("WebGPU device is missing.");
      if (reading) throw new Error("A camera preview frame is already being read.");
      reading = true;
      try {
        const size = sensorPreviewSize(profile, width, device.limits.maxTextureDimension2D, device.limits.maxBufferSize);
        const fov = Number.isFinite(verticalFovRad) && verticalFovRad > 0
          ? Math.min(profile.vfovRad, verticalFovRad) : profile.vfovRad;
        // Sensor submission is synchronous. Restore the shared camera before yielding
        // to readback, so cockpit view and still capture always keep their own lens.
        const lens = { fov: camera.fov, mode: camera.fovMode };
        let texture: GPUTexture;
        try {
          texture = sensor.render(camera, fov === profile.vfovRad ? profile : { ...profile, vfovRad: fov },
            size.width, size.height, "drone-preview");
        } finally {
          camera.fov = lens.fov;
          camera.fovMode = lens.mode;
          camera.getProjectionMatrix(true);
        }
        const rgba = await sensor.read(texture, size.width, size.height);
        return { ...size, rgba };
      } finally { reading = false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sensor.dispose();
    },
  };
}
