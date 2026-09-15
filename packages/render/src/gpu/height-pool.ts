/**
 * GPU height page pool (T-0151).
 *
 * THE DEFECT THIS CLOSES. A patch is drawn with a 33x33 vertex grid, and until
 * now the shader was given FOUR numbers to shape it: the elevations at the
 * patch's own corners. Every interior vertex was a bilinear blend of those
 * four. So a patch covering a mountain range drew a smooth bilinear quad, and
 * subdividing it produced four smaller bilinear quads that added no topography
 * whatsoever. Flying closer magnified a smooth surface instead of revealing
 * one. The tile baker has been producing authoritative elevation rasters at
 * L11-L18 the whole time; the renderer was throwing them away.
 *
 * WHAT THIS IS. A page pool in one GPU storage buffer. Each visible patch owns
 * a page of (n+2)^2 heights — its own vertex grid plus a one-sample BORDER —
 * and the vertex shader reads the height for the vertex it is actually
 * building. 33x33 real samples per patch instead of four corners.
 *
 * WHY THE BORDER. Normals come from a central difference across the page. At a
 * patch edge, a clamped difference is half the true gradient, which draws a
 * bright or dark seam along every patch boundary — the artefact that makes a
 * tiled planet look tiled. One extra ring of samples, taken from the
 * neighbouring patch's own coordinates, makes the gradient correct everywhere
 * and the seam disappears.
 *
 * WHY A POOL RATHER THAN PER-FRAME UPLOAD. Visible patches are stable between
 * frames: the selector splits and merges a handful per frame out of hundreds.
 * Re-uploading every page every frame would be tens of megabytes per frame for
 * data that did not change. Pages are keyed by QuadKey, evicted least-recently
 * used, and a steady camera uploads nothing at all.
 *
 * SIMULATION STATE != RENDERING STATE. The pool holds no authority. Every page
 * is regenerable from the key by a sampler the CALLER supplies — `render`
 * cannot reach `sim`, so where the heights come from is the composition root's
 * answer, exactly as it is for `elevationAt` (DEC-011).
 */

import type { QuadKey } from '@ws/data';
import { quadkey } from '@ws/data';
import type { GpuContext } from './device.js';

/**
 * How many floats each page sample carries: elevation, then a packed material
 * triple (T-0154).
 *
 * WHY MATERIAL LIVES HERE. Vegetation, snow and inland water were sampled ONCE
 * PER PATCH and handed to the shader as a constant, so a patch was a single
 * flat colour and the planet from orbit was a mosaic of rectangles — the
 * faceting that reads as "low-detail technical globe" even when the geometry
 * underneath is right. Sampling them at every vertex, in the same page as the
 * height, makes the surface vary continuously and costs one extra float per
 * sample.
 */
export const PAGE_STRIDE = 2;

/**
 * Fills `out` with `(n+2)^2 * PAGE_STRIDE` floats for `key`, row-major,
 * including a one-sample border on every side.
 *
 * Sample `(iy + 1) * (n + 2) + (ix + 1)` begins at `index * PAGE_STRIDE` and
 * is the vertex `(ix / (n-1), iy / (n-1))` of the patch; index 0 is the border
 * sample one step outside the patch's lower-left corner.
 *
 *   [0] elevation in metres
 *   [1] material, packed as veg*65536 + snow*256 + water with each 0..255
 */
export type HeightPageSampler = (key: QuadKey, n: number, out: Float32Array) => void;

/**
 * Pack four 0..1 fractions into one f32, six bits each.
 *
 * Exact: 24 bits sits inside f32's 2^24 integer range. Six bits is 64 levels,
 * which is invisible once the rasteriser interpolates between vertices, and
 * four channels is what it takes to keep WEATHER off the per-patch path —
 * a per-patch haze value drew the planet as a visible quilt of rectangles even
 * after vegetation, snow and water had moved to the page.
 */
export function packMaterial(
  vegetation: number, snow: number, water: number, weather: number,
): number {
  const q = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 63 : Math.round(v * 63));
  return q(vegetation) * 262144 + q(snow) * 4096 + q(water) * 64 + q(weather);
}

interface Page {
  readonly index: number;
  lastUsed: number;
}

export interface HeightPoolOptions {
  /** Vertices per patch side. The page is (n+2)^2. */
  readonly verticesPerSide: number;
  /** Pages resident on the GPU. Memory is capacity * (n+2)^2 * 4 bytes. */
  readonly capacity?: number;
  /** New pages baked per frame before the rest wait for the next one. */
  readonly bakesPerFrame?: number;
}

export interface HeightPoolStats {
  readonly resident: number;
  readonly capacity: number;
  readonly hits: number;
  readonly misses: number;
  readonly baked: number;
  readonly evicted: number;
  readonly deferred: number;
  readonly bytes: number;
}

export class HeightPagePool {
  readonly pageFloats: number;
  readonly side: number;
  private readonly gpu: GpuContext;
  private readonly capacity: number;
  private readonly bakesPerFrame: number;
  private readonly scratch: Float32Array;
  private readonly pages = new Map<number, Page>();
  private readonly free: number[] = [];
  private storage: GPUBuffer;
  private frame = 0;
  private bakedThisFrame = 0;

  private hits = 0;
  private misses = 0;
  private baked = 0;
  private evicted = 0;
  private deferred = 0;

  constructor(gpu: GpuContext, private readonly sample: HeightPageSampler, options: HeightPoolOptions) {
    this.gpu = gpu;
    this.side = options.verticesPerSide + 2;
    this.pageFloats = this.side * this.side * PAGE_STRIDE;
    this.capacity = Math.max(64, options.capacity ?? 3072);
    this.bakesPerFrame = Math.max(1, options.bakesPerFrame ?? 512);
    this.scratch = new Float32Array(this.pageFloats);
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i);
    this.storage = gpu.device.createBuffer({
      label: 'terrain-height-pages',
      size: this.capacity * this.pageFloats * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  get buffer(): GPUBuffer { return this.storage; }

  beginFrame(): void {
    this.frame++;
    this.bakedThisFrame = 0;
  }

  /**
   * The page index for `key`, baking it if it is not resident.
   *
   * Returns -1 when this frame's bake budget is spent: the caller draws that
   * patch with its corner heights for one frame rather than stalling. A patch
   * that is one frame behind is invisible; a frame that hitches is not.
   */
  acquire(key: QuadKey): number {
    const id = quadkey.packId(key);
    const hit = this.pages.get(id);
    if (hit !== undefined) {
      hit.lastUsed = this.frame;
      this.hits++;
      return hit.index;
    }
    this.misses++;
    if (this.bakedThisFrame >= this.bakesPerFrame) { this.deferred++; return -1; }

    let index = this.free.pop();
    if (index === undefined) index = this.evictLeastRecentlyUsed();
    if (index === undefined) { this.deferred++; return -1; }

    this.sample(key, this.side - 2, this.scratch);
    this.gpu.device.queue.writeBuffer(
      this.storage, index * this.pageFloats * 4,
      this.scratch.buffer as ArrayBuffer, this.scratch.byteOffset, this.pageFloats * 4,
    );
    this.pages.set(id, { index, lastUsed: this.frame });
    this.bakedThisFrame++;
    this.baked++;
    return index;
  }

  /** Drop every page. Correct whenever the terrain itself changed. */
  invalidateAll(): void {
    this.pages.clear();
    this.free.length = 0;
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i);
  }

  stats(): HeightPoolStats {
    return {
      resident: this.pages.size, capacity: this.capacity,
      hits: this.hits, misses: this.misses, baked: this.baked,
      evicted: this.evicted, deferred: this.deferred,
      bytes: this.capacity * this.pageFloats * 4,
    };
  }

  destroy(): void {
    this.storage.destroy();
    this.pages.clear();
  }

  /**
   * Evict the page untouched for longest.
   *
   * Never evicts a page used THIS frame: those belong to patches the selector
   * is drawing right now, and recycling one would blank a visible patch. If
   * every resident page is in use the pool is simply too small for the view,
   * and the caller is told so rather than being handed a page that is about to
   * be overwritten.
   */
  private evictLeastRecentlyUsed(): number | undefined {
    let victimId = -1;
    let victim: Page | undefined;
    for (const [id, page] of this.pages) {
      if (page.lastUsed === this.frame) continue;
      if (victim === undefined || page.lastUsed < victim.lastUsed
        || (page.lastUsed === victim.lastUsed && id < victimId)) {
        victim = page;
        victimId = id;
      }
    }
    if (victim === undefined) return undefined;
    this.pages.delete(victimId);
    this.evicted++;
    return victim.index;
  }
}
