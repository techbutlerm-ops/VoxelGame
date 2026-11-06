import { PLANET_RADIUS as R, H_MAX, H_MIN } from '../config';
import { M } from './materials';
import { Simplex, hash3 } from './noise';

// ---------------------------------------------------------------------------------------------
// Planet surface: a height field over the unit sphere, sampled with 3D noise so there are no
// seams or polar distortion. Everything here is pure and deterministic so it can run in workers.
// ---------------------------------------------------------------------------------------------

export const B = {
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  DESERT: 4,
  TUNDRA: 5,
  TAIGA: 6,
  MOUNTAIN: 7,
} as const;

export const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Tundra', 'Taiga', 'Mountains'];

export const enum TreeKind {
  None = 0,
  Oak = 1,
  Pine = 2,
  Cactus = 3,
}

interface Noises {
  cont: Simplex;
  hills: Simplex;
  mreg: Simplex;
  ridge: Simplex;
  temp: Simplex;
  moist: Simplex;
  dune: Simplex;
  detail: Simplex;
  caveA: Simplex;
  caveB: Simplex;
  cavern: Simplex;
}

let seed = 1337;
let N: Noises = makeNoises(seed);

function makeNoises(s: number): Noises {
  return {
    cont: new Simplex(s + 11),
    hills: new Simplex(s + 12),
    mreg: new Simplex(s + 13),
    ridge: new Simplex(s + 14),
    temp: new Simplex(s + 15),
    moist: new Simplex(s + 16),
    dune: new Simplex(s + 17),
    detail: new Simplex(s + 18),
    caveA: new Simplex(s + 19),
    caveB: new Simplex(s + 20),
    cavern: new Simplex(s + 21),
  };
}

export function setSeed(s: number) {
  if (s === seed) return;
  seed = s;
  N = makeNoises(s);
  treeCache.clear();
}

export function getSeed() {
  return seed;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Surface {
  /** Height above sea level in voxels. */
  h: number;
  biome: number;
  top: number;
  sub: number;
  temp: number;
  moist: number;
}

/** Evaluate the terrain at unit direction (x,y,z). */
export function surfaceAt(x: number, y: number, z: number, out: Surface): Surface {
  const px = x * R, py = y * R, pz = z * R;

  // Continents: negative is ocean.
  const cont = N.cont.fbm3(px / 16000, py / 16000, pz / 16000, 5) * 1.7 + 0.12;
  const land = smoothstep(-0.05, 0.2, cont);
  let h = cont < 0 ? Math.max(H_MIN + 40, cont * 700) : (1 - Math.exp(-cont * 4)) * 140;

  // Rolling hills everywhere on land.
  const hills = N.hills.fbm3(px / 1600, py / 1600, pz / 1600, 4);

  // Mountain ranges in continental interiors.
  const mreg = smoothstep(0.12, 0.5, cont + N.mreg.fbm3(px / 9000, py / 9000, pz / 9000, 3) * 0.7);
  const ridge = mreg > 0 ? N.ridge.ridged3(px / 3200, py / 3200, pz / 3200, 5) : 0;
  const mountain = mreg * Math.pow(ridge, 1.6);

  // Climate: equator is warm, poles are cold; noise makes the bands irregular.
  const moist = N.moist.fbm3(px / 5000 + 100, py / 5000, pz / 5000, 3) * 1.6;
  let temp = 1 - 1.25 * Math.abs(y) + N.temp.fbm3(px / 7000, py / 7000, pz / 7000, 3) * 0.5;

  const desert = smoothstep(0.55, 0.72, temp) * smoothstep(0.05, -0.15, moist) * land;
  let dunes = 0;
  if (desert > 0) {
    const d = 1 - Math.abs(N.dune.noise3(px / 520, py / 380, pz / 520));
    dunes = d * d * 40 * desert;
  }

  h += hills * (10 + 45 * land) * (1 - 0.6 * desert);
  h += mountain * 980;
  h += dunes;
  h += N.detail.noise3(px / 180, py / 180, pz / 180) * 5 * (0.4 + land);
  h = Math.min(H_MAX - 60, h);

  temp -= Math.max(0, h) / 1400;

  let biome: number;
  if (h < -8) biome = B.OCEAN;
  else if (h < 12 && cont < 0.12) biome = B.BEACH;
  else if (mountain > 0.3 || h > 650) biome = B.MOUNTAIN;
  else if (temp < 0.18) biome = moist > -0.05 ? B.TAIGA : B.TUNDRA;
  else if (desert > 0.5) biome = B.DESERT;
  else if (moist > 0.1) biome = B.FOREST;
  else biome = B.PLAINS;

  let top: number, sub: number;
  switch (biome) {
    case B.OCEAN: top = h < -140 ? M.GRAVEL : M.SAND; sub = M.SAND; break;
    case B.BEACH: top = M.SAND; sub = M.SAND; break;
    case B.FOREST: top = M.FOREST_FLOOR; sub = M.DIRT; break;
    case B.DESERT: top = M.SAND; sub = M.SANDSTONE; break;
    case B.TUNDRA: top = temp < 0.05 ? M.SNOW : M.COLD_GRASS; sub = M.DIRT; break;
    case B.TAIGA: top = M.SNOW; sub = M.DIRT; break;
    case B.MOUNTAIN: {
      const snowLine = 700 + N.detail.noise3(px / 300, py / 300, pz / 300) * 90 - Math.max(0, 0.4 - temp) * 900;
      top = h > snowLine ? M.SNOW : M.STONE;
      sub = M.STONE;
      break;
    }
    default: top = M.MEADOW; sub = M.DIRT;
  }

  out.h = h;
  out.biome = biome;
  out.top = top;
  out.sub = sub;
  out.temp = temp;
  out.moist = moist;
  return out;
}

/**
 * Material at a given depth below the surface (depth in voxels, >= 0). Layers thicken with the
 * sample stride so coarse LODs, whose nearest solid sample can be several voxels deep, still
 * show the surface material.
 */
export function layerMaterial(top: number, sub: number, depth: number, stride = 1): number {
  const extra = (stride - 1) * 1.8;
  if (depth < 2.2 + extra) return top;
  if (depth < 14 + extra) return sub;
  if (depth < 170 + extra) return M.STONE;
  return M.DARK_STONE;
}

/** Signed cave field at absolute voxel position: negative inside a cave. Only valid below ground. */
export function caveField(px: number, py: number, pz: number, depth: number): number {
  const a = N.caveA.noise3(px / 90, py / 70, pz / 90);
  const b = N.caveB.noise3(px / 90, py / 70, pz / 90);
  const thr = 0.14 * smoothstep(2, 30, depth);
  let f = (Math.sqrt(a * a + b * b) - thr) * 45;
  const c = N.cavern.noise3(px / 220, py / 140, pz / 220);
  f = Math.min(f, (0.6 - c) * 90 * smoothstep(20, 60, depth) + (1 - smoothstep(20, 60, depth)) * 100);
  return f;
}

// ---------------------------------------------------------------------------------------------
// Cube-sphere face coordinates. A direction maps to one of 6 faces and two coordinates in
// [-1, 1] (tangent-adjusted gnomonic, so cells are close to uniform size on the sphere).
// ---------------------------------------------------------------------------------------------

const QUARTER_PI = Math.PI / 4;
const INV_QUARTER_PI = 4 / Math.PI;

export interface FaceCoord {
  face: number;
  a: number;
  b: number;
}

export function majorAxis(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}

/** Face coordinates of a point relative to a given major axis/face (point need not be normalized). */
export function faceCoordsOn(face: number, x: number, y: number, z: number, out: FaceCoord): FaceCoord {
  const m = face >> 1;
  let pm: number, pu: number, pv: number;
  if (m === 0) { pm = x; pu = y; pv = z; }
  else if (m === 1) { pm = y; pu = z; pv = x; }
  else { pm = z; pu = x; pv = y; }
  const inv = 1 / Math.abs(pm);
  out.face = face;
  out.a = Math.atan(pu * inv) * INV_QUARTER_PI;
  out.b = Math.atan(pv * inv) * INV_QUARTER_PI;
  return out;
}

export function faceOf(x: number, y: number, z: number): number {
  const m = majorAxis(x, y, z);
  const s = m === 0 ? x : m === 1 ? y : z;
  return m * 2 + (s >= 0 ? 0 : 1);
}

/** Unit direction for face coordinates. */
export function faceDir(face: number, a: number, b: number, out: Float64Array | number[]): void {
  const m = face >> 1;
  const s = face & 1 ? -1 : 1;
  const u = Math.tan(a * QUARTER_PI), v = Math.tan(b * QUARTER_PI);
  let x: number, y: number, z: number;
  if (m === 0) { x = s; y = u; z = v; }
  else if (m === 1) { y = s; z = u; x = v; }
  else { z = s; x = u; y = v; }
  const l = 1 / Math.hypot(x, y, z);
  out[0] = x * l;
  out[1] = y * l;
  out[2] = z * l;
}

// ---------------------------------------------------------------------------------------------
// Trees: one candidate per lattice cell on each cube face, jittered, chosen by biome.
// Trees are signed distance fields merged into the terrain density, so they are real voxels.
// ---------------------------------------------------------------------------------------------

export const TREE_SPACING = 30;
/** Lattice step in face coordinates so that the smallest cell is about TREE_SPACING voxels. */
export const TREE_DA = TREE_SPACING / (R * QUARTER_PI) / 0.72;

export interface Tree {
  kind: TreeKind;
  bx: number; by: number; bz: number; // base point
  ux: number; uy: number; uz: number; // up
  tx: number; ty: number; tz: number; // tangent
  sx: number; sy: number; sz: number; // bitangent
  height: number;
  trunk: number;
  crown: number;
  seed: number;
}

const treeCache = new Map<number, Tree | null>();
const tmpSurf: Surface = { h: 0, biome: 0, top: 0, sub: 0, temp: 0, moist: 0 };
const tmpDir = new Float64Array(3);

function treeChance(biome: number): number {
  switch (biome) {
    case B.FOREST: return 0.75;
    case B.TAIGA: return 0.5;
    case B.PLAINS: return 0.07;
    case B.TUNDRA: return 0.04;
    case B.DESERT: return 0.05;
    case B.MOUNTAIN: return 0.05;
    default: return 0;
  }
}

export function treeAt(face: number, ia: number, ib: number): Tree | null {
  const key = (face * 4096 + ia + 2048) * 4096 + ib + 2048;
  const cached = treeCache.get(key);
  if (cached !== undefined) return cached;
  if (treeCache.size > 60000) treeCache.clear();

  let tree: Tree | null = null;
  const roll = hash3(ia, ib, face * 7919 + seed);
  if (roll < 0.75) {
    const ja = (ia + 0.25 + 0.5 * hash3(ia, ib, face + 101 + seed)) * TREE_DA;
    const jb = (ib + 0.25 + 0.5 * hash3(ia, ib, face + 202 + seed)) * TREE_DA;
    if (Math.abs(ja) <= 1 && Math.abs(jb) <= 1) {
      faceDir(face, ja, jb, tmpDir);
      const s = surfaceAt(tmpDir[0], tmpDir[1], tmpDir[2], tmpSurf);
      if (s.h > 3 && roll < treeChance(s.biome) && !(s.biome === B.MOUNTAIN && s.top === M.SNOW)) {
        const r2 = hash3(ia, ib, face + 303 + seed);
        let kind: TreeKind;
        if (s.biome === B.DESERT) kind = TreeKind.Cactus;
        else if (s.biome === B.TAIGA || s.biome === B.TUNDRA || s.biome === B.MOUNTAIN) kind = TreeKind.Pine;
        else if (s.biome === B.FOREST && r2 < 0.2) kind = TreeKind.Pine;
        else kind = TreeKind.Oak;

        const ux = tmpDir[0], uy = tmpDir[1], uz = tmpDir[2];
        // Tangent frame: any vector perpendicular to up.
        let tx = -uz, ty = 0, tz = ux;
        if (Math.abs(uy) > 0.9) { tx = 1; ty = 0; tz = 0; }
        const d = tx * ux + ty * uy + tz * uz;
        tx -= d * ux; ty -= d * uy; tz -= d * uz;
        const tl = 1 / Math.hypot(tx, ty, tz);
        tx *= tl; ty *= tl; tz *= tl;
        const sx = uy * tz - uz * ty, sy = uz * tx - ux * tz, sz = ux * ty - uy * tx;

        const r = R + s.h - 1.5;
        const size = 0.8 + 0.4 * r2;
        tree = {
          kind,
          bx: ux * r, by: uy * r, bz: uz * r,
          ux, uy, uz, tx, ty, tz, sx, sy, sz,
          height: kind === TreeKind.Cactus ? 12 + 10 * r2 : kind === TreeKind.Pine ? 34 * size + 8 : 24 * size + 6,
          trunk: kind === TreeKind.Cactus ? 1.8 : kind === TreeKind.Pine ? 1.4 : 1.7 + 0.6 * r2,
          crown: kind === TreeKind.Pine ? 8 + 3 * r2 : 9 + 3 * r2,
          seed: r2,
        };
      }
    }
  }
  treeCache.set(key, tree);
  return tree;
}

/** Signed distance from a point to a capsule segment a->b with radius r. */
function capsule(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export interface TreeSample {
  /** Signed distance (negative inside). */
  d: number;
  mat: number;
}

/** Evaluate a tree's signed distance at point p. Fills `out` only if closer than out.d. */
export function sampleTree(t: Tree, px: number, py: number, pz: number, lod: number, out: TreeSample) {
  const dx = px - t.bx, dy = py - t.by, dz = pz - t.bz;
  const along = dx * t.ux + dy * t.uy + dz * t.uz;
  if (along < -6 || along > t.height + t.crown + 4) return;
  const lx = dx * t.tx + dy * t.ty + dz * t.tz;
  const lz = dx * t.sx + dy * t.sy + dz * t.sz;
  const rad = Math.hypot(lx, lz);
  if (rad > t.crown + 9) return;

  const H = t.height;
  if (t.kind === TreeKind.Cactus) {
    let d = capsule(lx, along, lz, 0, -4, 0, 0, H, 0, t.trunk);
    const armH = H * 0.45, dir = t.seed > 0.5 ? 1 : -1;
    d = smin(d, capsule(lx, along, lz, 0, armH, 0, 4.5 * dir, armH + 1, 0, 1.2), 2);
    d = smin(d, capsule(lx, along, lz, 4.5 * dir, armH + 1, 0, 4.5 * dir, armH + 6, 0, 1.2), 2);
    if (d < out.d) { out.d = d; out.mat = M.CACTUS; }
    return;
  }

  // Trunk; thickened at coarse LODs so distant canopies don't float.
  {
    const taper = Math.max(t.trunk * (1 - 0.35 * Math.max(0, along) / H), (1 << lod) * 0.6);
    const flare = along < 2 ? (2 - along) * 0.35 : 0;
    const dTrunk = Math.max(rad - taper - flare, -along - 6, along - H);
    if (dTrunk < out.d) { out.d = dTrunk; out.mat = M.WOOD; }
  }

  if (t.kind === TreeKind.Pine) {
    const c0 = 6, c1 = H + 6;
    if (along > c0 - 2) {
      const tt = Math.max(0, Math.min(1, (along - c0) / (c1 - c0)));
      const tier = 0.75 + 0.25 * (1 - ((tt * 4) % 1));
      const coneR = t.crown * (1 - tt) * tier;
      const d = Math.max((rad - coneR) * 0.8, c0 - along, along - c1);
      if (d < out.d) { out.d = d; out.mat = M.PINE; }
    }
  } else {
    // Oak: a cluster of three blobs with some lumpiness.
    const cy = H + 1;
    const r = t.crown;
    const o = r * 0.55;
    let d = Math.hypot(lx, along - cy - 2, lz) - r;
    d = smin(d, Math.hypot(lx - o, along - cy + 1, lz - o * 0.3) - r * 0.8, 4);
    d = smin(d, Math.hypot(lx + o * 0.6, along - cy, lz + o) - r * 0.78, 4);
    d += Math.sin(px * 0.45) * Math.sin(py * 0.41) * Math.sin(pz * 0.43) * 1.2;
    if (d < out.d) { out.d = d; out.mat = M.LEAVES; }
  }
}

// ---------------------------------------------------------------------------------------------
// Build frames: flat, level building grids anchored on a lattice of face coordinates (one anchor
// every ~128 m). Shared by the tools (placing pieces) and the mesher (snapping normals).
// ---------------------------------------------------------------------------------------------

export const ANCHOR_SPACING = 512;
const ANCHOR_DA = ANCHOR_SPACING / (R * QUARTER_PI);
const anchorFc: FaceCoord = { face: 0, a: 0, b: 0 };
const anchorDir = new Float64Array(3);

export interface FrameAxes {
  key: string;
  /** Origin on the sea-level sphere, then the x, y (up) and z axes. */
  o: [number, number, number];
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
}

const frameCache = new Map<string, FrameAxes>();

/** The build frame governing world position (px, py, pz). */
export function buildFrameAt(px: number, py: number, pz: number): FrameAxes {
  const face = faceOf(px, py, pz);
  faceCoordsOn(face, px, py, pz, anchorFc);
  const ia = Math.round(anchorFc.a / ANCHOR_DA), ib = Math.round(anchorFc.b / ANCHOR_DA);
  const key = `${face}:${ia}:${ib}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const a = Math.max(-1, Math.min(1, ia * ANCHOR_DA)), b = Math.max(-1, Math.min(1, ib * ANCHOR_DA));
  faceDir(face, a, b, anchorDir);
  const y: [number, number, number] = [anchorDir[0], anchorDir[1], anchorDir[2]];
  // X follows the face's first tangent axis, projected flat; Z = X cross Y (right-handed).
  const t = (face >> 1) + 1;
  const ax: [number, number, number] = [t % 3 === 0 ? 1 : 0, t % 3 === 1 ? 1 : 0, t % 3 === 2 ? 1 : 0];
  const dot = ax[0] * y[0] + ax[1] * y[1] + ax[2] * y[2];
  let x: [number, number, number] = [ax[0] - dot * y[0], ax[1] - dot * y[1], ax[2] - dot * y[2]];
  const xl = Math.hypot(x[0], x[1], x[2]);
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const z: [number, number, number] = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const f: FrameAxes = { key, o: [y[0] * R, y[1] * R, y[2] * R], x, y, z };
  frameCache.set(key, f);
  return f;
}
