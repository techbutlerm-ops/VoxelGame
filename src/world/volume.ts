import { CAVE_DEPTH, CHUNK, H_MAX, H_MIN, PAD, PLANET_RADIUS as R, SAMPLES, TREE_MAX } from '../config';
import { AIR, M } from './materials';
import {
  FaceCoord, Surface, TREE_DA, TreeSample, caveField, faceCoordsOn, faceDir, faceOf, layerMaterial, sampleTree,
  surfaceAt, treeAt,
} from './planet';

export const VOLUME_SIZE = SAMPLES * SAMPLES * SAMPLES;

/** An edited LOD0 chunk's voxels, laid over procedurally generated samples. */
export interface Overlay {
  ox: number;
  oy: number;
  oz: number;
  density: Uint8Array;
  material: Uint8Array;
}

export type VolumeKind = 'air' | 'solid' | 'mixed';

/** Height lattice of the last generated chunk (used to find how deep mesh vertices are). */
export let lastLattice: { face: number; da: number; ia0: number; ib0: number; na: number; nb: number; hs: Float32Array } | null = null;

/** Original terrain height (above sea level) under a world point, from the last chunk's lattice. */
export function latticeHeight(px: number, py: number, pz: number): number | null {
  const L = lastLattice;
  if (!L) return null;
  faceCoordsOn(L.face, px, py, pz, fc);
  const fa = fc.a / L.da - L.ia0, fb = fc.b / L.da - L.ib0;
  let gi = Math.floor(fa), gj = Math.floor(fb);
  gi = gi < 0 ? 0 : gi > L.na - 2 ? L.na - 2 : gi;
  gj = gj < 0 ? 0 : gj > L.nb - 2 ? L.nb - 2 : gj;
  const ta = Math.max(0, Math.min(1, fa - gi)), tb = Math.max(0, Math.min(1, fb - gj));
  const h = L.hs, na = L.na;
  return (h[gi + gj * na] * (1 - ta) + h[gi + 1 + gj * na] * ta) * (1 - tb) + (h[gi + (gj + 1) * na] * (1 - ta) + h[gi + 1 + (gj + 1) * na] * ta) * tb;
}

const QUARTER_PI = Math.PI / 4;

// Quantization of stored LOD0 densities: 1/32 voxel steps, clamped to +/-3.97 voxels.
export const Q_SCALE = 32;
export const quantize = (d: number) => {
  const q = Math.round(d * Q_SCALE + 128);
  return q < 0 ? 0 : q > 255 ? 255 : q;
};
export const dequantize = (q: number) => (q - 128) / Q_SCALE;

interface Node {
  h: number;
  top: number;
  sub: number;
  biome: number;
  slopeF: number;
}

const surf: Surface = { h: 0, biome: 0, top: 0, sub: 0, temp: 0, moist: 0 };
const dir = new Float64Array(3);
const fc: FaceCoord = { face: 0, a: 0, b: 0 };
const treeOut: TreeSample = { d: 0, mat: 0 };

/**
 * Generate the padded sample volume of a chunk. Sample (i,j,k) sits at
 * origin + (i - PAD, j - PAD, k - PAD) * stride. Density is in voxels, positive = solid.
 */
export function generateVolume(
  ox: number, oy: number, oz: number, level: number,
  density: Float32Array, material: Uint8Array,
): VolumeKind {
  const stride = 1 << level;
  const S = SAMPLES;
  const minX = ox - PAD * stride, minY = oy - PAD * stride, minZ = oz - PAD * stride;
  const span = (S - 1) * stride;
  lastLattice = null;

  // --- Quick reject on radial bounds ---
  const { rmin, rmax } = radialRange(minX, minY, minZ, span);
  const treeAllow = level <= 4 ? TREE_MAX : 0;
  if (rmin > R + H_MAX + treeAllow + 2 * stride) return fillUniform(density, material, -1e3, AIR);
  if (rmax < R + H_MIN - CAVE_DEPTH - 2 * stride) return fillUniform(density, material, 1e3, M.DARK_STONE);

  // --- Height lattice on the chunk's cube face ---
  const cx = minX + span / 2, cy = minY + span / 2, cz = minZ + span / 2;
  const face = faceOf(cx, cy, cz);
  const small = span < R * 0.25;
  // Lattice step in face coordinates; about one node per sample.
  const da = (stride / (R * QUARTER_PI)) * 0.85;

  let grid: Node[] | null = null;
  let ia0 = 0, ib0 = 0, na = 0, nb = 0;
  let hMin = Infinity, hMax = -Infinity;
  if (small) {
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (let c = 0; c < 8; c++) {
      faceCoordsOn(face, minX + (c & 1 ? span : 0), minY + (c & 2 ? span : 0), minZ + (c & 4 ? span : 0), fc);
      aMin = Math.min(aMin, fc.a); aMax = Math.max(aMax, fc.a);
      bMin = Math.min(bMin, fc.b); bMax = Math.max(bMax, fc.b);
    }
    ia0 = Math.floor(aMin / da) - 1;
    ib0 = Math.floor(bMin / da) - 1;
    na = Math.ceil(aMax / da) + 2 - ia0;
    nb = Math.ceil(bMax / da) + 2 - ib0;
    grid = new Array(na * nb);
    const hs = new Float32Array(na * nb);
    lastLattice = { face, da, ia0, ib0, na, nb, hs };
    const px = new Float64Array(na * nb * 3);
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        faceDir(face, (ia0 + i) * da, (ib0 + j) * da, dir);
        surfaceAt(dir[0], dir[1], dir[2], surf);
        const n = i + j * na;
        hs[n] = surf.h;
        px[n * 3] = dir[0] * (R + surf.h);
        px[n * 3 + 1] = dir[1] * (R + surf.h);
        px[n * 3 + 2] = dir[2] * (R + surf.h);
        grid[n] = { h: surf.h, top: surf.top, sub: surf.sub, biome: surf.biome, slopeF: 1 };
        if (surf.h < hMin) hMin = surf.h;
        if (surf.h > hMax) hMax = surf.h;
      }
    }
    // Slope factor converts vertical distance to (approximate) true distance.
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const n = i + j * na;
        const i0 = Math.max(0, i - 1), i1 = Math.min(na - 1, i + 1);
        const j0 = Math.max(0, j - 1), j1 = Math.min(nb - 1, j + 1);
        const ga = (hs[i1 + j * na] - hs[i0 + j * na]) / dist3(px, i1 + j * na, i0 + j * na);
        const gb = (hs[i + j1 * na] - hs[i + j0 * na]) / dist3(px, i + j1 * na, i + j0 * na);
        grid[n].slopeF = 1 / Math.sqrt(1 + ga * ga + gb * gb);
      }
    }
    if (rmin > R + hMax + treeAllow + 2 * stride) return fillUniform(density, material, -1e3, AIR);
    if (rmax < R + hMin - (level <= 2 ? CAVE_DEPTH : 4) - 2 * stride) return fillUniform(density, material, 1e3, M.STONE);
  }

  const caves = level <= 2;
  const trees = level <= 4;
  let anySolid = false, anyAir = false;

  for (let k = 0; k < S; k++) {
    const pz = minZ + k * stride;
    for (let j = 0; j < S; j++) {
      const py = minY + j * stride;
      let idx = (k * S + j) * S;
      for (let i = 0; i < S; i++, idx++) {
        const px = minX + i * stride;
        const r = Math.hypot(px, py, pz);
        const alt = r - R;

        let h: number, top: number, sub: number, slopeF: number;
        if (grid) {
          faceCoordsOn(face, px, py, pz, fc);
          const fa = fc.a / da - ia0, fb = fc.b / da - ib0;
          let gi = Math.floor(fa), gj = Math.floor(fb);
          gi = gi < 0 ? 0 : gi > na - 2 ? na - 2 : gi;
          gj = gj < 0 ? 0 : gj > nb - 2 ? nb - 2 : gj;
          const ta = fa - gi, tb = fb - gj;
          const n00 = grid[gi + gj * na], n10 = grid[gi + 1 + gj * na];
          const n01 = grid[gi + (gj + 1) * na], n11 = grid[gi + 1 + (gj + 1) * na];
          h = (n00.h * (1 - ta) + n10.h * ta) * (1 - tb) + (n01.h * (1 - ta) + n11.h * ta) * tb;
          slopeF = (n00.slopeF * (1 - ta) + n10.slopeF * ta) * (1 - tb) + (n01.slopeF * (1 - ta) + n11.slopeF * ta) * tb;
          const nn = ta < 0.5 ? (tb < 0.5 ? n00 : n01) : tb < 0.5 ? n10 : n11;
          top = nn.top;
          sub = nn.sub;
        } else {
          if (r < R * 0.5) {
            // Deep core: always solid (and avoids normalizing a zero vector at the center).
            density[idx] = 1e3;
            material[idx] = M.DARK_STONE;
            anySolid = true;
            continue;
          }
          const inv = 1 / r;
          surfaceAt(px * inv, py * inv, pz * inv, surf);
          h = surf.h;
          top = surf.top;
          sub = surf.sub;
          slopeF = 0.8;
        }

        const depth = h - alt; // vertical depth below the surface
        let d = depth * slopeF;
        let mat = depth >= 0 ? layerMaterial(top, sub, depth, stride) : AIR;

        if (caves && depth > 2 && depth < CAVE_DEPTH) {
          const c = caveField(px, py, pz, depth);
          if (c < d) {
            d = c;
            if (d <= 0) mat = AIR;
          }
        }

        if (trees && depth < 8 && depth > -TREE_MAX - 12) {
          treeOut.d = 1e9;
          treesNear(px, py, pz, r, level);
          if (-treeOut.d > d) {
            d = -treeOut.d;
            mat = treeOut.mat;
          }
        }

        // Air voxels keep the material of the nearest solid so surface colors stay right.
        if (d <= 0 && mat === AIR) mat = depth >= 0 ? layerMaterial(top, sub, depth, stride) : top;

        density[idx] = d;
        material[idx] = mat;
        if (d > 0) anySolid = true;
        else anyAir = true;
      }
    }
  }
  return anySolid && anyAir ? 'mixed' : anySolid ? 'solid' : 'air';
}

function treesNear(px: number, py: number, pz: number, r: number, level: number) {
  const face = faceOf(px, py, pz);
  faceCoordsOn(face, px, py, pz, fc);
  const fa = fc.a / TREE_DA, fb = fc.b / TREE_DA;
  const ia = Math.floor(fa), ib = Math.floor(fb);
  const ia2 = fa - ia < 0.5 ? ia - 1 : ia + 1;
  const ib2 = fb - ib < 0.5 ? ib - 1 : ib + 1;
  void r;
  for (let q = 0; q < 4; q++) {
    const t = treeAt(face, q & 1 ? ia2 : ia, q & 2 ? ib2 : ib);
    if (t) sampleTree(t, px, py, pz, level, treeOut);
  }
}

function dist3(p: Float64Array, a: number, b: number) {
  return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]) || 1;
}

function radialRange(minX: number, minY: number, minZ: number, span: number) {
  const maxX = minX + span, maxY = minY + span, maxZ = minZ + span;
  const nx = Math.max(minX, Math.min(0, maxX)), ny = Math.max(minY, Math.min(0, maxY)), nz = Math.max(minZ, Math.min(0, maxZ));
  const fx = Math.max(Math.abs(minX), Math.abs(maxX)), fy = Math.max(Math.abs(minY), Math.abs(maxY)), fz = Math.max(Math.abs(minZ), Math.abs(maxZ));
  return { rmin: Math.hypot(nx, ny, nz), rmax: Math.hypot(fx, fy, fz) };
}

function fillUniform(density: Float32Array, material: Uint8Array, d: number, m: number): VolumeKind {
  density.fill(d);
  material.fill(m);
  return d > 0 ? 'solid' : 'air';
}

/** Lay edited LOD0 chunk data over a generated volume (point-sampled at the volume's stride). */
export function applyOverlays(
  ox: number, oy: number, oz: number, level: number,
  density: Float32Array, material: Uint8Array, overlays: Overlay[],
) {
  const stride = 1 << level;
  const S = SAMPLES;
  const minX = ox - PAD * stride, minY = oy - PAD * stride, minZ = oz - PAD * stride;
  for (const o of overlays) {
    // Sample index range that falls inside this overlay chunk.
    const i0 = Math.max(0, Math.ceil((o.ox - minX) / stride)), i1 = Math.min(S - 1, Math.floor((o.ox + CHUNK - 1 - minX) / stride));
    const j0 = Math.max(0, Math.ceil((o.oy - minY) / stride)), j1 = Math.min(S - 1, Math.floor((o.oy + CHUNK - 1 - minY) / stride));
    const k0 = Math.max(0, Math.ceil((o.oz - minZ) / stride)), k1 = Math.min(S - 1, Math.floor((o.oz + CHUNK - 1 - minZ) / stride));
    for (let k = k0; k <= k1; k++) {
      const lz = minZ + k * stride - o.oz;
      for (let j = j0; j <= j1; j++) {
        const ly = minY + j * stride - o.oy;
        for (let i = i0; i <= i1; i++) {
          const lx = minX + i * stride - o.ox;
          const src = lx + (ly + lz * CHUNK) * CHUNK;
          const dst = i + (j + k * S) * S;
          density[dst] = dequantize(o.density[src]);
          material[dst] = o.material[src];
        }
      }
    }
  }
}

/** Extract the 32^3 core (samples 0..31 of the chunk) from a padded LOD0 volume, quantized. */
export function extractCore(density: Float32Array, material: Uint8Array) {
  const S = SAMPLES;
  const d = new Uint8Array(CHUNK * CHUNK * CHUNK);
  const m = new Uint8Array(CHUNK * CHUNK * CHUNK);
  let n = 0;
  for (let z = 0; z < CHUNK; z++)
    for (let y = 0; y < CHUNK; y++) {
      let src = PAD + (y + PAD + (z + PAD) * S) * S;
      for (let x = 0; x < CHUNK; x++, n++, src++) {
        d[n] = quantize(density[src]);
        m[n] = material[src];
      }
    }
  return { density: d, material: m };
}
