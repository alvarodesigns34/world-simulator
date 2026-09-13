/**
 * City plan renderer (M9).
 *
 * Draws a city layout — streets, bridges, districts, buildings — into a 2D
 * canvas, or into a plain RGBA buffer so it can be tested without a browser.
 *
 * Lives in `render` and imports nothing from `sim` (DEC-011): it takes the flat
 * arrays a layout is made of, exactly as `FieldOverlay` takes a field. That is
 * also what makes it testable — the pixel tests below run headless.
 *
 * WHY THIS EXISTS. M9's whole claim is that a city is a small authoritative
 * state plus a generator. That claim is only checkable if someone can LOOK at
 * the output: a bridge in the right place, a street that stops at a cliff, an
 * industrial quarter downwind of the core. A number cannot show that and a test
 * can only assert what it was told to expect.
 */

/** The subset of a layout this renderer needs. Structural, not a sim type. */
export interface CityPlanInput {
  readonly radiusM: number;
  readonly nodeXY: Float32Array;
  readonly nodeCount: number;
  readonly edges: Int32Array;
  readonly edgeClass: Uint8Array;
  readonly edgeCount: number;
  readonly bridgeEdges: Int32Array;
  readonly bridgeCount: number;
  readonly districtKind: Uint8Array;
  readonly districtXY: Float32Array;
  readonly districtRadiusM: Float32Array;
  readonly districtCount: number;
  readonly buildings: Float32Array;
  readonly buildingDistrict: Uint8Array;
  readonly buildingCount: number;
}

/** Optional water/terrain backdrop, sampled in local metres. */
export interface PlanBackdrop {
  waterAt(x: number, y: number): boolean;
  elevationAt(x: number, y: number): number;
}

export interface PlanStyle {
  readonly width: number;
  readonly height: number;
  /** Metres per pixel; omit to fit the city's radius with a small margin. */
  readonly metresPerPixel?: number;
}

const DISTRICT_COLOUR: readonly (readonly [number, number, number])[] = [
  [235, 205, 130], // core
  [225, 150, 90],  // commercial
  [150, 170, 200], // residential
  [170, 110, 120], // industrial
  [110, 190, 200], // port
  [140, 180, 110], // agricultural
  [180, 160, 180], // military
];

const ROAD_COLOUR: readonly (readonly [number, number, number])[] = [
  [250, 230, 170], // arterial
  [220, 190, 140], // ring
  [140, 150, 165], // street
  [100, 110, 125], // lane
];

const ROAD_WIDTH: readonly number[] = [2.4, 1.8, 0.9, 0.6];

/**
 * Render a plan into an RGBA buffer.
 *
 * Returns the buffer and the scale used, so a caller can map a pixel back to a
 * local coordinate — which the tests do, and which a probe would.
 */
export function renderCityPlan(
  plan: CityPlanInput,
  style: PlanStyle,
  backdrop?: PlanBackdrop,
): { rgba: Uint8ClampedArray; metresPerPixel: number; centreX: number; centreY: number } {
  const { width: W, height: H } = style;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const mpp = style.metresPerPixel ?? (2.35 * Math.max(1, plan.radiusM)) / Math.min(W, H);
  const cx = W / 2;
  const cy = H / 2;

  const px = (x: number): number => cx + x / mpp;
  const py = (y: number): number => cy - y / mpp;

  const put = (x: number, y: number, r: number, g: number, b: number, a = 1): void => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const o = (yi * W + xi) * 4;
    rgba[o] = (rgba[o] as number) * (1 - a) + r * a;
    rgba[o + 1] = (rgba[o + 1] as number) * (1 - a) + g * a;
    rgba[o + 2] = (rgba[o + 2] as number) * (1 - a) + b * a;
    rgba[o + 3] = 255;
  };

  /* --- ground --- */
  for (let yi = 0; yi < H; yi++) {
    for (let xi = 0; xi < W; xi++) {
      const lx = (xi - cx) * mpp;
      const ly = (cy - yi) * mpp;
      let r = 18;
      let g = 22;
      let b = 26;
      if (backdrop !== undefined) {
        if (backdrop.waterAt(lx, ly)) {
          r = 22; g = 48; b = 78;
        } else {
          /* Shade by elevation so a slope reads as a slope. Relative to the
             city centre, because absolute altitude is not the interesting
             thing here — local relief is. */
          const dz = backdrop.elevationAt(lx, ly) - backdrop.elevationAt(0, 0);
          const t = Math.max(-1, Math.min(1, dz / 400));
          r = 26 + t * 22;
          g = 30 + t * 24;
          b = 28 + t * 18;
        }
      }
      const o = (yi * W + xi) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }

  /* --- district washes, drawn under everything --- */
  for (let d = 0; d < plan.districtCount; d++) {
    const kind = plan.districtKind[d] as number;
    const col = DISTRICT_COLOUR[kind] ?? [128, 128, 128];
    const dx = plan.districtXY[d * 2] as number;
    const dy = plan.districtXY[d * 2 + 1] as number;
    const rad = (plan.districtRadiusM[d] as number) / mpp;
    if (!(rad > 0)) continue;
    const x0 = Math.floor(px(dx) - rad);
    const x1 = Math.ceil(px(dx) + rad);
    const y0 = Math.floor(py(dy) - rad);
    const y1 = Math.ceil(py(dy) + rad);
    for (let yi = y0; yi <= y1; yi++) {
      for (let xi = x0; xi <= x1; xi++) {
        const ddx = xi - px(dx);
        const ddy = yi - py(dy);
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist > rad) continue;
        /* Soft edge, so overlapping districts blend instead of tiling. */
        const a = 0.28 * (1 - dist / rad);
        put(xi, yi, col[0] as number, col[1] as number, col[2] as number, a);
      }
    }
  }

  /* --- buildings --- */
  for (let i = 0; i < plan.buildingCount; i++) {
    const bx = plan.buildings[i * 4] as number;
    const by = plan.buildings[i * 4 + 1] as number;
    const foot = (plan.buildings[i * 4 + 2] as number) / mpp;
    const height = plan.buildings[i * 4 + 3] as number;
    const kind = plan.buildingDistrict[i] as number;
    const col = DISTRICT_COLOUR[kind] ?? [150, 150, 150];
    /* Taller buildings read brighter — the one cue that survives at this
       scale, and the one that makes a skyline legible. */
    const lift = Math.min(1, height / 120);
    const r = Math.min(255, (col[0] as number) * (0.55 + 0.7 * lift));
    const g = Math.min(255, (col[1] as number) * (0.55 + 0.7 * lift));
    const b = Math.min(255, (col[2] as number) * (0.55 + 0.7 * lift));
    const half = Math.max(0.5, foot / 2);
    const sx = px(bx);
    const sy = py(by);
    for (let yi = Math.floor(sy - half); yi <= Math.ceil(sy + half); yi++) {
      for (let xi = Math.floor(sx - half); xi <= Math.ceil(sx + half); xi++) {
        put(xi, yi, r, g, b, 0.9);
      }
    }
  }

  /* --- streets, coarse classes last so arterials read on top --- */
  const bridge = new Uint8Array(plan.edgeCount);
  for (let k = 0; k < plan.bridgeCount; k++) {
    const e = plan.bridgeEdges[k] as number;
    if (e >= 0 && e < plan.edgeCount) bridge[e] = 1;
  }
  for (const pass of [3, 2, 1, 0]) {
    for (let e = 0; e < plan.edgeCount; e++) {
      if ((plan.edgeClass[e] as number) !== pass) continue;
      const a = plan.edges[e * 2] as number;
      const b = plan.edges[e * 2 + 1] as number;
      const ax = px(plan.nodeXY[a * 2] as number);
      const ay = py(plan.nodeXY[a * 2 + 1] as number);
      const bx = px(plan.nodeXY[b * 2] as number);
      const by = py(plan.nodeXY[b * 2 + 1] as number);
      /* A bridge is drawn distinctly, because "is there a bridge and is it in
         the right place" is the single most informative thing about how a city
         met its river. */
      const col = bridge[e] === 1 ? [255, 120, 120] : (ROAD_COLOUR[pass] ?? [150, 150, 150]);
      const w = (ROAD_WIDTH[pass] ?? 1) * (bridge[e] === 1 ? 1.6 : 1);
      line(ax, ay, bx, by, w, col as readonly [number, number, number], put);
    }
  }

  return { rgba, metresPerPixel: mpp, centreX: cx, centreY: cy };
}

function line(
  ax: number, ay: number, bx: number, by: number, width: number,
  col: readonly [number, number, number],
  put: (x: number, y: number, r: number, g: number, b: number, a?: number) => void,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
  const half = Math.max(0, width / 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = ax + dx * t;
    const y = ay + dy * t;
    for (let oy = -Math.ceil(half); oy <= Math.ceil(half); oy++) {
      for (let ox = -Math.ceil(half); ox <= Math.ceil(half); ox++) {
        if (ox * ox + oy * oy > (half + 0.35) * (half + 0.35)) continue;
        put(x + ox, y + oy, col[0], col[1], col[2], 1);
      }
    }
  }
}

/** Blit a rendered plan into a canvas. Browser only; the tests use the buffer. */
export function drawCityPlan(
  canvas: HTMLCanvasElement,
  plan: CityPlanInput,
  backdrop?: PlanBackdrop,
): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const out = renderCityPlan(plan, { width: canvas.width, height: canvas.height }, backdrop);
  const image = ctx.createImageData(canvas.width, canvas.height);
  image.data.set(out.rgba);
  ctx.putImageData(image, 0, 0);
}
