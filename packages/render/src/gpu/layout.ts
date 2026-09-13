/**
 * CPU-side view of the GPU data layout (T-0061).
 *
 * These constants describe how the CPU writes the uniform buffer and the
 * instance buffer. They are NOT the source of truth: `planet.wgsl.ts` is.
 * `packages/render/test/gpu-contract.test.ts` parses the WGSL with a real
 * grammar and asserts that every number here matches the struct the shader
 * actually declares.
 *
 * That direction matters. Astra's Ampere pass found a shader that TypeScript
 * was perfectly happy with; the compiler on the other side of the boundary is
 * the authority, so the check runs from the shader back to the CPU rather than
 * the other way round.
 *
 * WGSL layout rules that bite here, all of them avoided by construction:
 *   - `vec3<f32>` has size 12 but ALIGN 16, so a struct of vec3s is not tightly
 *     packed. Every member below is a vec4 or a mat4x4, so there is no padding
 *     and no trap.
 *   - a struct's stride in an array is roundUp(align, size); PatchInstance is
 *     64 bytes with align 16, so the stride is exactly 64.
 *   - uniform buffers require 16-byte member alignment; mat4x4 and vec4 both
 *     satisfy it.
 */

/**
 * Uniforms: mat4x4 viewProj + vec4 sunDirection + vec4 params + vec4 camK +
 * vec4 post.
 */
export const UNIFORM_FLOATS = 32;
export const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

/** Float offsets into the uniform staging array. Byte offset = float * 4. */
export const UNIFORM_OFFSET = {
  viewProj: 0,
  sunDirection: 16,
  params: 20,
  camK: 24,
  post: 28,
} as const;

/**
 * What `post` carries. Presentation only: none of it can reach `sim`, and the
 * simulation produces identical results whatever is in here (T-0103).
 */
export const POST_LANE = {
  /** x: adapted exposure gain. See `post/exposure.ts`. */
  exposure: 0,
  /** y: highlight bloom strength, 0 disables. */
  bloom: 1,
  /** z, w: reserved. */
} as const;

/** PatchInstance: six vec4s. Byte offset = float * 4. */
export const INSTANCE_FLOATS = 24;
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

export const INSTANCE_OFFSET = {
  c00: 0,
  c10: 4,
  c01: 8,
  c11: 12,
  elev: 16,
  surface: 20,
} as const;

/**
 * What each `.w` lane carries. The corners are camera-relative positions in
 * `.xyz`; the spare lane is scalar metadata. It must never hold a component of
 * a planet-centred position — that was the leak DEC-033 closed.
 */
export const INSTANCE_W_MEANING = {
  c00: 'lod level',
  c10: 'cube face id',
  c01: 'reserved (0)',
  c11: 'reserved (0)',
} as const;

/** The single vertex buffer: vec2<f32> grid parameter, tightly packed. */
export const VERTEX_ATTR = {
  shaderLocation: 0,
  format: 'float32x2',
  arrayStride: 8,
  offset: 0,
} as const;

/** Entry point names the pipeline asks for. Checked against the shader. */
export const ENTRY_POINTS = { vertex: 'vs', fragment: 'fs' } as const;

/** Bind group 0 slots. Checked against the shader's @binding attributes. */
export const BINDINGS = { uniforms: 0, instances: 1 } as const;
