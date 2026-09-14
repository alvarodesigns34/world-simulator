/**
 * Space and sky background (T-0160).
 *
 * The clear colour behind the planet was a flat near-black, so from orbit the
 * world sat in a void, and standing on the surface the sky above the horizon
 * was that same void. Two different things are missing there and this
 * full-screen pass supplies both.
 *
 * STARS. Generated from the view direction, not sampled from a texture: no
 * asset, no seams, identical from any angle, and deterministic. Deliberately
 * sparse — a few bright stars and many faint ones, which is what a real sky
 * looks like, rather than the dense glitter a game backdrop uses.
 *
 * SKY FROM INSIDE. Below the atmosphere, what is overhead is air: blue at the
 * zenith, pale at the horizon, warm toward a low sun, and dark at night with
 * the stars coming back through. The same pass fades between the two on
 * altitude, so a descent from orbit crosses one continuous boundary.
 *
 * Drawn FIRST with no depth write, so the planet occludes it for free.
 *
 * Nothing here is simulation state. The sun direction it is given is whatever
 * the viewer's lighting mode chose (T-0159).
 */

export const SKY_WGSL = /* wgsl */ `
struct SkyUniforms {
  // xyz camera forward (unit), w tan(fovY / 2)
  forward : vec4<f32>,
  // xyz camera right (unit), w viewport aspect
  right   : vec4<f32>,
  // xyz camera up (unit), w camera altitude in metres
  up      : vec4<f32>,
  // xyz sun direction (unit), w exposure gain
  sun     : vec4<f32>,
  // xyz outward radial at the camera, w = 1 when scientific mode suppresses
  // cinematic colour
  radial  : vec4<f32>,
};

@group(0) @binding(0) var<uniform> s : SkyUniforms;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0)       ndc  : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  // One oversized triangle covering the viewport.
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out : VsOut;
  out.clip = vec4<f32>(p[i], 0.0, 1.0);
  out.ndc = p[i];
  return out;
}

fn hash31(p : vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  q = q + dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}

/**
 * Stars on a cell grid over the view direction. One candidate per cell and
 * most of them below the visibility threshold, so the density reads as a sky
 * rather than as a lattice.
 */
fn starField(dir : vec3<f32>) -> vec2<f32> {
  let scale = 210.0;
  let p = dir * scale;
  let cell = floor(p);
  var total = 0.0;
  var warmth = 0.0;
  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let c = cell + vec3<f32>(f32(dx), f32(dy), f32(dz));
        let r = hash31(c);
        if (r > 0.938) {
          let jitter = vec3<f32>(hash31(c + 11.7), hash31(c + 23.1), hash31(c + 41.3));
          let d = length(p - (c + jitter));
          let mag = pow((r - 0.938) / 0.062, 2.6);
          let point = mag * exp(-d * d * 30.0);
          total = total + point;
          warmth = warmth + point * hash31(c + 7.3);
        }
      }
    }
  }
  let sum = clamp(total, 0.0, 1.5);
  return vec2<f32>(sum, select(0.5, warmth / max(total, 1e-5), total > 1e-5));
}

@fragment
fn fs(frag : VsOut) -> @location(0) vec4<f32> {
  let dir = normalize(
      s.forward.xyz
    + s.right.xyz * (frag.ndc.x * s.forward.w * s.right.w)
    + s.up.xyz * (frag.ndc.y * s.forward.w));

  let sun = normalize(s.sun.xyz);
  let radial = normalize(s.radial.xyz);
  let altitude = s.up.w;

  // How much of the atmosphere is still above the camera. 60 km is where the
  // sky has effectively gone; the exponential keeps the transition smooth
  // through a descent rather than snapping at a threshold.
  let inAir = exp(-max(altitude, 0.0) / 24000.0);

  // Stars, extinguished by any air in front of them.
  let star = starField(dir);
  let starColour = mix(vec3<f32>(0.72, 0.80, 1.0), vec3<f32>(1.0, 0.88, 0.74), star.y);
  var rgb = starColour * star.x * (1.0 - inAir * 0.96) * 0.85;

  // Sky, when there is air to scatter in.
  let sunUp = dot(radial, sun);
  let daylight = smoothstep(-0.22, 0.14, sunUp);
  let elevation = clamp(dot(dir, radial), -1.0, 1.0);
  let towardHorizon = 1.0 - clamp(elevation, 0.0, 1.0);
  let zenith = vec3<f32>(0.13, 0.29, 0.66);
  let horizon = vec3<f32>(0.55, 0.66, 0.82);
  var sky = mix(zenith, horizon, pow(towardHorizon, 2.2));
  // Warm haze toward a low sun: sunrise and sunset, not a uniform orange wash.
  let sunAlign = max(dot(dir, sun), 0.0);
  let lowSun = smoothstep(0.35, -0.08, sunUp);
  sky = mix(sky, vec3<f32>(1.0, 0.58, 0.30), pow(sunAlign, 5.0) * lowSun * 0.7);
  sky = sky * (0.02 + 0.98 * daylight);
  rgb = mix(rgb, sky, inAir);

  // A trace of deep-space light so the void is not exactly zero.
  rgb = rgb + vec3<f32>(0.003, 0.004, 0.009) * (1.0 - inAir);

  rgb = rgb * max(s.sun.w, 0.0001);
  if (s.radial.w < 0.5) {
    rgb = (rgb * (2.51 * rgb + vec3<f32>(0.03))) /
      (rgb * (2.43 * rgb + vec3<f32>(0.59)) + vec3<f32>(0.14));
  } else {
    rgb = rgb / (rgb + vec3<f32>(1.0));
  }
  return vec4<f32>(rgb, 1.0);
}
`;
