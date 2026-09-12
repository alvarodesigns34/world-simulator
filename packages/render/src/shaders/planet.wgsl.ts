/**
 * Planet surface shader (T-0010, DEC-005, DEC-033).
 *
 * PRECISION CONTRACT, enforced by what is absent:
 *
 *   There is NO camera-PCF uniform in this bind group.
 *   There is NO planet-centre reconstruction in the vertex shader.
 *
 * Vertices arrive ALREADY camera-relative, differenced in f64 on the CPU.
 * Four sphere-surface corners are bilinearly interpolated in that space.
 * The old path reconstructed onFace - centreRel with centreRel = -camera
 * in f32, which is exactly the add DEC-033 rule 1 forbids, and it used three
 * corners so the (1,1) vertex missed the fourth — cracks at every interior
 * edge.
 *
 * "meta" is a WGSL reserved word (W3C reserved-words list). Do not use it as
 * an identifier; Ampere's compiler rejected it and left a black canvas.
 *
 * Reversed-Z: the projection maps near to 1.0 and infinity to 0.0. Depth is
 * cleared to 0.0 and tested GreaterEqual.
 */

export const PLANET_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj      : mat4x4<f32>,
  // Direction only. A direction is scale-free, so it carries no precision risk.
  sunDirection  : vec4<f32>,
  // x = planet radius (reference, not used for positions), y = camera altitude,
  // z = debug mode, w unused.
  params        : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct PatchInstance {
  // Four sphere-surface corners, CAMERA-RELATIVE metres (f64 subtract on CPU).
  // Packed .w: x = lod level, x of c10 = face id. Do not put a world position here.
  c00 : vec4<f32>,
  c10 : vec4<f32>,
  c01 : vec4<f32>,
  c11 : vec4<f32>,
};

@group(0) @binding(1) var<storage, read> instances : array<PatchInstance>;

struct VsOut {
  @builtin(position) clip   : vec4<f32>,
  @location(0)       normal : vec3<f32>,
  @location(1)       uv     : vec2<f32>,
  @location(2)       level  : f32,
  @location(3)       viewDepth : f32,
};

@vertex
fn vs(
  @location(0) grid : vec2<f32>,
  @builtin(instance_index) inst : u32,
) -> VsOut {
  let p = instances[inst];
  let s = grid.x;
  let t = grid.y;

  // Bilinear interpolation of the four sphere corners. Adjacent patches share
  // two corners on a seam, so the edge is the same lerp — no three-corner gap.
  let a = mix(p.c00.xyz, p.c10.xyz, s);
  let b = mix(p.c01.xyz, p.c11.xyz, s);
  let surface = mix(a, b, t);

  // Geometric normal from the bilinear partials. Outward because the CPU
  // packed corners in (u,v) order with ∂u × ∂v pointing out (cube-sphere
  // orientation contract) and the index buffer is CCW in that frame.
  let ddu = mix(p.c10.xyz - p.c00.xyz, p.c11.xyz - p.c01.xyz, t);
  let ddv = mix(p.c01.xyz - p.c00.xyz, p.c11.xyz - p.c10.xyz, s);
  let n = normalize(cross(ddu, ddv));

  var vsOut : VsOut;
  vsOut.clip = u.viewProj * vec4<f32>(surface, 1.0);
  vsOut.normal = n;
  vsOut.uv = grid;
  vsOut.level = p.c00.w;
  vsOut.viewDepth = length(surface);
  return vsOut;
}

fn levelColour(level : f32) -> vec3<f32> {
  let h = fract(level * 0.191 + 0.07);
  let k = vec3<f32>(3.0, 2.0, 1.0);
  let q = abs(fract(vec3<f32>(h) + k / 3.0) * 6.0 - 3.0);
  return clamp(q - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs(frag : VsOut) -> @location(0) vec4<f32> {
  let n = normalize(frag.normal);
  let lambert = max(dot(n, normalize(u.sunDirection.xyz)), 0.0);
  let lit = 0.06 + 0.94 * lambert;

  let debugMode = u.params.z;
  var albedo = vec3<f32>(0.30, 0.38, 0.46);

  if (debugMode > 0.5 && debugMode < 1.5) {
    albedo = levelColour(frag.level);
  }

  if (debugMode > 1.5) {
    let e = min(min(frag.uv.x, 1.0 - frag.uv.x), min(frag.uv.y, 1.0 - frag.uv.y));
    let edge = 1.0 - smoothstep(0.0, 0.012, e);
    albedo = mix(levelColour(frag.level) * 0.6, vec3<f32>(1.0, 0.85, 0.2), edge);
  }

  return vec4<f32>(albedo * lit, 1.0);
}
`;
