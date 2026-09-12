/**
 * Planet surface shader (T-0010, T-0064, DEC-005, DEC-033).
 *
 * Vertices arrive camera-relative. Interior vertices are spherified with the
 * closed form in RENDERING.md §4.0b, then displaced by packed corner heights.
 * Camera position is multiplied only by k = (1-|Bd|)/|Bd| and by h/R — never
 * added to a planet-centred reconstruction.
 *
 * "meta" is a WGSL reserved word. Do not use it as an identifier.
 */

export const PLANET_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj      : mat4x4<f32>,
  sunDirection  : vec4<f32>,
  // x = planet radius, y = camera altitude, z = debug mode, w = sea level (m).
  params        : vec4<f32>,
  // Multiplier for the k·C spherify term (DEC-033 exception: scaled, not added).
  camK          : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct PatchInstance {
  c00  : vec4<f32>,
  c10  : vec4<f32>,
  c01  : vec4<f32>,
  c11  : vec4<f32>,
  // Corner elevations in metres: x=h00 y=h10 z=h01 w=h11.
  elev : vec4<f32>,
};

@group(0) @binding(1) var<storage, read> instances : array<PatchInstance>;

struct VsOut {
  @builtin(position) clip      : vec4<f32>,
  @location(0)       normal    : vec3<f32>,
  @location(1)       uv        : vec2<f32>,
  @location(2)       level     : f32,
  @location(3)       viewDepth : f32,
  @location(4)       heightM   : f32,
  @location(5)       viewDir   : vec3<f32>,
};

fn bilinear4(a : vec3<f32>, b : vec3<f32>, c : vec3<f32>, d : vec3<f32>, s : f32, t : f32) -> vec3<f32> {
  let p = mix(a, b, s);
  let q = mix(c, d, s);
  return mix(p, q, t);
}

@vertex
fn vs(
  @location(0) grid : vec2<f32>,
  @builtin(instance_index) inst : u32,
) -> VsOut {
  let p = instances[inst];
  let s = grid.x;
  let t = grid.y;
  let R = u.params.x;
  let C = u.camK.xyz;

  let B = bilinear4(p.c00.xyz, p.c10.xyz, p.c01.xyz, p.c11.xyz, s, t);

  // Unit-corner differences from camera-relative corners: (ci - ck)/R.
  let d00 = p.c00.xyz;
  let d10 = p.c10.xyz;
  let d01 = p.c01.xyz;
  let d11 = p.c11.xyz;
  let w00 = (1.0 - s) * (1.0 - t);
  let w10 = s * (1.0 - t);
  let w01 = (1.0 - s) * t;
  let w11 = s * t;

  var om : f32 = 0.0;
  om += w00 * w00 * 0.0;
  om += w00 * w10 * dot(d00 - d10, d00 - d10);
  om += w00 * w01 * dot(d00 - d01, d00 - d01);
  om += w00 * w11 * dot(d00 - d11, d00 - d11);
  om += w10 * w00 * dot(d10 - d00, d10 - d00);
  om += w10 * w10 * 0.0;
  om += w10 * w01 * dot(d10 - d01, d10 - d01);
  om += w10 * w11 * dot(d10 - d11, d10 - d11);
  om += w01 * w00 * dot(d01 - d00, d01 - d00);
  om += w01 * w10 * dot(d01 - d10, d01 - d10);
  om += w01 * w01 * 0.0;
  om += w01 * w11 * dot(d01 - d11, d01 - d11);
  om += w11 * w00 * dot(d11 - d00, d11 - d00);
  om += w11 * w10 * dot(d11 - d10, d11 - d10);
  om += w11 * w01 * dot(d11 - d01, d11 - d01);
  om += w11 * w11 * 0.0;
  // |di-dk|² on positions = R² |ui-uk|², so divide by R².
  om = 0.5 * om / max(R * R, 1.0);

  let bd2 = max(1.0 - om, 1.0e-8);
  let bd = sqrt(bd2);
  let k = (1.0 - bd) / bd;
  var sph = B / bd + C * k;

  let h = mix(mix(p.elev.x, p.elev.y, s), mix(p.elev.z, p.elev.w, s), t);
  sph = sph * (1.0 + h / R) + C * (h / R);

  let ddu = mix(p.c10.xyz - p.c00.xyz, p.c11.xyz - p.c01.xyz, t);
  let ddv = mix(p.c01.xyz - p.c00.xyz, p.c11.xyz - p.c10.xyz, s);
  let n = normalize(cross(ddu, ddv));

  var vsOut : VsOut;
  vsOut.clip = u.viewProj * vec4<f32>(sph, 1.0);
  vsOut.normal = n;
  vsOut.uv = grid;
  vsOut.level = p.c00.w;
  vsOut.viewDepth = length(sph);
  vsOut.heightM = h;
  vsOut.viewDir = sph;
  return vsOut;
}

fn levelColour(level : f32) -> vec3<f32> {
  let h = fract(level * 0.191 + 0.07);
  let k = vec3<f32>(3.0, 2.0, 1.0);
  let q = abs(fract(vec3<f32>(h) + k / 3.0) * 6.0 - 3.0);
  return clamp(q - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn hypsometric(h : f32, sl : f32) -> vec3<f32> {
  if (h < sl) {
    let depth = clamp((sl - h) / 6000.0, 0.0, 1.0);
    return mix(vec3<f32>(0.07, 0.28, 0.38), vec3<f32>(0.01, 0.05, 0.12), depth);
  }
  let t = clamp(h / 4000.0, 0.0, 1.0);
  let grass = vec3<f32>(0.23, 0.32, 0.16);
  let rock = vec3<f32>(0.42, 0.36, 0.28);
  let snow = vec3<f32>(0.86, 0.88, 0.90);
  if (t < 0.45) { return mix(grass, rock, t / 0.45); }
  return mix(rock, snow, clamp((t - 0.45) / 0.55, 0.0, 1.0));
}

@fragment
fn fs(frag : VsOut) -> @location(0) vec4<f32> {
  let n = normalize(frag.normal);
  let sun = normalize(u.sunDirection.xyz);
  let lambert = max(dot(n, sun), 0.0);
  let wrap = 0.04 + 0.96 * lambert;
  let sl = u.params.w;
  let debugMode = u.params.z;

  var albedo = hypsometric(frag.heightM, sl);

  // Fresnel-ish ocean at grazing.
  if (frag.heightM < sl) {
    let v = normalize(-frag.viewDir);
    let fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
    albedo = mix(albedo, vec3<f32>(0.55, 0.72, 0.80), fres * 0.65);
  }

  // Cheap Rayleigh limb: optical depth grows toward the horizon.
  let alt = u.params.y;
  let mu = max(dot(n, sun), 0.0);
  let limb = exp(-max(alt, 0.0) / 80000.0) * (1.0 - mu);
  let scatter = vec3<f32>(0.18, 0.32, 0.72) * limb * 0.35;
  // Night side: deep blue, not black, plus a thin twilight band.
  let night = 1.0 - smoothstep(-0.12, 0.08, dot(n, sun));
  let twilight = 1.0 - smoothstep(0.0, 0.18, abs(dot(n, sun)));
  let twilightCol = vec3<f32>(0.55, 0.22, 0.08) * twilight * 0.25;

  if (debugMode > 0.5 && debugMode < 1.5) {
    albedo = levelColour(frag.level);
  }
  if (debugMode > 1.5 && debugMode < 2.5) {
    let e = min(min(frag.uv.x, 1.0 - frag.uv.x), min(frag.uv.y, 1.0 - frag.uv.y));
    let edge = 1.0 - smoothstep(0.0, 0.012, e);
    albedo = mix(levelColour(frag.level) * 0.6, vec3<f32>(1.0, 0.85, 0.2), edge);
  }
  if (debugMode > 2.5) {
    albedo = hypsometric(frag.heightM, sl);
  }

  var rgb = albedo * mix(wrap, 0.03, night) + scatter + twilightCol;
  // Reinhard tonemap, no cinematic grade.
  rgb = rgb / (rgb + vec3<f32>(1.0));
  return vec4<f32>(rgb, 1.0);
}
`;
