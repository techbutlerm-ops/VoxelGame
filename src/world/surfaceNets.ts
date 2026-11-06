import { PAD, SAMPLES } from '../config';
import { M, MATERIAL_CLIFF, MATERIAL_CONSTRUCT, MATERIAL_LINEAR } from './materials';
import { hash3 } from './noise';
import { buildFrameAt } from './planet';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per vertex: sky exposure (0 = deep underground, 1 = open sky) and glow (lamps). */
  light: Float32Array;
  indices: Uint32Array;
}

const S = SAMPLES;
const C = S - 1; // cells per axis

// Scratch buffers, reused across calls (one set per worker).
const cellVert = new Int32Array(C * C * C);
let pos = new Float32Array(1 << 16);
let nrm = new Float32Array(1 << 16);
let col = new Float32Array(1 << 16);
let lit = new Float32Array((1 << 16) / 3 * 2);
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
    const l = new Float32Array((n / 3) * 2); l.set(lit); lit = l;
  }
  if (nIdx > idx.length) {
    const i = new Uint32Array(Math.max(nIdx, idx.length * 2)); i.set(idx); idx = i;
  }
}

/** Density gradient at a sample by central differences (one-sided at the volume border). */
function gradientAt(density: Float32Array, x: number, y: number, z: number, out: number[], o: number) {
  const i = x + (y + z * S) * S;
  const x0 = x > 0 ? i - 1 : i, x1 = x < S - 1 ? i + 1 : i;
  const y0 = y > 0 ? i - S : i, y1 = y < S - 1 ? i + S : i;
  const z0 = z > 0 ? i - S * S : i, z1 = z < S - 1 ? i + S * S : i;
  out[o] = density[x1] - density[x0];
  out[o + 1] = density[y1] - density[y0];
  out[o + 2] = density[z1] - density[z0];
}

// --- QEF solve for dual contouring ------------------------------------------------------------

const A = new Float64Array(9);
const V = new Float64Array(9);

/** Eigen-decompose the symmetric 3x3 matrix in A (in place: A becomes diagonal, V the eigenvectors). */
function jacobiEigen() {
  V.fill(0);
  V[0] = V[4] = V[8] = 1;
  for (let sweep = 0; sweep < 8; sweep++) {
    const off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5];
    if (off < 1e-12) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        const apq = A[p * 3 + q];
        if (Math.abs(apq) < 1e-12) continue;
        const app = A[p * 4], aqq = A[q * 4];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = A[k * 3 + p], akq = A[k * 3 + q];
          A[k * 3 + p] = c * akp - s * akq;
          A[k * 3 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = A[p * 3 + k], aqk = A[q * 3 + k];
          A[p * 3 + k] = c * apk - s * aqk;
          A[q * 3 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
          V[k * 3 + p] = c * vkp - s * vkq;
          V[k * 3 + q] = s * vkp + c * vkq;
        }
      }
  }
}

/**
 * Minimize sum((n_i . (x - p_i))^2) around the mass point, truncating small eigenvalues so flat
 * or edge-only cells stay well behaved. Planes are given as normals and offsets (n . p).
 */
export function solveQEF(normals: number[], offsets: number[], count: number, mx: number, my: number, mz: number, out: number[]) {
  A.fill(0);
  let bx = 0, by = 0, bz = 0;
  for (let i = 0; i < count; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    // Residual relative to the mass point keeps the solve well conditioned.
    const r = offsets[i] - (nx * mx + ny * my + nz * mz);
    A[0] += nx * nx; A[1] += nx * ny; A[2] += nx * nz;
    A[4] += ny * ny; A[5] += ny * nz; A[8] += nz * nz;
    bx += nx * r; by += ny * r; bz += nz * r;
  }
  A[3] = A[1]; A[6] = A[2]; A[7] = A[5];
  jacobiEigen();
  const l0 = A[0], l1 = A[4], l2 = A[8];
  const lmax = Math.max(Math.abs(l0), Math.abs(l1), Math.abs(l2));
  const inv = (l: number) => (Math.abs(l) > lmax * 0.08 && Math.abs(l) > 1e-6 ? 1 / l : 0);
  const i0 = inv(l0), i1 = inv(l1), i2 = inv(l2);
  // x = m + V diag(inv) V^T b
  const t0 = (V[0] * bx + V[3] * by + V[6] * bz) * i0;
  const t1 = (V[1] * bx + V[4] * by + V[7] * bz) * i1;
  const t2 = (V[2] * bx + V[5] * by + V[8] * bz) * i2;
  out[0] = mx + V[0] * t0 + V[1] * t1 + V[2] * t2;
  out[1] = my + V[3] * t0 + V[4] * t1 + V[5] * t2;
  out[2] = mz + V[6] * t0 + V[7] * t1 + V[8] * t2;
}

const cornerGrad = new Array<number>(24).fill(0);
const MAX_PLANES = 27 * 12;
const planeN = new Array<number>(MAX_PLANES * 3).fill(0);
const planeD = new Array<number>(MAX_PLANES).fill(0);
const qefOut = [0, 0, 0];

// Per-cell scratch for the two-pass vertex placement.
const CELLS = C * C * C;
const cellMass = new Float32Array(CELLS * 3);
const cellMat = new Uint8Array(CELLS);
const cellFlags = new Uint8Array(CELLS); // 1 = surface cell, 2 = touches a construction material
const planeStart = new Int32Array(CELLS);
const planeCount = new Uint8Array(CELLS);
let planeBuf = new Float32Array(1 << 16); // per plane: normal xyz, point xyz (volume cell coords)


// Build-frame snapping. Every construction face lies on a build-grid plane: an axis plane at
// an integer voxel offset, or a 45-degree ramp slope at an offset that is a multiple of 1/sqrt2.
const snapAxes = new Float64Array(9);
const snapDiag = new Float64Array(12);
const snapOrigin = new Float64Array(3);

function setSnapFrame(px: number, py: number, pz: number) {
  const f = buildFrameAt(px, py, pz);
  snapAxes.set(f.x, 0); snapAxes.set(f.y, 3); snapAxes.set(f.z, 6);
  const k = Math.SQRT1_2;
  for (let i = 0; i < 3; i++) {
    snapDiag[i] = (f.y[i] - f.x[i]) * k;
    snapDiag[3 + i] = (f.y[i] + f.x[i]) * k;
    snapDiag[6 + i] = (f.y[i] - f.z[i]) * k;
    snapDiag[9 + i] = (f.y[i] + f.z[i]) * k;
  }
  snapOrigin.set(f.o);
}

/**
 * Snap a crossing's plane (unit normal n, world point w) to the build grid in place. Ramp slopes
 * are only taken when the normal is clearly diagonal and both edge gradients agree; otherwise the
 * nearest axis wins, and its offset rounds to the face plane even for crossings near an edge.
 */
function snapPlane(n: number[], w: number[], consistent: boolean) {
  let bestDiag = 0.97, di = -1;
  if (consistent) {
    for (let i = 0; i < 4; i++) {
      const dt = n[0] * snapDiag[i * 3] + n[1] * snapDiag[i * 3 + 1] + n[2] * snapDiag[i * 3 + 2];
      if (dt > bestDiag) { bestDiag = dt; di = i; }
    }
  }
  let unit = 1;
  snappedDiagonal = di >= 0;
  if (di >= 0) {
    n[0] = snapDiag[di * 3]; n[1] = snapDiag[di * 3 + 1]; n[2] = snapDiag[di * 3 + 2];
    unit = Math.SQRT1_2;
  } else {
    let best = -2, ai = 0, sign = 1;
    for (let i = 0; i < 3; i++) {
      const dt = n[0] * snapAxes[i * 3] + n[1] * snapAxes[i * 3 + 1] + n[2] * snapAxes[i * 3 + 2];
      if (Math.abs(dt) > best) { best = Math.abs(dt); ai = i; sign = dt < 0 ? -1 : 1; }
    }
    if (best < 0.6) return 0; // a curved construction surface (e.g. a brick sphere): leave it
    n[0] = snapAxes[ai * 3] * sign; n[1] = snapAxes[ai * 3 + 1] * sign; n[2] = snapAxes[ai * 3 + 2] * sign;
  }
  // Offset of the plane through w, in frame coordinates, rounded to the grid.
  const c = n[0] * (w[0] - snapOrigin[0]) + n[1] * (w[1] - snapOrigin[1]) + n[2] * (w[2] - snapOrigin[2]);
  const snapped = Math.round(c / unit) * unit;
  return Math.abs(snapped - c) < 0.45 * unit ? snapped - c : 0;
}
const crossW = [0, 0, 0];
const snapOut = [0, 0, 0];
/** Set by snapPlane: whether the last plane was snapped to a ramp slope. */
let snappedDiagonal = false;

/** Does this cell or a neighbour carry a ramp-slope plane? */
function rampNear(x: number, y: number, z: number): boolean {
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= C || ny >= C || nz >= C) continue;
        if (cellFlags[nx + (ny + nz * C) * C] & 4) return true;
      }
  return false;
}

/** Nearest integer if within tol, else NaN. */
const near = (v: number, tol: number) => {
  const r = Math.round(v);
  return Math.abs(v - r) < tol ? r : NaN;
};

/**
 * Snap a construction vertex (cell x,y,z + fraction s) onto the build lattice. Piece faces lie
 * on integer frame planes and ramp slopes on integer (y +- x) or (y +- z) planes, so coordinates
 * that are nearly integral are made exact; vertices on edges and corners snap on two or three.
 */
function snapVertex(x: number, y: number, z: number, fx: number, fy: number, fz: number, stride: number, ox: number, oy: number, oz: number, ramp: boolean) {
  const wx = ox + (x - PAD + fx) * stride - snapOrigin[0];
  const wy = oy + (y - PAD + fy) * stride - snapOrigin[1];
  const wz = oz + (z - PAD + fz) * stride - snapOrigin[2];
  const A = snapAxes;
  const l = [wx * A[0] + wy * A[1] + wz * A[2], wx * A[3] + wy * A[4] + wz * A[5], wx * A[6] + wy * A[7] + wz * A[8]];
  const snapped = [near(l[0], 0.3), near(l[1], 0.3), near(l[2], 0.3)];
  const out = [0, 1, 2].map((k) => (Number.isNaN(snapped[k]) ? l[k] : snapped[k]));
  // Ramp slopes: y - x, y + x, y - z, y + z on integers (only where a slope plane was seen).
  if (ramp) for (const [k, sgn] of [[0, -1], [0, 1], [2, -1], [2, 1]] as const) {
    const target = near(l[1] + sgn * l[k], 0.2);
    if (Number.isNaN(target)) continue;
    const yFixed = !Number.isNaN(snapped[1]), kFixed = !Number.isNaN(snapped[k]);
    if (yFixed && kFixed) break;
    if (yFixed) out[k] = (target - out[1]) * sgn;
    else if (kFixed) out[1] = target - sgn * out[k];
    else {
      const r = (out[1] + sgn * out[k] - target) / 2;
      out[1] -= r;
      out[k] -= sgn * r;
    }
    break;
  }
  // Back to world, then to this cell's fractional coordinates.
  const bx = snapOrigin[0] + out[0] * A[0] + out[1] * A[3] + out[2] * A[6];
  const by = snapOrigin[1] + out[0] * A[1] + out[1] * A[4] + out[2] * A[7];
  const bz = snapOrigin[2] + out[0] * A[2] + out[1] * A[5] + out[2] * A[8];
  snapOut[0] = (bx - ox) / stride + PAD - x;
  snapOut[1] = (by - oy) / stride + PAD - y;
  snapOut[2] = (bz - oz) / stride + PAD - z;
}
const snapTmp = [0, 0, 0];

/**
 * Append cell `cj`'s hermite planes, expressed relative to cell (x, y, z), at index n. With a
 * mass point (mx, my, mz), only planes passing within a voxel of it are taken: a thin piece's
 * opposite face is also nearby, and averaging it in would pull the vertex inside the piece.
 */
function gatherPlanes(cj: number, x: number, y: number, z: number, n: number, mx = NaN, my = 0, mz = 0): number {
  const st = planeStart[cj], cnt = planeCount[cj];
  for (let q = 0; q < cnt && n < MAX_PLANES; q++) {
    const o = (st + q) * 6;
    const pnx = planeBuf[o], pny = planeBuf[o + 1], pnz = planeBuf[o + 2];
    const d = pnx * (planeBuf[o + 3] - x) + pny * (planeBuf[o + 4] - y) + pnz * (planeBuf[o + 5] - z);
    if (!Number.isNaN(mx) && Math.abs(d - (pnx * mx + pny * my + pnz * mz)) > 0.9) continue;
    planeN[n * 3] = pnx; planeN[n * 3 + 1] = pny; planeN[n * 3 + 2] = pnz;
    planeD[n] = d;
    n++;
  }
  return n;
}

/**
 * Hybrid Surface Nets / dual contouring over a padded volume. One vertex per sign-changing cell
 * and one quad per sign-changing edge. Natural materials use the smooth Surface Nets vertex
 * (average of edge crossings). Cells touching construction materials solve a QEF instead, which
 * keeps box edges and corners sharp even when the build grid isn't aligned with the voxel axes,
 * and their faces are emitted flat-shaded. Gradient normals blur within a voxel of an edge, so
 * the QEF also takes the crossing planes of the 26 neighbouring cells, whose face-interior
 * normals are accurate. Positions are relative to the chunk origin, in voxels. The chunk emits
 * quads for edges in [-1, CHUNK] so neighbouring chunks (including ones at a different LOD)
 * overlap slightly and never leave cracks.
 */
export function surfaceNets(
  density: Float32Array, material: Uint8Array, stride: number,
  ox: number, oy: number, oz: number,
  /** Only the first n samples per axis hold data (smaller debris pieces); the rest is air. */
  extent = S,
): MeshData | null {
  const E = Math.min(C, extent); // cells per axis worth visiting
  cellVert.fill(-1);
  cellFlags.fill(0);
  let vc = 0;
  const d = new Float32Array(8);

  // --- Pass 1: classify cells, mass points, and (if needed) hermite planes ---
  let anyConstruct = false;
  for (let z = 0; z < E; z++)
    for (let y = 0; y < E; y++)
      for (let x = 0; x < E; x++) {
        let mask = 0;
        // The visible material is the solid corner closest to the surface (smallest positive
        // density), not the deepest one, or coarse LODs would show subsoil in stripes.
        let best = Infinity, bestMat = 0, construct = false;
        for (let c = 0; c < 8; c++) {
          const si = x + CORNER[c][0] + (y + CORNER[c][1] + (z + CORNER[c][2]) * S) * S;
          const v = density[si];
          d[c] = v;
          if (v > 0) {
            mask |= 1 << c;
            const m = material[si];
            if (MATERIAL_CONSTRUCT[m]) construct = true;
            if (v < best) { best = v; bestMat = m; }
          }
        }
        if (mask === 0 || mask === 255) continue;
        const ci = x + (y + z * C) * C;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          if (d[a] > 0 === d[b] > 0) continue;
          const t = d[a] / (d[a] - d[b]);
          sx += CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * t;
          sy += CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * t;
          sz += CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * t;
          n++;
        }
        cellMass[ci * 3] = sx / n; cellMass[ci * 3 + 1] = sy / n; cellMass[ci * 3 + 2] = sz / n;
        cellMat[ci] = bestMat;
        cellFlags[ci] = construct ? 3 : 1;
        if (construct) anyConstruct = true;
      }

  if (anyConstruct) {
    const half = (C / 2 - PAD) * stride;
    setSnapFrame(ox + half, oy + half, oz + half);
    let np = 0;
    for (let ci = 0; ci < CELLS; ci++) {
      if (!cellFlags[ci]) continue;
      const x = ci % C, y = Math.floor(ci / C) % C, z = Math.floor(ci / (C * C));
      for (let c = 0; c < 8; c++) {
        const si = x + CORNER[c][0] + (y + CORNER[c][1] + (z + CORNER[c][2]) * S) * S;
        d[c] = density[si];
        gradientAt(density, x + CORNER[c][0], y + CORNER[c][1], z + CORNER[c][2], cornerGrad, c * 3);
      }
      planeStart[ci] = np;
      let count = 0;
      for (let e = 0; e < 12; e++) {
        const a = EDGES[e][0], b = EDGES[e][1];
        if (d[a] > 0 === d[b] > 0) continue;
        const t = d[a] / (d[a] - d[b]);
        const ax = cornerGrad[a * 3], ay = cornerGrad[a * 3 + 1], az = cornerGrad[a * 3 + 2];
        const bx = cornerGrad[b * 3], by = cornerGrad[b * 3 + 1], bz = cornerGrad[b * 3 + 2];
        const gx = ax + (bx - ax) * t, gy = ay + (by - ay) * t, gz = az + (bz - az) * t;
        const gl = Math.hypot(gx, gy, gz) || 1;
        if ((np + 1) * 6 > planeBuf.length) { const nb = new Float32Array(planeBuf.length * 2); nb.set(planeBuf); planeBuf = nb; }
        const o = np * 6;
        let cx = x + CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * t;
        let cy = y + CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * t;
        let cz = z + CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * t;
        snapTmp[0] = -gx / gl; snapTmp[1] = -gy / gl; snapTmp[2] = -gz / gl;
        if (cellFlags[ci] & 2) {
          const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
          const consistent = (ax * bx + ay * by + az * bz) / (la * lb) > 0.98;
          crossW[0] = ox + (cx - PAD) * stride; crossW[1] = oy + (cy - PAD) * stride; crossW[2] = oz + (cz - PAD) * stride;
          // Move the crossing onto the snapped plane (shift is in voxels; volume units are strides).
          snappedDiagonal = false;
          const shift = snapPlane(snapTmp, crossW, consistent) / stride;
          cx += snapTmp[0] * shift; cy += snapTmp[1] * shift; cz += snapTmp[2] * shift;
          if (snappedDiagonal) cellFlags[ci] |= 4;
        }
        planeBuf[o] = snapTmp[0]; planeBuf[o + 1] = snapTmp[1]; planeBuf[o + 2] = snapTmp[2];
        planeBuf[o + 3] = cx;
        planeBuf[o + 4] = cy;
        planeBuf[o + 5] = cz;
        np++;
        count++;
      }
      planeCount[ci] = count;
    }
  }

  // --- Pass 2: vertices ---
  for (let ci = 0; ci < CELLS; ci++) {
    const flags = cellFlags[ci];
    if (!flags) continue;
    const x = ci % C, y = Math.floor(ci / C) % C, z = Math.floor(ci / (C * C));
    for (let c = 0; c < 8; c++) d[c] = density[x + CORNER[c][0] + (y + CORNER[c][1] + (z + CORNER[c][2]) * S) * S];
    const bestMat = cellMat[ci];
    let sx = cellMass[ci * 3], sy = cellMass[ci * 3 + 1], sz = cellMass[ci * 3 + 2];
    if (flags & 2) {
      // Own planes first; then add the neighbours' (exact after snapping), which recovers
      // corners whose cell lacks a crossing on one face. Neighbour planes are only trusted when
      // the solution stays inside the cell; otherwise they belong to a feature elsewhere.
      let n = gatherPlanes(ci, x, y, z, 0);
      const own = n;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= C || ny >= C || nz >= C) continue;
            const nj = nx + (ny + nz * C) * C;
            if (cellFlags[nj] & 2) n = gatherPlanes(nj, x, y, z, n, sx, sy, sz);
          }
      let inside = false;
      if (n > own) {
        solveQEF(planeN, planeD, n, sx, sy, sz, qefOut);
        const e = 1e-3;
        inside = qefOut[0] > -e && qefOut[0] < 1 + e && qefOut[1] > -e && qefOut[1] < 1 + e && qefOut[2] > -e && qefOut[2] < 1 + e;
      }
      if (!inside) solveQEF(planeN, planeD, own, sx, sy, sz, qefOut);
      // Keep the vertex inside its cell to avoid spikes.
      sx = Math.max(0, Math.min(1, qefOut[0]));
      sy = Math.max(0, Math.min(1, qefOut[1]));
      sz = Math.max(0, Math.min(1, qefOut[2]));
      // Lock onto the build lattice: flat shading turns even 0.05-voxel errors into visible facets.
      snapVertex(x, y, z, sx, sy, sz, stride, ox, oy, oz, rampNear(x, y, z));
      sx = snapOut[0]; sy = snapOut[1]; sz = snapOut[2];
    }
    {
      {
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

        lit[vc * 2] = 1;
        lit[vc * 2 + 1] = bestMat === M.LAMP ? 1 : 0;
        cellVert[ci] = vc++;
      }
    }
  }
  if (vc === 0) return null;

  // --- Quads ---
  let ic = 0;
  const lo = PAD - 1, hi = Math.min(S - PAD, E); // sample indices whose edges this chunk owns: local -1 .. CHUNK
  for (let z = lo; z < hi; z++) {
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) {
        const i0 = x + (y + z * S) * S;
        const s0 = density[i0] > 0;
        for (let axis = 0; axis < 3; axis++) {
          const i1 = i0 + (axis === 0 ? 1 : axis === 1 ? S : S * S);
          const s1 = density[i1] > 0;
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
          // Wind so the front face points from solid toward air.
          if (!s0) { const tmp = c1; c1 = c3; c3 = tmp; }

          const mat = material[s0 ? i0 : i1];
          if (MATERIAL_CONSTRUCT[mat]) {
            // Flat-shaded: own vertices per triangle, split along the diagonal that keeps the
            // two halves most coplanar (follows sharp creases).
            const sx = ox + pos[c0 * 3], sy = oy + pos[c0 * 3 + 1], sz = oz + pos[c0 * 3 + 2];
            const jitter = 0.97 + 0.06 * hash3(Math.floor(sx), Math.floor(sy), Math.floor(sz));
            const before = vc;
            if (diagonalScore(c0, c1, c2, c3) >= diagonalScore(c1, c2, c3, c0)) {
              vc = flatTri(c0, c1, c2, mat, jitter, vc);
              vc = flatTri(c0, c2, c3, mat, jitter, vc);
            } else {
              vc = flatTri(c1, c2, c3, mat, jitter, vc);
              vc = flatTri(c1, c3, c0, mat, jitter, vc);
            }
            ensure(0, ic + 6);
            for (let k = before; k < vc; k++) idx[ic++] = k;
            continue;
          }

          ensure(0, ic + 6);
          idx[ic++] = c0; idx[ic++] = c1; idx[ic++] = c2;
          idx[ic++] = c0; idx[ic++] = c2; idx[ic++] = c3;
        }
      }
    }
  }
  if (ic === 0) return null;

  return {
    positions: pos.slice(0, vc * 3),
    normals: nrm.slice(0, vc * 3),
    colors: col.slice(0, vc * 3),
    light: lit.slice(0, vc * 2),
    indices: idx.slice(0, ic),
  };
}

const fn = [0, 0, 0];

/** Unnormalized face normal of triangle (a,b,c) into fn; returns its length. */
function faceNormal(a: number, b: number, c: number): number {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
  const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
  fn[0] = uy * vz - uz * vy;
  fn[1] = uz * vx - ux * vz;
  fn[2] = ux * vy - uy * vx;
  return Math.hypot(fn[0], fn[1], fn[2]);
}

/** How coplanar the triangles (a,b,c) and (a,c,d) are (1 = flat). */
function diagonalScore(a: number, b: number, c: number, d: number): number {
  const l1 = faceNormal(a, b, c);
  if (l1 < 1e-9) return -2;
  const n1x = fn[0] / l1, n1y = fn[1] / l1, n1z = fn[2] / l1;
  const l2 = faceNormal(a, c, d);
  if (l2 < 1e-9) return -2;
  return (n1x * fn[0] + n1y * fn[1] + n1z * fn[2]) / l2;
}

/** Append a flat-shaded triangle copying the positions of cell vertices a, b, c. */
function flatTri(a: number, b: number, c: number, mat: number, jitter: number, vc: number): number {
  ensure(vc + 3, 0);
  const l = faceNormal(a, b, c);
  if (l < 1e-6) return vc; // degenerate (two vertices snapped together)
  const nx = fn[0] / l, ny = fn[1] / l, nz = fn[2] / l;
  const r = MATERIAL_LINEAR[mat * 3] * jitter, g = MATERIAL_LINEAR[mat * 3 + 1] * jitter, bl = MATERIAL_LINEAR[mat * 3 + 2] * jitter;
  for (const v of [a, b, c]) {
    const o = vc * 3;
    pos[o] = pos[v * 3]; pos[o + 1] = pos[v * 3 + 1]; pos[o + 2] = pos[v * 3 + 2];
    nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
    col[o] = r; col[o + 1] = g; col[o + 2] = bl;
    lit[vc * 2] = 1;
    lit[vc * 2 + 1] = mat === M.LAMP ? 1 : 0;
    vc++;
  }
  return vc;
}

function cell(x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || z < 0 || x >= C || y >= C || z >= C) return -1;
  return cellVert[x + (y + z * C) * C];
}
