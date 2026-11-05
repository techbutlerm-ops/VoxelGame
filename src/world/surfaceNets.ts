import { PAD, SAMPLES } from '../config';
import { MATERIAL_CLIFF, MATERIAL_LINEAR } from './materials';
import { hash3 } from './noise';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}


const S = SAMPLES;
const C = S - 1; // cells per axis
const MAX_VERTS = C * C * C;

// Scratch buffers, reused across calls (one set per worker).
const cellVert = new Int32Array(C * C * C);
let pos = new Float32Array(1 << 16);
let nrm = new Float32Array(1 << 16);
let col = new Float32Array(1 << 16);
let idx = new Uint32Array(1 << 17);

const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function ensure(nVerts: number, nIdx: number) {
  if (nVerts * 3 > pos.length) {
    const n = Math.max(nVerts * 3, pos.length * 2);
    const p = new Float32Array(n); p.set(pos); pos = p;
    const q = new Float32Array(n); q.set(nrm); nrm = q;
    const c = new Float32Array(n); c.set(col); col = c;
  }
  if (nIdx > idx.length) {
    const i = new Uint32Array(Math.max(nIdx, idx.length * 2)); i.set(idx); idx = i;
  }
}

/**
 * Naive Surface Nets over a padded volume. One vertex per sign-changing cell, placed at the
 * average of its edge crossings; one quad per sign-changing edge. Positions are relative to the
 * chunk origin, in voxels. The chunk emits quads for edges in [-1, CHUNK] so neighbouring chunks
 * (including ones at a different LOD) overlap slightly and never leave cracks.
 */
export function surfaceNets(
  density: Float32Array, material: Uint8Array, stride: number,
  ox: number, oy: number, oz: number,
): MeshData | null {
  cellVert.fill(-1);
  let vc = 0;
  const d = new Float32Array(8);

  // --- Vertices ---
  for (let z = 0; z < C; z++) {
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        let mask = 0;
        // The visible material is the solid corner closest to the surface (smallest positive
        // density), not the deepest one, or coarse LODs would show subsoil in stripes.
        let best = Infinity, bestMat = 0;
        for (let c = 0; c < 8; c++) {
          const si = x + CORNER[c][0] + (y + CORNER[c][1] + (z + CORNER[c][2]) * S) * S;
          const v = density[si];
          d[c] = v;
          if (v > 0) {
            mask |= 1 << c;
            if (v < best) { best = v; bestMat = material[si]; }
          }
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          const da = d[a], db = d[b];
          if (da > 0 === db > 0) continue;
          const t = da / (da - db);
          sx += CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * t;
          sy += CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * t;
          sz += CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * t;
          n++;
        }
        sx /= n; sy /= n; sz /= n;

        // Gradient from the cell's corners; density grows inward, so the normal is -grad.
        let gx = d[1] - d[0] + d[3] - d[2] + d[5] - d[4] + d[7] - d[6];
        let gy = d[2] - d[0] + d[3] - d[1] + d[6] - d[4] + d[7] - d[5];
        let gz = d[4] - d[0] + d[5] - d[1] + d[6] - d[2] + d[7] - d[3];
        const gl = Math.hypot(gx, gy, gz) || 1;
        gx = -gx / gl; gy = -gy / gl; gz = -gz / gl;

        ensure(vc + 1, 0);
        const o = vc * 3;
        const lx = (x - PAD + sx) * stride, ly = (y - PAD + sy) * stride, lz = (z - PAD + sz) * stride;
        pos[o] = lx; pos[o + 1] = ly; pos[o + 2] = lz;
        nrm[o] = gx; nrm[o + 1] = gy; nrm[o + 2] = gz;

        // Color: material, blended toward its cliff variant on steep faces (relative to local up).
        const wx = ox + lx, wy = oy + ly, wz = oz + lz;
        const wl = 1 / Math.hypot(wx, wy, wz);
        const up = (gx * wx + gy * wy + gz * wz) * wl;
        const cliff = MATERIAL_CLIFF[bestMat];
        let t = 1;
        if (cliff !== bestMat) {
          t = Math.max(0, Math.min(1, (up - 0.55) / 0.2));
          t = t * t * (3 - 2 * t);
        }
        const jitter = 0.94 + 0.12 * hash3(Math.floor(wx), Math.floor(wy), Math.floor(wz));
        const m3 = bestMat * 3, c3 = cliff * 3;
        col[o] = (MATERIAL_LINEAR[m3] * t + MATERIAL_LINEAR[c3] * (1 - t)) * jitter;
        col[o + 1] = (MATERIAL_LINEAR[m3 + 1] * t + MATERIAL_LINEAR[c3 + 1] * (1 - t)) * jitter;
        col[o + 2] = (MATERIAL_LINEAR[m3 + 2] * t + MATERIAL_LINEAR[c3 + 2] * (1 - t)) * jitter;

        cellVert[x + (y + z * C) * C] = vc++;
        if (vc >= MAX_VERTS) break;
      }
    }
  }
  if (vc === 0) return null;

  // --- Quads ---
  let ic = 0;
  const lo = PAD - 1, hi = S - PAD; // sample indices whose edges this chunk owns: local -1 .. CHUNK
  for (let z = lo; z < hi; z++) {
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) {
        const s0 = density[x + (y + z * S) * S] > 0;
        for (let axis = 0; axis < 3; axis++) {
          const nx = x + (axis === 0 ? 1 : 0), ny = y + (axis === 1 ? 1 : 0), nz = z + (axis === 2 ? 1 : 0);
          const s1 = density[nx + (ny + nz * S) * S] > 0;
          if (s0 === s1) continue;
          // The 4 cells sharing this edge, ordered so (u x v) points along +axis.
          let c0: number, c1: number, c2: number, c3: number;
          if (axis === 0) {
            c0 = cell(x, y - 1, z - 1); c1 = cell(x, y, z - 1); c2 = cell(x, y, z); c3 = cell(x, y - 1, z);
          } else if (axis === 1) {
            c0 = cell(x - 1, y, z - 1); c1 = cell(x - 1, y, z); c2 = cell(x, y, z); c3 = cell(x, y, z - 1);
          } else {
            c0 = cell(x - 1, y - 1, z); c1 = cell(x, y - 1, z); c2 = cell(x, y, z); c3 = cell(x - 1, y, z);
          }
          if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) continue;
          ensure(0, ic + 6);
          if (s0) {
            idx[ic++] = c0; idx[ic++] = c1; idx[ic++] = c2;
            idx[ic++] = c0; idx[ic++] = c2; idx[ic++] = c3;
          } else {
            idx[ic++] = c0; idx[ic++] = c2; idx[ic++] = c1;
            idx[ic++] = c0; idx[ic++] = c3; idx[ic++] = c2;
          }
        }
      }
    }
  }
  if (ic === 0) return null;

  return {
    positions: pos.slice(0, vc * 3),
    normals: nrm.slice(0, vc * 3),
    colors: col.slice(0, vc * 3),
    indices: idx.slice(0, ic),
  };
}

function cell(x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || z < 0 || x >= C || y >= C || z >= C) return -1;
  return cellVert[x + (y + z * C) * C];
}

