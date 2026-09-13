/**
 * City and infrastructure shader (M13, T-0101).
 *
 * ONE instanced primitive — an oriented box — carries every built thing:
 * buildings, street and road segments, rail, bridge decks, port moles and the
 * aggregate blocks a city collapses to from orbit. That is a deliberate
 * restriction. A second pipeline per primitive kind would be more expressive
 * and would double the surface that has to be validated against the WGSL before
 * anyone can look at it, and M13's problem is that none of this existed to look
 * at, not that boxes are the wrong shape.
 *
 * PRECISION (DEC-005, DEC-033). Instance centres arrive CAMERA-RELATIVE in f32
 * metres, computed on the CPU in f64. No planet-centred position is ever
 * reconstructed here: at Earth radius an f32 ulp is 0.5 m, which is larger than
 * a building.
 *
 * "meta" is a WGSL reserved word. Do not use it as an identifier.
 */

export const CITY_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj      : mat4x4<f32>,
  sunDirection  : vec4<f32>,
  // x = planet radius, y = camera altitude, z = debug mode, w = sea level (m).
  params        : vec4<f32>,
  camK          : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct CityInstance {
  // xyz: box centre, camera-relative metres. w: kind id, for shading only.
  centre : vec4<f32>,
  // xyz: unit axis. w: half extent along it, metres.
  axisX  : vec4<f32>,
  axisY  : vec4<f32>,
  axisZ  : vec4<f32>,
  // rgb tint, a = emissive fraction (lit windows at night).
  tint   : vec4<f32>,
};

@group(0) @binding(1) var<storage, read> instances : array<CityInstance>;

struct VsOut {
  @builtin(position) clip      : vec4<f32>,
  @location(0)       normal    : vec3<f32>,
  @location(1)       tint      : vec4<f32>,
  @location(2)       viewDepth : f32,
  @location(3)       kind      : f32,
};

@vertex
fn vs(
  // Unit cube corner in [-1, 1], with its outward face normal.
  @location(0) corner : vec3<f32>,
  @location(1) faceNormal : vec3<f32>,
  @builtin(instance_index) inst : u32,
) -> VsOut {
  let b = instances[inst];
  let ax = b.axisX.xyz * (corner.x * b.axisX.w);
  let ay = b.axisY.xyz * (corner.y * b.axisY.w);
  let az = b.axisZ.xyz * (corner.z * b.axisZ.w);
  let world = b.centre.xyz + ax + ay + az;

  var out : VsOut;
  out.clip = u.viewProj * vec4<f32>(world, 1.0);
  // Rotate the face normal into the box's frame.
  out.normal = normalize(
      b.axisX.xyz * faceNormal.x
    + b.axisY.xyz * faceNormal.y
    + b.axisZ.xyz * faceNormal.z);
  out.tint = b.tint;
  out.viewDepth = length(world);
  out.kind = b.centre.w;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let l = normalize(u.sunDirection.xyz);
  let lambert = max(dot(n, l), 0.0);
  // A little ambient so unlit faces read as geometry rather than silhouette.
  let ambient = 0.18;
  var lit = in.tint.rgb * (ambient + lambert * 0.92);

  // Emissive windows fade in as the sun goes down, so a night city is legible.
  let night = clamp(1.0 - lambert * 3.0, 0.0, 1.0);
  lit = lit + in.tint.rgb * in.tint.a * night * 0.85;

  // Distance haze, matched in spirit to the terrain pass.
  let haze = clamp(in.viewDepth / 260000.0, 0.0, 1.0);
  lit = mix(lit, vec3<f32>(0.30, 0.38, 0.46), haze * 0.55);

  return vec4<f32>(lit, 1.0);
}
`;
