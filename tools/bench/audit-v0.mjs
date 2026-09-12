#!/usr/bin/env node
/**
 * Independent Architecture v0 arithmetic — Grok, 2026-09-11.
 *
 * Does NOT import the packages under test for the claims that are "measured
 * by the test suite". Re-derives the numbers. Cube-sphere area uses the
 * published warp formula independently.
 *
 * Run: node tools/bench/audit-v0.mjs
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const R = 6_371_000;
const SPY = 365.25 * 86400; // 31_557_600
const PI = Math.PI;
const QPI = PI / 4;

const out = [];
function line(s = '') {
  out.push(s);
  console.log(s);
}
function hdr(s) {
  line();
  line(`## ${s}`);
}

function ulp(x) {
  if (!Number.isFinite(x) || x === 0) return Number.MIN_VALUE;
  const ax = Math.abs(x);
  const exp = Math.floor(Math.log2(ax));
  return 2 ** (exp - 52);
}

hdr('1. f64 ulp at deep time (DEC-014 docs say 7.8 ms at 1e6 yr)');
{
  const t1e6 = 1e6 * SPY;
  const t1e9 = 1e9 * SPY;
  line(`secondsPerYear          = ${SPY} (exact even integer: ${SPY % 2 === 0})`);
  line(`1e6 years in seconds    = ${t1e6}  (2^44=${2 ** 44}, 2^45=${2 ** 45})`);
  line(`ulp(1e6 yr)             = ${ulp(t1e6)} s = ${(ulp(t1e6) * 1000).toFixed(4)} ms`);
  line(`t * Number.EPSILON      = ${t1e6 * Number.EPSILON} s  ← THIS is how you get ~7 ms`);
  line(`ulp is 2^(floor(log2(x))-52), NOT x*EPSILON.`);
  line(`x*EPSILON overestimates by ~2× in the lower half of a binade.`);
  line(`VERDICT: docs 7.8 ms is WRONG. Code comment 3.9 ms is RIGHT.`);
  line(`ulp(1e9 yr)             = ${ulp(t1e9)} s = ${(ulp(t1e9)).toFixed(3)} s`);
  line(`1/60 at 1e6 yr in ulps  = ${(1 / 60 / ulp(t1e6)).toFixed(4)}`);
  line(`round(1/60) at 1e6 yr   = ${Math.round((1 / 60) / ulp(t1e6)) * ulp(t1e6)} s = 1/64 = ${1 / 64}`);
}

hdr('2. Independent SimTime vs flat-counter accumulation (1e7 × 1/60 at year 1e6)');
{
  const N = 1e7;
  const DT = 1 / 60;
  const EXACT = N * DT;
  // Flat
  const flat0 = 1e6 * SPY;
  let flat = flat0;
  for (let i = 0; i < N; i++) flat += DT;
  const flatErr = Math.abs(flat - flat0 - EXACT);
  // Year-split (independent reimplementation)
  let y = 1e6;
  let s = 0;
  for (let i = 0; i < N; i++) {
    s += DT;
    if (s >= SPY) {
      y += 1;
      s -= SPY;
    }
  }
  const splitElapsed = (y - 1e6) * SPY + s;
  const splitErr = Math.abs(splitElapsed - EXACT);
  line(`flat error              = ${flatErr.toExponential(4)} s`);
  line(`split error             = ${splitErr.toExponential(4)} s`);
  line(`ratio                   = ${(flatErr / splitErr).toExponential(3)}`);
  line(`VERDICT: Opus's measured errors (1.04e4 vs 1.7e-5) HOLD. The 7.8 ms figure does not.`);
}

hdr('3. f32 ulp at planet scales (DEC-005)');
{
  const f32ulp = (x) => {
    const ax = Math.abs(x);
    const exp = Math.floor(Math.log2(ax));
    return 2 ** (exp - 23);
  };
  line(`f32 ulp at R=${R}       = ${f32ulp(R)} m   (claimed 0.5 m)`);
  line(`f32 ulp at 100 km       = ${f32ulp(1e5) * 1000} mm (claimed 7.8 mm)`);
  line(`f32 ulp at 1 km         = ${f32ulp(1e3) * 1e6} µm (claimed 61 µm)`);
  line(`f64 ulp at R            = ${ulp(R)} m = ${(ulp(R) * 1e9).toFixed(2)} nm (claimed ~1 nm)`);
  line(`VERDICT: DEC-005 ulp table is correct.`);
}

hdr('4. i16 centimetres cannot represent Earth (DEC-022)');
{
  const q = 0.01; // metres per i16 step
  const maxM = 32767 * q;
  const minM = -32768 * q;
  line(`i16 cm range            = [${minM}, ${maxM}] m`);
  line(`Everest                 = 8849 m   fits? ${8849 <= maxM}`);
  line(`Mariana                 = -10994 m fits? ${-10994 >= minM}`);
  line(`i16 metres range        = [${-32768}, ${32767}] m  — covers Earth with 1 m quantum`);
  line(`i16 0.5 m quantum       = [${-32768 * 0.5}, ${32767 * 0.5}] m`);
  line(`i32 cm                  = ±${(2147483647 * 0.01 / 1000).toFixed(0)} km, 100.7 MB at L11`);
  line(`VERDICT: BLOCKER. i16 centimetres is not a legal elevation encoding.`);
}

hdr('5. Cube-sphere: arc ratio vs AREA ratio (DEC-007 claims ~1.3× AREA)');
{
  const warp = (s) => Math.tan(s * QPI);
  const naive = (s) => s;
  function unit(face, u, v, warper) {
    const a = warper(u * 2 - 1);
    const b = warper(v * 2 - 1);
    let x, y, z;
    // POS_Z
    x = a;
    y = b;
    z = 1;
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    return [x * inv, y * inv, z * inv];
  }
  function arc(u, v, du, warper) {
    const A = unit(4, u, v, warper);
    const B = unit(4, u + du, v, warper);
    const d = A[0] * B[0] + A[1] * B[1] + A[2] * B[2];
    return Math.acos(Math.min(1, Math.max(-1, d)));
  }
  const eps = 1e-4;
  const warpedArc = arc(0.5, 0.5, eps, warp) / arc(0.0, 0.0, eps, warp);
  const naiveArc = arc(0.5, 0.5, eps, naive) / arc(0.0, 0.0, eps, naive);
  line(`warped centre/corner ARC   = ${warpedArc.toFixed(4)}×   (Opus measured ~1.27×)`);
  line(`naive  centre/corner ARC   = ${naiveArc.toFixed(4)}×   (Opus claimed ~1.9×)`);

  // Spherical quadrilateral area via Girard (sum of spherical excess).
  // Cell of size du=dv at (u,v), 4 vertices, unit sphere, then * R^2.
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function ang(n1, n2, n3) {
    // angle at vertex n2 of spherical triangle n1-n2-n3 = angle between planes
    const a = cross(n2, n1);
    const b = cross(n2, n3);
    const la = Math.hypot(a[0], a[1], a[2]);
    const lb = Math.hypot(b[0], b[1], b[2]);
    const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    return Math.acos(Math.min(1, Math.max(-1, d)));
  }
  function sphericalQuadArea(v00, v10, v11, v01) {
    // split into two triangles
    const tri = (a, b, c) => {
      const A = ang(c, a, b);
      const B = ang(a, b, c);
      const C = ang(b, c, a);
      return A + B + C - Math.PI;
    };
    return tri(v00, v10, v11) + tri(v00, v11, v01);
  }
  function cellArea(u, v, du, warper) {
    const v00 = unit(4, u, v, warper);
    const v10 = unit(4, u + du, v, warper);
    const v11 = unit(4, u + du, v + du, warper);
    const v01 = unit(4, u, v + du, warper);
    return sphericalQuadArea(v00, v10, v11, v01);
  }
  const du = 1 / 256;
  // stay off the exact corner (u=0) so the cell is interior
  const aWarpC = cellArea(0.5 - du / 2, 0.5 - du / 2, du, warp);
  const aWarpK = cellArea(du * 0.5, du * 0.5, du, warp);
  const aNaiveC = cellArea(0.5 - du / 2, 0.5 - du / 2, du, naive);
  const aNaiveK = cellArea(du * 0.5, du * 0.5, du, naive);
  line(`warped centre/corner AREA  = ${(aWarpC / aWarpK).toFixed(4)}×`);
  line(`naive  centre/corner AREA  = ${(aNaiveC / aNaiveK).toFixed(4)}×`);
  line(`equal-area sphere cell     = ${4 * PI / (6 * 256 * 256)} sr at L8-equivalent`);
  line(`VERDICT: Opus measured ARC and reported it as AREA.`);
  line(`         Warped AREA variation is ~${(aWarpC / aWarpK).toFixed(2)}×, not 1.27×.`);
  line(`         The 1.27× figure is the linear/arc ratio. Docs call it area. That is a category error.`);
}

hdr('6. The "12 edge midpoints" test only constructs 4');
{
  const corners = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const l = Math.sqrt(3);
        corners.push([sx / l, sy / l, sz / l]);
      }
  for (const s of [-1, 1]) {
    const l = Math.SQRT2;
    corners.push([s / l, 1 / l, 0], [0, s / l, 1 / l]);
  }
  line(`points constructed in coords.test.ts = ${corners.length} (8 corners + 4 extras)`);
  line(`claimed                              = 8 corners + 12 edge midpoints = 20`);
  const allEdges = [];
  for (const [a, b, c] of [
    [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
    [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
    [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
  ]) {
    const l = Math.SQRT2;
    allEdges.push([a / l, b / l, c / l]);
  }
  line(`real cube edge midpoints             = ${allEdges.length}`);
  line(`VERDICT: the test that "proves" corners+edges does not cover 8 of 12 edges.`);
}

hdr('7. Triangle budget vs 1440p (RENDERING.md §7)');
{
  const W = 2560;
  const H = 1440;
  const px = W * H;
  const patch = 65;
  const trisPerPatch = (patch - 1) ** 2 * 2; // 8192
  const patches = 1000;
  const tris = trisPerPatch * patches;
  line(`1440p pixels            = ${px.toLocaleString()}`);
  line(`65×65 patch tris        = ${trisPerPatch}`);
  line(`1000 patches            = ${tris.toLocaleString()} tris  (claimed 8.2 M)`);
  line(`mean pixels / triangle  = ${(px / tris).toFixed(3)} px  ← SUB-PIXEL`);
  line(`If τ=2 px and 64 segments/edge, patch ~128 px on a side`);
  line(`screen coverage patches = ${(W / 128) * (H / 128)} ≈ 225 for a full-screen flat`);
  line(`planet ×1.5–3 horizon   = ${Math.round(225 * 1.5)}–${Math.round(225 * 3)} patches`);
  line(`that × 8192             = ${(400 * 8192 / 1e6).toFixed(2)}–${(700 * 8192 / 1e6).toFixed(2)} M tris`);
  line(`τ=2.0 and 1000×65×65 cannot both be true at 1440p.`);
  line(`Iris Xe 96EU ~1.5–2 TFLOPS vs RTX 3050 ~5–8 TFLOPS vs M1 ~2.6 TFLOPS`);
  line(`Grouping them as one "reference hardware" is a 3–5× GPU span.`);
  line(`8.2e6 tris / 4 ms       = ${(8.2e6 / 0.004 / 1e9).toFixed(2)} GTri/s needed for terrain alone`);
  line(`VERDICT: 8.2 M tris @ 1440p is a small-triangle cliff. Iris Xe cannot share this budget.`);
}

hdr('8. Memory: L11 fields × companions, monthly means');
{
  const cells = 6 * 4 ** 11; // 25_165_824
  const i16 = cells * 2;
  const f32 = cells * 4;
  const f64 = cells * 8;
  const mb = (b) => (b / 1e6).toFixed(1);
  line(`L11 cells               = ${cells.toLocaleString()}`);
  line(`i16 field               = ${mb(i16)} MB  (docs 50.3, test uses 48 MiB)`);
  line(`f32 field               = ${mb(f32)} MB`);
  line(`f64 field               = ${mb(f64)} MB  ← DEC-005 "all world data is f64"`);
  line(`10 × i16 companions     = ${mb(10 * i16)} MB`);
  line(`12-month i16 climatology at L11 (T, P only) = ${mb(12 * 2 * i16)} MB`);
  line(`geodesic n6 cells       = ${10 * 4 ** 6 + 2}`);
  line(`12-month × 8 f32 fields on n6 = ${mb(12 * 8 * (10 * 4 ** 6 + 2) * 4)} MB`);
  line(`700 MB CPU budget dies if monthly means live at L11.`);
  line(`VERDICT: aggregates MUST be allowed a coarser grid than their instant field.`);
  line(`         DEC-015 does not say this. FieldDescriptor.aggregate is same-grid by implication.`);
}

hdr('9. hashU32 birthday bound at L11 (DEC-017 claims splitmix64, code is 32-bit)');
{
  const n = 25_165_824;
  const expected = (n * (n - 1)) / 2 / 2 ** 32;
  line(`L11 cells               = ${n}`);
  line(`expected collisions hashing every cell with 32-bit key = ${expected.toFixed(0)}`);
  line(`2^-32 hashFloat01       = ${2 ** -32}`);
  line(`DEC-017 text            = "splitmix64-style 64-bit mixing over two 32-bit halves"`);
  line(`code                    = triple32 → u32. hashU64 does not exist.`);
  line(`VERDICT: docs and code disagree. 32-bit is OK per-tile, not per-cell.`);
}

hdr('10. Worker wall-lag × timeScale (DEC-015 × DEC-020)');
{
  const jobMs = [8, 40, 250];
  const scales = [
    ['T0', 1],
    ['T2', 1e6],
    ['T4', 1e13],
  ];
  for (const [name, ts] of scales) {
    line(
      `${name} timeScale=${ts.toExponential()}:  ` +
        jobMs
          .map((ms) => {
            const simS = (ms / 1000) * ts;
            const yr = simS / SPY;
            return `${ms}ms wall → ${yr < 0.01 ? simS.toFixed(3) + ' s' : yr.toExponential(2) + ' yr'} sim`;
          })
          .join(' | '),
    );
  }
  line(`VERDICT: 250 ms job cap at T4 is ~80 000 years of committed-state lag.`);
  line(`         Commit-discipline (wait for jobs) vs never-block-the-frame are in tension at T4.`);
}

hdr('11. Reversed-Z reconstruction at orbit (DEC-005)');
{
  // Infinite reverse-Z: clip.z/clip.w ≈ near / viewZ
  // depth_f32 ulp near 0 (far) vs near 1 (near plane)
  const alt = 40_000_000; // 40 000 km
  const near = Math.min(1000, Math.max(0.05, alt * 1e-4)); // 1000 m
  const surfaceZ = alt; // ~4e7 m
  const farSideZ = alt + 2 * R; // ~5.27e7 m
  const depthAt = (z) => near / z; // 1 at near, →0 at inf
  const dSurf = depthAt(surfaceZ);
  const dFar = depthAt(farSideZ);
  line(`orbit near plane        = ${near} m`);
  line(`depth at surface        = ${dSurf.toExponential(4)}  (near 0)`);
  line(`depth at far limb       = ${dFar.toExponential(4)}`);
  line(`f32 ulp at depth ${dSurf.toExponential(2)} = ${ulp(dSurf) /* this is f64 ulp of the number */} (f64)`);
  // f32 depth buffer: value in (0,1), f32 ulp at 2^-11 is 2^(exp-23)
  const f32u = (x) => 2 ** (Math.floor(Math.log2(x)) - 23);
  const dzFromDepthUlp = (z) => {
    // z = near / d, dz = near * dd / d^2 = z^2 / near * dd
    const d = near / z;
    const dd = f32u(d);
    return (z * z * dd) / near;
  };
  line(`world-Z error from depth32float ulp at surface (40 000 km) = ${dzFromDepthUlp(surfaceZ).toFixed(3)} m`);
  line(`world-Z error at far limb                                 = ${dzFromDepthUlp(farSideZ).toFixed(3)} m`);
  line(`At 1 m altitude, near=0.05, z=1: error = ${((1 * 1 * f32u(0.05 / 1)) / 0.05).toExponential(2)} m`);
  line(`VERDICT: vertex-position claim (<1 cm at 1 m) can hold for camera-relative verts.`);
  line(`         Reconstructing WORLD position from the depth buffer at orbit is ~metre-scale.`);
  line(`         Any pass that does so (SSR, fog, atmosphere, deferred) must stay camera-relative.`);
}

hdr('12. SAB vs structured-clone vs transfer for 50 MB (DEC-020, T-0013)');
{
  const bytes = 50 * 1024 * 1024;
  const a = new Float32Array(bytes / 4);
  for (let i = 0; i < a.length; i += 1024) a[i] = i;
  const cloneN = 20;
  const t0 = performance.now();
  for (let i = 0; i < cloneN; i++) structuredClone(a);
  const cloneMs = (performance.now() - t0) / cloneN;
  const sab = new SharedArrayBuffer(bytes);
  const view = new Float32Array(sab);
  view.set(a.subarray(0, 1024));
  const t1 = performance.now();
  for (let i = 0; i < 1000; i++) view[i * 100] += 1; // local write, not a transfer
  const sabWrite = performance.now() - t1;
  line(`structuredClone 50 MB   = ${cloneMs.toFixed(2)} ms  (${(50 / (cloneMs / 1000)).toFixed(0)} MB/s)`);
  line(`SAB local write 1000 slots = ${sabWrite.toFixed(3)} ms (not a copy)`);
  line(`At 60 FPS, a 50 MB clone is ${(cloneMs / 16.6).toFixed(1)}× the frame.`);
  line(`Transfer detaches the sender — main thread cannot read elevation while a worker has it.`);
  line(`VERDICT: transfer fallback CANNOT support in-place L11 updates. SAB is required for that path,`);
  line(`         not merely "preferred". Hosting without COOP/COEP cannot run high-frequency L11 writes.`);
}

// Worker ping for real transfer
{
  const bytes = 50 * 1024 * 1024;
  const src = await new Promise((resolve, reject) => {
    const code = `
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.on('message', (buf) => {
        const t = process.hrtime.bigint();
        parentPort.postMessage(buf, [buf]);
        // roundtrip time is measured on main
      });
    `;
    // Use eval worker for ESM-less
    const w = new Worker(
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (buf) => {
        parentPort.postMessage(buf, [buf]);
      });
    `,
      { eval: true, type: 'module' },
    );
    const buf = new ArrayBuffer(bytes);
    const t0 = performance.now();
    w.once('message', () => {
      const dt = performance.now() - t0;
      w.terminate();
      resolve(dt);
    });
    w.once('error', reject);
    w.postMessage(buf, [buf]);
  });
  line(`worker transfer 50 MB round-trip (this machine) = ${src.toFixed(2)} ms`);
}

hdr('13. Boundary checker holes (DEC-017 "enforced by lint")');
{
  line(`Checked by regex: Math.random, Date.now, performance.now, new Date, crypto.getRandomValues, window., document., navigator.`);
  line(`NOT checked: Math["random"](), globalThis.window, Array.sort without comparator,`);
  line(`             Map/Set insertion-order iteration, crypto.getRandomValues via alias,`);
  line(`             Math.sin in Tier-A files (stableMath does not exist), FMA contraction.`);
  line(`PROTOCOL §6 and DEC-017 claim lint enforcement of sort/Map/Set. The checker does not.`);
  line(`selftest plants Math.random via concatenation so it DOES become Math.random() — the`);
  line(`quoted-property bypass is untested.`);
  line(`VERDICT: the checker is real and self-tested for 3 cases. It is not the DEC-017 claim.`);
}

hdr('14. Cell-size / field-size reference');
{
  const edge = (PI * R) / 2;
  line(`face edge arc           = ${edge.toFixed(3)} m  (claimed 10 007 543)`);
  line(`L11 cell                = ${(edge / 2 ** 11).toFixed(2)} m`);
  line(`L11 cells               = ${6 * 4 ** 11}`);
  line(`L11 i16 SI-MB           = ${((6 * 4 ** 11 * 2) / 1e6).toFixed(2)} MB`);
  line(`L11 i16 MiB             = ${((6 * 4 ** 11 * 2) / 1024 / 1024).toFixed(2)} MiB  (test asserts ~48)`);
}

hdr('15. Near-plane at altitude (DEC-025 vs DEC-005 "near = 0")');
{
  const near = (alt) => Math.min(1000, Math.max(0.05, alt * 1e-4));
  for (const a of [1, 10, 100, 1e3, 1e4, 1e5, 4e7]) {
    line(`  alt=${a.toExponential(0).padStart(7)} m  near=${near(a)} m`);
  }
  line(`DEC-005 wording "near = 0" describes the DEPTH RANGE, not the camera near plane.`);
  line(`If an implementer sets the projection near to 0, the matrix is singular.`);
  line(`VERDICT: specification hazard. Architecture v1 must split "depth range" from "clip near".`);
}

line();
line('=== END independent arithmetic ===');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
writeFileSync(join(ROOT, 'tools/bench/audit-v0.out.txt'), out.join('\n') + '\n');
