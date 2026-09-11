/**
 * Planet surface shader (T-0010, DEC-005, DEC-033).
 *
 * PRECISION CONTRACT, enforced by what is absent:
 *
 *   There is NO camera-PCF uniform in this bind group.
 *
 * DEC-033 rule 1 forbids a shader from adding a planet-centred camera position
 * in f32, because doing so reconstructs a number of magnitude 6.37e6 and
 * immediately quantises it to 0.5 m. Vertex positions arrive ALREADY
 * camera-relative, differenced in f64 on the CPU. Anything a shader needs that
 * would otherwise require a world position — latitude for insolation, say —
 * arrives either as a uniform computed in f64 or as a normalised direction,
 * which is scale-free and therefore safe.
 *
 * Reversed-Z: the projection maps near to 1.0 and infinity to 0.0. Depth is
 * cleared to 0.0 and tested GreaterEqual.
 */

export const PLANET_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj      : mat4x4<f32>,
  // Direction only. A direction is scale-free, so it carries no precision risk.
  sunDirection  : vec4<f32>,
  // x = planet radius, y = camera altitude, z = debug mode, w = time seconds.
  params        : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct PatchInstance {
  // Patch origin, ALREADY CAMERA-RELATIVE (metres). Never a world position.
  originRel : vec4<f32>,
  // Tangent basis scaled to the patch's extent, so the 2-D grid maps onto it.
  tangentU  : vec4<f32>,
  tangentV  : vec4<f32>,
  // x = level, y = morph factor, z = face, w = debug tint key.
  meta      : vec4<f32>,
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
  let radius = u.params.x;

  // Position on the cube face, in camera-relative metres.
  let onFace = p.originRel.xyz
             + p.tangentU.xyz * grid.x
             + p.tangentV.xyz * grid.y;

  // Project onto the sphere. The camera sits at the origin of this space, so
  // the planet centre is at -cameraRel, carried in originRel.w-free form:
  // tangentU.w holds the planet-centre offset along each axis via centreRel.
  let centreRel = vec3<f32>(p.tangentU.w, p.tangentV.w, p.originRel.w);
  let fromCentre = onFace - centreRel;
  let dir = normalize(fromCentre);
  let surface = centreRel + dir * radius;

  var out : VsOut;
  out.clip = u.viewProj * vec4<f32>(surface, 1.0);
  out.normal = dir;
  out.uv = grid;
  out.level = p.meta.x;
  out.viewDepth = length(surface);
  return out;
}

// Distinct hues per LOD level, for the debug overlay. Deterministic, so a level
// always reads as the same colour across frames and across machines.
fn levelColour(level : f32) -> vec3<f32> {
  let h = fract(level * 0.191 + 0.07);
  let k = vec3<f32>(3.0, 2.0, 1.0);
  let p = abs(fract(vec3<f32>(h) + k / 3.0) * 6.0 - 3.0);
  return clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let lambert = max(dot(n, normalize(u.sunDirection.xyz)), 0.0);
  // A little ambient so the night side is legible while there is no atmosphere.
  let lit = 0.06 + 0.94 * lambert;

  let debugMode = u.params.z;
  var albedo = vec3<f32>(0.30, 0.38, 0.46);

  if (debugMode > 0.5 && debugMode < 1.5) {
    albedo = levelColour(in.level);
  }

  // Patch wireframe: a thin border in UV space, for patch-boundary debugging.
  if (debugMode > 1.5) {
    let e = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
    let edge = 1.0 - smoothstep(0.0, 0.012, e);
    albedo = mix(levelColour(in.level) * 0.6, vec3<f32>(1.0, 0.85, 0.2), edge);
  }

  return vec4<f32>(albedo * lit, 1.0);
}
`;
