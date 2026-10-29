import { boxWgsl, lkWgsl, lumaWgsl } from "./flowWgsl";
import { estimateFlow, type FlowEstimate, type FlowSample } from "./flowEstimator";

export interface OpticalFlow {
  readonly source: "visual" | "imu";
  push(texture: GPUTexture, width: number, height: number, vfovRad: number, dtFrame: number): void;
  latest(): FlowEstimate;
  dispose(): void;
}

const idle: FlowEstimate = { source: "imu", deltaYawRad: 0, deltaPitchRad: 0, omegaRadPerSec: 0, confidence: 0 };

/** Lucas–Kanade on the proxy. A missing compute limit leaves the sequence on the IMU. */
export function createOpticalFlow(device: GPUDevice): OpticalFlow {
  const limit = device.limits.maxComputeInvocationsPerWorkgroup;
  const wgX = 8;
  const wgY = Math.max(1, Math.min(8, Math.floor(limit / wgX)));
  if (wgY < 1) return { source: "imu", push() {}, latest: () => idle, dispose() {} };
  const luma = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: lumaWgsl(wgX, wgY) }), entryPoint: "main" } });
  const box = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: boxWgsl(wgX, wgY) }), entryPoint: "main" } });
  const lk = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: lkWgsl(wgX, wgY) }), entryPoint: "main" } });
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
  let width = 0;
  let height = 0;
  let full: GPUTexture | null = null;
  let half: GPUTexture | null = null;
  let previous: GPUTexture | null = null;
  let previousHalf: GPUTexture | null = null;
  let flowCoarse: GPUBuffer | null = null;
  let flowZero: GPUBuffer | null = null;
  let flowFine: GPUBuffer | null = null;
  let confidence: GPUBuffer | null = null;
  let readback: GPUBuffer | null = null;
  let coarseParams: GPUBuffer | null = null;
  let fineParams: GPUBuffer | null = null;
  let busy = false;
  let estimate = idle;
  const storage = (w: number, h: number) => device.createTexture({
    size: { width: w, height: h }, format: "r32float", usage,
  });
  const ensure = (w: number, h: number) => {
    if (width === w && height === h && full) return;
    full?.destroy(); half?.destroy(); previous?.destroy(); previousHalf?.destroy();
    flowCoarse?.destroy(); flowZero?.destroy(); flowFine?.destroy(); confidence?.destroy(); readback?.destroy();
    width = w;
    height = h;
    const halfW = Math.max(1, w >> 1);
    const halfH = Math.max(1, h >> 1);
    full = storage(w, h);
    half = storage(halfW, halfH);
    previous = storage(w, h);
    previousHalf = storage(halfW, halfH);
    const coarse = halfW * halfH;
    const fine = w * h;
    flowCoarse = device.createBuffer({ size: Math.max(16, coarse * 8), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    flowZero = device.createBuffer({ size: Math.max(16, coarse * 8), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    flowFine = device.createBuffer({ size: fine * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    confidence = device.createBuffer({ size: fine * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    readback = device.createBuffer({ size: fine * 8 + fine * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    coarseParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    fineParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(flowZero, 0, new Float32Array(coarse * 2));
  };
  const dispatch = (pipeline: GPUComputePipeline, binds: GPUBindGroup, w: number, h: number) => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binds);
    pass.dispatchWorkgroups(Math.ceil(w / wgX), Math.ceil(h / wgY));
    pass.end();
    return encoder;
  };
  return {
    source: "visual",
    push(texture, w, h, vfovRad, dtFrame) {
      ensure(w, h);
      if (!full || !half || !previous || !previousHalf || !flowCoarse || !flowZero || !flowFine || !confidence || !readback || !coarseParams || !fineParams || busy) return;
      busy = true;
      const pack = (levelWidth: number, levelHeight: number, level: number, scale: number) => {
        const data = new ArrayBuffer(16);
        const view = new DataView(data);
        view.setUint32(0, levelWidth, true);
        view.setUint32(4, levelHeight, true);
        view.setUint32(8, level, true);
        view.setFloat32(12, scale, true);
        return data;
      };
      device.queue.writeBuffer(coarseParams, 0, pack(w >> 1, h >> 1, 1, 1));
      device.queue.writeBuffer(fineParams, 0, pack(w, h, 0, 2));
      const lumaBind = device.createBindGroup({
        layout: luma.getBindGroupLayout(0) as unknown as GPUBindGroupLayout,
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: full.createView() },
        ],
      });
      const boxBind = device.createBindGroup({
        layout: box.getBindGroupLayout(0) as unknown as GPUBindGroupLayout,
        entries: [
          { binding: 0, resource: full.createView() },
          { binding: 1, resource: half.createView() },
        ],
      });
      const coarseBind = device.createBindGroup({
        layout: lk.getBindGroupLayout(0) as unknown as GPUBindGroupLayout,
        entries: [
          { binding: 0, resource: previousHalf.createView() },
          { binding: 1, resource: half.createView() },
          { binding: 2, resource: { buffer: flowZero } },
          { binding: 3, resource: { buffer: flowCoarse } },
          { binding: 4, resource: { buffer: confidence } },
          { binding: 5, resource: { buffer: coarseParams } },
        ],
      });
      const fineBind = device.createBindGroup({
        layout: lk.getBindGroupLayout(0) as unknown as GPUBindGroupLayout,
        entries: [
          { binding: 0, resource: previous.createView() },
          { binding: 1, resource: full.createView() },
          { binding: 2, resource: { buffer: flowCoarse } },
          { binding: 3, resource: { buffer: flowFine } },
          { binding: 4, resource: { buffer: confidence } },
          { binding: 5, resource: { buffer: fineParams } },
        ],
      });
      const lumaPass = dispatch(luma, lumaBind, w, h);
      const boxPass = dispatch(box, boxBind, w >> 1, h >> 1);
      const coarsePass = dispatch(lk, coarseBind, w >> 1, h >> 1);
      const finePass = dispatch(lk, fineBind, w, h);
      finePass.copyBufferToBuffer(flowFine, 0, readback, 0, w * h * 8);
      finePass.copyBufferToBuffer(confidence, 0, readback, w * h * 8, w * h * 4);
      device.queue.submit([lumaPass.finish(), boxPass.finish(), coarsePass.finish(), finePass.finish()]);
      const copy = previous;
      previous = full;
      full = copy;
      const copyHalf = previousHalf;
      previousHalf = half;
      half = copyHalf;
      void readback.mapAsync(GPUMapMode.READ).then(() => {
        const mapped = new Float32Array(readback!.getMappedRange().slice(0));
        readback!.unmap();
        const count = w * h;
        const samples: FlowSample[] = [];
        for (let i = 0; i < count; i += 1) {
          samples.push({ x: mapped[i * 2] ?? 0, y: mapped[i * 2 + 1] ?? 0, confidence: mapped[count * 2 + i] ?? 0 });
        }
        estimate = estimateFlow(samples, h, vfovRad, dtFrame);
        busy = false;
      }).catch(() => {
        estimate = idle;
        busy = false;
      });
    },
    latest: () => estimate,
    dispose() {
      full?.destroy(); half?.destroy(); previous?.destroy(); previousHalf?.destroy();
      flowCoarse?.destroy(); flowZero?.destroy(); flowFine?.destroy(); confidence?.destroy(); readback?.destroy();
      coarseParams?.destroy(); fineParams?.destroy();
    },
  };
}
