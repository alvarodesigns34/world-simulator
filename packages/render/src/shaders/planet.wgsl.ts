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
  // x = exposure gain, y = bloom strength, zw reserved (T-0103).
  post          : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct PatchInstance {
  c00  : vec4<f32>,
  c10  : vec4<f32>,
  c01  : vec4<f32>,
  c11  : vec4<f32>,
  // Corner elevations in metres: x=h00 y=h10 z=h01 w=h11.
  elev : vec4<f32>,
  // vegetation, river, lake, weather+pollution forcing; simulation-derived only.
  surface : vec4<f32>,
  // x = snow cover, y = glacier cover, zw reserved. Both are M5's authoritative
  // snowpack and glacier fields, not a latitude-driven decoration (T-0104).
  cryo : vec4<f32>,
  // x = height page index (-1 = none, fall back to corner heights)
  // y = metres between page samples, for the gradient
  // z = page side (vertices per side + 2)
  // w = patch skirt depth in metres.
  page : vec4<f32>,
};

@group(0) @binding(1) var<storage, read> instances : array<PatchInstance>;
// Two floats per patch vertex, plus a one-sample border (T-0151, T-0154):
// [0] elevation in metres, [1] vegetation/snow/water packed as 3 x 8 bits.
// This is what lets 33x33 vertices express terrain and surface cover instead
// of interpolating four corners and one flat colour per patch.
@group(0) @binding(2) var<storage, read> heights : array<f32>;
const PAGE_STRIDE : i32 = 2;

struct VsOut {
  @builtin(position) clip      : vec4<f32>,
  @location(0)       normal    : vec3<f32>,
  @location(1)       uv        : vec2<f32>,
  @location(2)       level     : f32,
  @location(3)       viewDepth : f32,
  @location(4)       heightM   : f32,
  @location(5)       viewDir   : vec3<f32>,
  @location(6)       surface   : vec4<f32>,
  @location(7)       cryo      : vec4<f32>,
  // Up (radial) at this vertex, kept separate from the shading normal so the
  // fragment stage can tell "which way is up" from "which way does this slope
  // face" — slope is what selects rock over grass.
  @location(8)       up        : vec3<f32>,
  @location(9)       slope     : f32,
  // Per-vertex vegetation, snow and inland water (T-0154). Per-PATCH constants
  // are what made the planet a mosaic of flat rectangles.
  @location(10)      cover     : vec4<f32>,
};

/** A page sample with clamped indices; the border makes clamping rare. */
fn pageAt(base : i32, side : i32, ix : i32, iy : i32) -> f32 {
  let cx = clamp(ix, 0, side - 1);
  let cy = clamp(iy, 0, side - 1);
  return heights[base + (cy * side + cx) * PAGE_STRIDE];
}

/** Unpack vegetation, snow cover, inland water and weather haze (6 bits each). */
fn materialAt(base : i32, side : i32, ix : i32, iy : i32) -> vec4<f32> {
  let cx = clamp(ix, 0, side - 1);
  let cy = clamp(iy, 0, side - 1);
  let packed = heights[base + (cy * side + cx) * PAGE_STRIDE + 1];
  let veg = floor(packed / 262144.0);
  let r1 = packed - veg * 262144.0;
  let snow = floor(r1 / 4096.0);
  let r2 = r1 - snow * 4096.0;
  let water = floor(r2 / 64.0);
  let weather = r2 - water * 64.0;
  return vec4<f32>(veg, snow, water, weather) / 63.0;
}

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

  //
  // The patch tangents and the outward radial.
  //
  // The tangents are DIFFERENCES of camera-relative corners, so the camera
  // cancels exactly and they are the true surface tangents.
  //
  // The radial is NOT their cross product. That is the normal of the patch's
  // bilinear QUAD, which is constant-ish across a patch and discontinuous at
  // its border, and using it drew the planet as a faceted quilt — every patch
  // a slightly different shade of the same ocean. The true radial is
  // normalize(B + C), and it is continuous everywhere by construction.
  //
  // DEC-033 forbids reconstructing a planet-centred POSITION in f32 because a
  // 0.5 m ulp at Earth radius moves geometry. This is a DIRECTION: the same
  // 0.5 m is a 1e-7 relative error on a 6.4e6 m vector, it is normalised
  // immediately, and no vertex position depends on it.
  //
  let ddu = mix(p.c10.xyz - p.c00.xyz, p.c11.xyz - p.c01.xyz, t);
  let ddv = mix(p.c01.xyz - p.c00.xyz, p.c11.xyz - p.c10.xyz, s);
  let upDir = normalize(B + C);

  //
  // HEIGHT. The page carries one elevation per vertex (T-0151). The vertex
  // lands exactly on a page sample — the grid parameter IS i/(n-1) — so this
  // is a direct read, not a filtered one, and adjacent patches at the same
  // level read the same global sample on their shared edge, which is what
  // keeps the seam closed.
  //
  let pageIndex = i32(p.page.x);
  let side = i32(p.page.z);
  let n = side - 2;
  let ix = i32(round(s * f32(n - 1)));
  let iy = i32(round(t * f32(n - 1)));
  var h : f32;
  var slopeVec = vec2<f32>(0.0, 0.0);
  var cover = vec4<f32>(p.surface.x, max(p.cryo.x, p.cryo.y),
    max(p.surface.y, p.surface.z), p.surface.w);
  if (pageIndex >= 0) {
    let base = pageIndex * side * side * PAGE_STRIDE;
    h = pageAt(base, side, ix + 1, iy + 1);
    // Central difference over the border ring: correct at the patch edge too,
    // which is the whole reason the page carries a border.
    let spacing = max(p.page.y, 0.001);
    let hL = pageAt(base, side, ix, iy + 1);
    let hR = pageAt(base, side, ix + 2, iy + 1);
    let hD = pageAt(base, side, ix + 1, iy);
    let hU = pageAt(base, side, ix + 1, iy + 2);
    slopeVec = vec2<f32>((hR - hL) / (2.0 * spacing), (hU - hD) / (2.0 * spacing));
    //
    // RELIEF SHADING EXAGGERATION (T-0161), applied to the NORMAL only.
    //
    // Measured on this world's own L8 grid, the ninetieth percentile of land
    // gradient is 0.006 and the ninety-ninth is 0.038. A normal tilted by
    // 0.006 changes Lambert shading by well under one part in a hundred, so a
    // continental margin that really is there is invisible — the planet looks
    // like a painted ball because its relief is below the threshold of the
    // lighting, not because the relief is absent.
    //
    // Every relief map ever printed solves this the same way, and so does
    // this: the SHADING normal is tilted more than the surface is. No vertex
    // moves, so silhouettes, horizons, collision and every measurement stay at
    // true scale; only the light is amplified. post.w carries the factor so it
    // can be turned off, and scientific mode does turn it off.
    //
    slopeVec = slopeVec * max(u.post.w, 0.0);
    cover = materialAt(base, side, ix + 1, iy + 1);
  } else {
    // One frame of fallback while the page bakes. The old four-corner blend.
    h = mix(mix(p.elev.x, p.elev.y, s), mix(p.elev.z, p.elev.w, s), t);
  }

  // Skirt: the outermost ring of the grid is pushed DOWN along the radius so a
  // level difference across a patch boundary shows a hidden vertical wall
  // rather than a hole (T-0152). It costs one ring of vertices and no CPU.
  let edge = min(min(s, 1.0 - s), min(t, 1.0 - t));
  let onSkirt = select(0.0, 1.0, edge < 0.5 / f32(n - 1));
  let hDraw = h - onSkirt * p.page.w;

  sph = sph * (1.0 + hDraw / R) + C * (hDraw / R);

  // SHADING NORMAL FROM THE TERRAIN, not from the sphere (T-0151). Rotating
  // the up vector by the height gradient in the patch's own tangent frame is
  // what makes a ridge read as a ridge: before this the normal was the sphere's
  // and a mountain was a brown smudge with no light on its flanks.
  let tu = normalize(ddu);
  let tv = normalize(ddv);
  var n3 = normalize(upDir - tu * slopeVec.x - tv * slopeVec.y);
  if (pageIndex < 0) { n3 = upDir; }

  var vsOut : VsOut;
  vsOut.clip = u.viewProj * vec4<f32>(sph, 1.0);
  vsOut.normal = n3;
  vsOut.uv = grid;
  vsOut.level = p.c00.w;
  vsOut.viewDepth = length(sph);
  vsOut.heightM = h;
  vsOut.viewDir = sph;
  vsOut.surface = p.surface;
  vsOut.cryo = p.cryo;
  vsOut.up = upDir;
  vsOut.slope = clamp(length(slopeVec), 0.0, 8.0);
  vsOut.cover = cover;
  return vsOut;
}

fn levelColour(level : f32) -> vec3<f32> {
  let h = fract(level * 0.191 + 0.07);
  let k = vec3<f32>(3.0, 2.0, 1.0);
  let q = abs(fract(vec3<f32>(h) + k / 3.0) * 6.0 - 3.0);
  return clamp(q - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
}

/** Kept for the scientific height debug mode: a legible, unlit ramp. */
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

/** Cheap deterministic value noise on a position, for render-only microdetail. */
fn hash3(p : vec3<f32>) -> f32 {
  let q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3));
  let r = q * 17.0 * (q + vec3<f32>(dot(q, q.yzx + vec3<f32>(19.19))));
  return fract(r.x * r.y * r.z);
}

fn valueNoise(p : vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash3(i + vec3<f32>(0.0, 0.0, 0.0));
  let n100 = hash3(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = hash3(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = hash3(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = hash3(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = hash3(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = hash3(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = hash3(i + vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

//
// TERRAIN MATERIAL (T-0155).
//
// What this replaces: a four-stop hypsometric ramp keyed on altitude alone.
// Height by itself cannot tell a desert from a grassland, a cliff from a
// meadow, or a glacier from a snowfield, so every world looked like the same
// green-to-brown gradient wrapped on a ball.
//
// Every input here is SIMULATED and arrives per vertex (T-0154):
//   cover.x  M6 vegetation density
//   cover.y  M5 snowpack and glacier cover
//   cover.z  M5 river and lake water
//   slope    the gradient of M2/M3's own elevation field
//   height   that elevation
//
// The only render-only part is microvariation: a deterministic noise that
// breaks up large uniform areas and fades out with distance. It changes no
// landform and carries no information — it is there because real ground is
// never one flat colour, and a surface that is makes a planet look painted.
//
fn terrainMaterial(
  height : f32, sl : f32, slope : f32, cover : vec4<f32>,
  worldDir : vec3<f32>, detail : f32,
) -> vec3<f32> {
  // Rock as a function of steepness: a slope steeper than about 25 degrees
  // sheds soil, which is why mountain faces are bare and their shoulders are
  // not. This is the single strongest cue that a mountain is a mountain.
  let steep = smoothstep(0.25, 0.75, slope);

  let sand    = vec3<f32>(0.68, 0.60, 0.44);
  let steppe  = vec3<f32>(0.47, 0.45, 0.28);
  let grass   = vec3<f32>(0.24, 0.35, 0.16);
  let forest  = vec3<f32>(0.12, 0.23, 0.11);
  let rockLow = vec3<f32>(0.38, 0.35, 0.31);
  let rockHi  = vec3<f32>(0.46, 0.44, 0.42);
  let snowCol = vec3<f32>(0.86, 0.89, 0.93);


  //
  // Microvariation, computed FIRST because it also perturbs the boundaries.
  //
  // M6's vegetation and M5's water live on a cube grid whose cells are tens of
  // kilometres across. Interpolating them bilinearly and then thresholding
  // draws the grid: soft-cornered rectangles of forest against grass, with
  // visible right angles no landscape has. Perturbing the CLASSIFICATION by
  // the same noise that varies the colour makes the boundary follow terrain
  // texture instead of the raster, which changes no value and no area — the
  // vegetation fraction at a point is still M6's — but stops the ecotone
  // looking like a spreadsheet.
  //
  let f1 = 6371000.0 / 260.0;
  let f2 = 6371000.0 / 32.0;
  let f3 = 6371000.0 / 5400.0;
  let n = valueNoise(worldDir * f1) * 0.62 + valueNoise(worldDir * f2) * 0.38;
  let edgeNoise = (valueNoise(worldDir * f3) - 0.5) * 2.0;

  // Vegetation ladder. Bare ground -> sparse -> grass -> closed canopy, with
  // the dry end tinted by how little vegetation there is rather than by an
  // invented climate zone.
  let veg = clamp(cover.x + edgeNoise * 0.16, 0.0, 1.0);
  var ground = mix(sand, steppe, smoothstep(0.02, 0.22, veg));
  ground = mix(ground, grass, smoothstep(0.18, 0.5, veg));
  ground = mix(ground, forest, smoothstep(0.45, 0.85, veg));

  //
  // NO ABSOLUTE-ALTITUDE TERM. The first version greyed the ground toward rock
  // above 1.2 km "above sea level", which is an Earth habit and wrong here:
  // this world's sea level sits at -3421 m, so its entire land surface is
  // 4-5 km "high" by that arithmetic and every continent rendered as bare
  // alpine rock — slate blue-grey from pole to pole, on ground the biosphere
  // reports as fully vegetated.
  //
  // What makes high ground look high is not its number. It is that it is cold
  // (M5's snowpack says so), steep (the gradient says so) and bare (M6's
  // vegetation says so). All three are simulated, all three are already here,
  // and using them instead means the material is right on any world rather
  // than on one with Earth's hypsometry.
  //
  let rock = mix(rockLow, rockHi, clamp(cover.y * 0.5 + steep * 0.5, 0.0, 1.0));
  var albedo = mix(ground, rock, steep);

  // Colour microvariation. In METRES, not in radians: scaling the unit
  // direction by a few hundred gives a wavelength of thousands of kilometres,
  // and across a 2.5 km close-up the noise did not complete one cycle — the
  // ground was one flat colour. It carries no information and fades with
  // distance so it never shimmers from orbit.
  albedo = albedo * (1.0 + (n - 0.5) * 0.34 * detail);

  // Snow and ice last: they cover what is underneath. Snow clings less to a
  // steep face, which is why a ridge shows rock through white.
  let snow = clamp(cover.y + edgeNoise * 0.12, 0.0, 1.0) * (1.0 - steep * 0.65);
  albedo = mix(albedo, snowCol, smoothstep(0.02, 0.6, snow));

  // Rivers and lakes read as water, darker and flatter than the ground.
  let water = clamp(cover.z + edgeNoise * 0.06, 0.0, 1.0);
  albedo = mix(albedo, vec3<f32>(0.05, 0.16, 0.26), smoothstep(0.08, 0.6, water));

  return albedo;
}

@fragment
fn fs(frag : VsOut) -> @location(0) vec4<f32> {
  let n = normalize(frag.normal);
  let up = normalize(frag.up);
  let sun = normalize(u.sunDirection.xyz);
  let sl = u.params.w;
  let debugMode = u.params.z;
  let alt = u.params.y;
  let viewDir = normalize(frag.viewDir);
  let worldDir = up;

  // How lit the GROUND is, and how high the sun stands over this point. The
  // two differ on a slope, and keeping them apart is what lets a valley floor
  // be in shadow while the sky above it is still bright.
  let lambert = max(dot(n, sun), 0.0);
  let sunUp = dot(up, sun);

  // Detail fades with distance so microvariation never shimmers from orbit.
  let detail = 1.0 - smoothstep(4000.0, 120000.0, frag.viewDepth);

  let underwater = frag.heightM < sl;
  var albedo = terrainMaterial(frag.heightM, sl, frag.slope, frag.cover, worldDir, detail);
  var specular = 0.0;
  var wetness = 0.0;

  if (underwater) {
    //
    // OCEAN (T-0156).
    //
    // Water was previously the seabed painted blue, which is why it had no
    // surface: no glint, no Fresnel worth the name, no change with depth, and
    // an ocean that looked like flat paper from every angle.
    //
    // This shades the sea SURFACE at sea level. Depth drives absorption —
    // shallow water over a shelf keeps some of the bottom's brightness and
    // turns green-blue, deep water swallows everything but blue. Fresnel
    // brightens the grazing angle, which is what makes an ocean read as a
    // surface rather than a colour, and a specular lobe gives the sun its
    // glint. The waves are render-only: a gradient perturbation of the normal,
    // never simulation state.
    //
    let depth = max(sl - frag.heightM, 0.0);
    let shallow = vec3<f32>(0.11, 0.38, 0.42);
    let deep = vec3<f32>(0.020, 0.075, 0.185);
    var water = mix(shallow, deep, clamp(depth / 1400.0, 0.0, 1.0));

    // Small render-only surface chop, strongest when close.
    let chop = 1.0 - smoothstep(2000.0, 180000.0, frag.viewDepth);
    let w1 = valueNoise(worldDir * 22000.0 + vec3<f32>(u.post.z * 0.7));
    let w2 = valueNoise(worldDir * 61000.0 - vec3<f32>(u.post.z * 1.3));
    let ripple = (w1 - 0.5) * 0.020 + (w2 - 0.5) * 0.011;
    let tangentA = normalize(cross(up, vec3<f32>(0.0, 0.0, 1.0) + up * 0.001));
    let tangentB = cross(up, tangentA);
    let wn = normalize(up + (tangentA * ripple + tangentB * ripple * 0.8) * chop * 26.0);

    let cosView = clamp(dot(wn, -viewDir), 0.0, 1.0);
    let fres = 0.02 + 0.98 * pow(1.0 - cosView, 5.0);
    let sky = vec3<f32>(0.26, 0.44, 0.72);
    water = mix(water, sky, fres * 0.85);

    // Sun glint. A tight lobe, widened a little by the chop.
    // A broad glint, not a point. A tight lobe on a flat surface draws one
    // white dot in the middle of an ocean, which reads as a bug rather than as
    // sunlight; real sea scatters the sun over a wide sheen because it is
    // rough at every scale.
    let halfV = normalize(sun - viewDir);
    let gloss = mix(220.0, 42.0, chop);
    specular = pow(max(dot(wn, halfV), 0.0), gloss) * max(sunUp, 0.0) * 0.85;

    albedo = water;
    wetness = 1.0;
  }

  if (debugMode > 0.5 && debugMode < 1.5) { albedo = levelColour(frag.level); }
  if (debugMode > 1.5 && debugMode < 2.5) {
    let e = min(min(frag.uv.x, 1.0 - frag.uv.x), min(frag.uv.y, 1.0 - frag.uv.y));
    let edge = 1.0 - smoothstep(0.0, 0.012, e);
    albedo = mix(levelColour(frag.level) * 0.6, vec3<f32>(1.0, 0.85, 0.2), edge);
  }
  if (debugMode > 2.5) { albedo = hypsometric(frag.heightM, sl); }

  //
  // LIGHTING.
  //
  // Direct sun, a sky term that comes from above rather than from everywhere,
  // and a weak bounce from the ground. The sky term is what stops a shadowed
  // slope going to pure black, and it is tinted by the same atmosphere colour
  // the limb uses so the two agree.
  //
  //
  // IRRADIANCE, not a 0..1 fudge.
  //
  // Sunlight was scaled to peak at 1.0, so a forest — albedo 0.15 — could
  // never exceed 0.15 before tone mapping and rendered near black in broad
  // daylight. The sun is roughly six times brighter than the value that
  // produces middle grey off a mid-albedo surface; with the filmic curve at
  // the end, giving it its real relative strength is what makes daylight look
  // like daylight instead of dusk.
  //
  let sunIrradiance = 3.1;
  let skyColour = vec3<f32>(0.24, 0.40, 0.72);
  let sunColour = mix(vec3<f32>(1.0, 0.52, 0.22), vec3<f32>(1.0, 0.96, 0.90),
    smoothstep(-0.05, 0.35, sunUp)) * sunIrradiance;
  let daylight = smoothstep(-0.18, 0.12, sunUp);
  //
  // Sky ambient is a TENTH of the sun, not half of it.
  //
  // At 1.05 the blue sky term was comparable to direct sunlight, so every
  // surface came out the average of its own colour and the sky's: a forest
  // rendered pale teal, a desert rendered pale teal, and the whole planet lost
  // its material identity. On a clear day the sky contributes on the order of
  // 10-15% of the illumination on a horizontal surface. Keeping it there is
  // what lets an albedo be seen.
  //
  let skyLight = skyColour * (0.035 + 0.34 * max(sunUp, 0.0)) * (0.55 + 0.45 * dot(n, up));
  let bounce = vec3<f32>(0.24, 0.22, 0.18) * max(sunUp, 0.0) * 0.16 * (1.0 - max(dot(n, up), 0.0));
  var rgb = albedo * (sunColour * lambert + skyLight + bounce) + sunColour * specular;

  //
  // Simulated weather and pollution haze, from M4 runoff and M10 pollution.
  //
  // Held to a tenth rather than a quarter. At full strength it was the single
  // largest term in the surface colour of a wet world: continents came out
  // pastel grey-cyan whatever their vegetation, and the boundaries between
  // runoff cells drew visible bands across the ground. Weather should tint a
  // landscape, not replace it.
  //
  let weatherHaze = clamp(frag.cover.w, 0.0, 1.0);
  rgb = mix(rgb, vec3<f32>(0.62, 0.66, 0.70) * (0.10 + daylight * 0.85),
    weatherHaze * weatherHaze * 0.10);

  //
  // AERIAL PERSPECTIVE AND THE LIMB (T-0157).
  //
  // Two regimes, one expression. Looking DOWN through the air, distance adds
  // scattered light and washes contrast — that is why a far ridge is paler and
  // bluer than a near one, and without it every altitude looked equally sharp
  // and equally flat. Looking at the planet from OUTSIDE, the same integral
  // taken along a grazing ray is the bright rim of atmosphere on the limb.
  //
  // Rayleigh is wavelength-weighted so it goes blue overhead and red at a
  // grazing sun, which is what makes a terminator read as sunrise instead of
  // as a grey band.
  //
  let rayleigh = vec3<f32>(0.23, 0.44, 1.00);
  let scaleH = 8500.0;
  let airDensity = exp(-max(alt, 0.0) / scaleH);

  //
  // AIR MASS, not path length.
  //
  // The first version used distance alone, so from 12,000 km every pixel of
  // the disc had a path of 12,000 "haze units" and the whole planet washed
  // out to flat blue. What matters is how much ATMOSPHERE the ray crosses,
  // and above the atmosphere that is bounded by the vertical column divided
  // by the cosine of the view zenith — one column looking straight down,
  // many at the limb. Expressed in columns, so 1.0 means "one atmosphere".
  //
  let meanDensity = 0.5 * (airDensity + 1.0);
  let cosZenith = max(abs(dot(up, viewDir)), 0.04);
  let columns = min(frag.viewDepth * meanDensity, scaleH / cosZenith) / scaleH;
  // 0.13 per vertical column: Rayleigh's optical depth in the visible is about
  // 0.1, and the first value (0.55) washed the whole disc to flat blue from
  // orbit — an atmosphere you cannot see through is not an atmosphere.
  let inScatter = 1.0 - exp(-columns * 0.13);
  let grazing = 1.0 - abs(dot(up, -viewDir));
  let limb = pow(clamp(grazing, 0.0, 1.0), 3.0) * (1.0 - airDensity);

  let sunset = smoothstep(0.30, -0.10, sunUp);
  let airColour = mix(rayleigh, vec3<f32>(1.0, 0.45, 0.20), sunset * 0.8);
  let airLit = airColour * (0.12 + 1.35 * smoothstep(-0.30, 0.25, sunUp));

  rgb = mix(rgb, airLit * 0.75, clamp(inScatter, 0.0, 0.92));
  rgb = rgb + airLit * limb * 0.85;

  // The night side keeps a trace of airglow rather than clipping to black.
  let night = 1.0 - daylight;
  rgb = rgb + vec3<f32>(0.006, 0.010, 0.020) * night;

  if (u.sunDirection.w > 0.5 && debugMode < 0.5) {
    rgb = rgb * max(u.post.x, 0.0001);
    let bloom = max(rgb - vec3<f32>(0.72), vec3<f32>(0.0));
    rgb = rgb + bloom * u.post.y;
    rgb = (rgb * (2.51 * rgb + vec3<f32>(0.03))) /
      (rgb * (2.43 * rgb + vec3<f32>(0.59)) + vec3<f32>(0.14));
  } else {
    rgb = rgb * max(u.post.x, 0.0001);
    rgb = rgb / (rgb + vec3<f32>(1.0));
  }
  return vec4<f32>(rgb, 1.0);
}
`;
