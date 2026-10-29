/// <reference path="./jpeg-js.d.ts" />
import type { AbstractMesh, Scene, UniversalCamera } from "@babylonjs/core";
import { insertJpegMetadata, type JpegShotMeta } from "./jpegExif";
import type { CameraProfile } from "./profile";
import { createSensorRenderer, type SensorEngine } from "./sensorRender";

export function captureSize(width: number, height: number, maxTexture: number, maxBuffer: number): { width: number; height: number; scale: number } {
  let scale = 1;
  const fits = (s: number) => {
    const w = Math.round(width / s);
    const h = Math.round(height / s);
    const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
    return w <= maxTexture && h <= maxTexture && w >= 2 && h >= 2 && bytesPerRow * h <= maxBuffer;
  };
  while (!fits(scale)) scale += 1;
  return { width: Math.round(width / scale), height: Math.round(height / scale), scale };
}

export interface CaptureShot {
  jpeg: Uint8Array;
  width: number;
  height: number;
  scale: number;
}

export interface CaptureRig {
  capture(camera: UniversalCamera, profile: CameraProfile, meta: Omit<JpegShotMeta, "width" | "height" | "scale" | "focalPx">): Promise<CaptureShot>;
  proxy(camera: UniversalCamera, profile: CameraProfile): Promise<GPUTexture | null>;
  dispose(): void;
}

/** One-shot offscreen stills. WebGL throws. The canvas is not read. */
export function createCaptureRig(scene: Scene, mode: string, engine: SensorEngine, includeMesh: (mesh: AbstractMesh) => boolean = () => true): CaptureRig {
  const sensor = createSensorRenderer(scene, engine, includeMesh);
  return {
    async capture(camera, profile, meta) {
      if (mode !== "webgpu") throw new Error("360° capture requires WebGPU.");
      const device = engine._device;
      if (!device) throw new Error("WebGPU device is missing.");
      const size = captureSize(profile.sensorW, profile.sensorH, device.limits.maxTextureDimension2D, device.limits.maxBufferSize);
      const texture = sensor.render(camera, profile, size.width, size.height, "drone-still");
      const rgba = await sensor.read(texture, size.width, size.height);
      const encoder = await import("jpeg-js");
      const encoded = encoder.default.encode({ data: rgba, width: size.width, height: size.height }, profile.jpegQuality);
      const focalPx = (size.height / 2) / Math.tan(profile.vfovRad / 2);
      const jpeg = insertJpegMetadata(new Uint8Array(encoded.data), { ...meta, width: size.width, height: size.height, scale: size.scale, focalPx });
      return { jpeg, width: size.width, height: size.height, scale: size.scale };
    },
    async proxy(camera, profile) {
      if (mode !== "webgpu" || !engine._device) return null;
      const height = Math.round(320 * profile.sensorH / profile.sensorW / 2) * 2;
      return sensor.render(camera, profile, 320, height, "drone-flow");
    },
    dispose() {
      sensor.dispose();
    },
  };
}
