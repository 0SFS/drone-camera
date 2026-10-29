import { Constants, RenderTargetTexture, UniversalCamera, type AbstractMesh, type Scene } from "@babylonjs/core";
import type { CameraProfile } from "./profile";

export interface SensorEngine {
  _device?: GPUDevice;
  flushFramebuffer(): void;
}

/** Removes WebGPU row padding and converts Babylon's bottom-up target to image rows. */
export function unpackSensorRows(packed: Uint8Array, width: number, height: number): Uint8Array {
  const row = width * 4;
  const stride = Math.ceil(row / 256) * 256;
  const rgba = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) rgba.set(packed.subarray(y * stride, y * stride + row), (height - 1 - y) * row);
  return rgba;
}

/** Shared offscreen sensor path. It never reads the display canvas or loads an encoder. */
export function createSensorRenderer(scene: Scene, engine: SensorEngine,
  includeMesh: (mesh: AbstractMesh) => boolean = () => true) {
  const targets = new Map<string, RenderTargetTexture>();
  let readback: GPUBuffer | null = null;
  let readbackSize = 0;
  let reading = false;
  let disposed = false;
  return {
    render(camera: UniversalCamera, profile: CameraProfile, width: number, height: number, name: string): GPUTexture {
      if (disposed) throw new Error("Camera sensor is disposed.");
      const key = `${name}:${width}x${height}`;
      let rtt = targets.get(key);
      if (!rtt) {
        rtt = new RenderTargetTexture(name, { width, height }, scene, false, false,
          Constants.TEXTURETYPE_UNSIGNED_BYTE, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE,
          undefined, undefined, undefined, Constants.TEXTUREFORMAT_RGBA);
        // Include loaded geometry outside the chase camera's current active list.
        rtt.renderListPredicate = mesh => mesh.isEnabled() && mesh.isVisible && includeMesh(mesh);
        const index = scene.customRenderTargets.indexOf(rtt);
        if (index >= 0) scene.customRenderTargets.splice(index, 1);
        targets.set(key, rtt);
      }
      rtt.activeCamera = camera;
      camera.fov = profile.vfovRad;
      camera.fovMode = UniversalCamera.FOVMODE_VERTICAL_FIXED;
      // doNotChangeAspectRatio=false makes Babylon recompute the sensor projection
      // with the target bound, instead of reusing the display canvas aspect.
      rtt.render(true);
      // Submit Babylon's recorded draws before direct WebGPU readback/compute.
      engine.flushFramebuffer();
      const hardware = rtt.getInternalTexture()?._hardwareTexture as { underlyingResource?: GPUTexture } | undefined;
      const texture = hardware?.underlyingResource;
      if (!texture || (texture.usage & GPUTextureUsage.COPY_SRC) === 0) {
        throw new Error("Camera sensor texture is missing COPY_SRC.");
      }
      return texture;
    },
    async read(texture: GPUTexture, width: number, height: number): Promise<Uint8Array> {
      if (disposed) throw new Error("Camera sensor is disposed.");
      if (reading) throw new Error("A camera sensor frame is already being read.");
      const device = engine._device;
      if (!device) throw new Error("WebGPU device is missing.");
      reading = true;
      let mapped = false;
      let buffer: GPUBuffer | null = null;
      try {
        const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
        const size = bytesPerRow * height;
        if (!readback || readbackSize !== size) {
          readback?.destroy();
          readback = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          readbackSize = size;
        }
        buffer = readback;
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        if (disposed) throw new Error("Camera sensor is disposed.");
        mapped = true;
        return unpackSensorRows(new Uint8Array(buffer.getMappedRange()), width, height);
      } finally {
        if (mapped && !disposed) buffer?.unmap();
        reading = false;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Destroy also cancels a pending mapAsync; the caller owns its rejection.
      readback?.destroy();
      readback = null;
      for (const rtt of targets.values()) rtt.dispose();
      targets.clear();
    },
  };
}
