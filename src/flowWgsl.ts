export function lumaWgsl(wgX: number, wgY: number): string {
  return `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@compute @workgroup_size(${wgX}, ${wgY})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(src);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  // Match the still image: convert Babylon RTT rows to top-down sensor pixels.
  let color = textureLoad(src, vec2<i32>(i32(id.x), i32(dims.y - 1u - id.y)), 0);
  let y = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  textureStore(dst, vec2<i32>(id.xy), vec4<f32>(y, 0.0, 0.0, 0.0));
}`;
}

export function boxWgsl(wgX: number, wgY: number): string {
  return `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@compute @workgroup_size(${wgX}, ${wgY})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(dst);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let x = i32(id.x) * 2;
  let y = i32(id.y) * 2;
  let sum = textureLoad(src, vec2<i32>(x, y), 0).r
    + textureLoad(src, vec2<i32>(x + 1, y), 0).r
    + textureLoad(src, vec2<i32>(x, y + 1), 0).r
    + textureLoad(src, vec2<i32>(x + 1, y + 1), 0).r;
  textureStore(dst, vec2<i32>(id.xy), vec4<f32>(sum * 0.25, 0.0, 0.0, 0.0));
}`;
}

export function lkWgsl(wgX: number, wgY: number): string {
  return `
@group(0) @binding(0) var prev: texture_2d<f32>;
@group(0) @binding(1) var curr: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> flow_in: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> flow_out: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> confidence: array<f32>;
struct LkParams { width: u32, height: u32, level: u32, scale: f32 }
@group(0) @binding(5) var<uniform> params: LkParams;

fn sample_luma(tex: texture_2d<f32>, x: i32, y: i32) -> f32 {
  let dims = textureDimensions(tex);
  let cx = clamp(x, 0, i32(dims.x) - 1);
  let cy = clamp(y, 0, i32(dims.y) - 1);
  return textureLoad(tex, vec2<i32>(cx, cy), 0).r;
}

@compute @workgroup_size(${wgX}, ${wgY})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  if (id.x < 3u || id.y < 3u || id.x + 3u >= params.width || id.y + 3u >= params.height) {
    flow_out[index] = vec2<f32>(0.0, 0.0);
    confidence[index] = 0.0;
    return;
  }
  let x = i32(id.x);
  let y = i32(id.y);
  var initial: vec2<f32>;
  if (params.scale > 1.0) {
    let cw = params.width / 2u;
    initial = flow_in[(id.y / 2u) * cw + (id.x / 2u)] * params.scale;
  } else {
    initial = flow_in[index];
  }
  let ix = (sample_luma(prev, x + 1, y) - sample_luma(prev, x - 1, y)) * 0.5;
  let iy = (sample_luma(prev, x, y + 1) - sample_luma(prev, x, y - 1)) * 0.5;
  var gxx = 0.0;
  var gxy = 0.0;
  var gyy = 0.0;
  var gxt = 0.0;
  var gyt = 0.0;
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let px = x + dx;
      let py = y + dy;
      let warped_x = px + i32(round(initial.x));
      let warped_y = py + i32(round(initial.y));
      let it = sample_luma(curr, warped_x, warped_y) - sample_luma(prev, px, py);
      gxx += ix * ix;
      gxy += ix * iy;
      gyy += iy * iy;
      gxt += ix * it;
      gyt += iy * it;
    }
  }
  let det = gxx * gyy - gxy * gxy;
  var ux = 0.0;
  var uy = 0.0;
  if (det > 1e-8) {
    ux = (gyy * gxt - gxy * gyt) / det;
    uy = (gxx * gyt - gxy * gxt) / det;
  }
  let half = 0.5 * (gxx - gyy);
  let lambda_min = 0.5 * (gxx + gyy) - sqrt(half * half + gxy * gxy);
  flow_out[index] = initial + vec2<f32>(ux, uy);
  confidence[index] = max(lambda_min, 0.0);
}`;
}
