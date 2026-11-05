import { CHUNK, DENSITY_CLAMP, PAD } from '../config';
import { CoreData, runJob } from './job';
import { AIR } from './materials';
import { getSeed } from './planet';
import { Overlay, dequantize, quantize } from './volume';

/** Full-resolution voxels of one LOD0 chunk. */
export interface ChunkVoxels {
  ox: number;
  oy: number;
  oz: number;
  /** Quantized density (see volume.quantize), or null when uniform. */
  density: Uint8Array | null;
  material: Uint8Array | null;
  uniformDensity: number;
  uniformMaterial: number;
  edited: boolean;
  lastUsed: number;
}

const OFF = 2048;
export const chunkKey = (cx: number, cy: number, cz: number) => ((cx + OFF) * 4096 + (cy + OFF)) * 4096 + (cz + OFF);

const CHUNK3 = CHUNK * CHUNK * CHUNK;
const MAX_CACHED = 900;

/**
 * Main-thread authority for full-resolution voxels near the player. Chunks arrive from the
 * worker pipeline (or are generated synchronously on a cache miss). Edited chunks are kept
 * forever and are what makes the world persistent.
 */
export class VoxelStore {
  private chunks = new Map<number, ChunkVoxels>();
  /** Keys of chunks that differ from the procedural world. */
  readonly edited = new Set<number>();
  private frame = 0;
  private last: ChunkVoxels | null = null;
  private lastKey = -1;
  syncGenerated = 0;

  tick() {
    this.frame++;
    if (this.chunks.size > MAX_CACHED) this.evict();
  }

  /** Store core data delivered by a worker (ignored if we already hold an edited copy). */
  receive(cx: number, cy: number, cz: number, core: CoreData) {
    const key = chunkKey(cx, cy, cz);
    const existing = this.chunks.get(key);
    if (existing) return;
    this.chunks.set(key, this.fromCore(cx, cy, cz, core));
  }

  private fromCore(cx: number, cy: number, cz: number, core: CoreData): ChunkVoxels {
    return {
      ox: cx * CHUNK, oy: cy * CHUNK, oz: cz * CHUNK,
      density: core.uniform ? null : core.density,
      material: core.uniform ? null : core.material,
      uniformDensity: core.uniform ? core.density : 0,
      uniformMaterial: core.uniform ? core.material : AIR,
      edited: false,
      lastUsed: this.frame,
    };
  }

  has(cx: number, cy: number, cz: number) {
    return this.chunks.has(chunkKey(cx, cy, cz));
  }

  /** Get a chunk, generating it synchronously if it isn't cached yet. */
  chunk(cx: number, cy: number, cz: number): ChunkVoxels {
    const key = chunkKey(cx, cy, cz);
    if (key === this.lastKey && this.last) return this.last;
    let c = this.chunks.get(key);
    if (!c) {
      const r = runJob({ id: -1, seed: getSeed(), level: 0, ox: cx * CHUNK, oy: cy * CHUNK, oz: cz * CHUNK, overlays: [], wantCore: true });
      c = this.fromCore(cx, cy, cz, r.core!);
      this.chunks.set(key, c);
      this.syncGenerated++;
    }
    c.lastUsed = this.frame;
    this.last = c;
    this.lastKey = key;
    return c;
  }

  /** Density at an integer voxel position, in voxels (positive = solid). */
  density(x: number, y: number, z: number): number {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunk(cx, cy, cz);
    if (!c.density) return dequantize(c.uniformDensity);
    return dequantize(c.density[x - c.ox + (y - c.oy + (z - c.oz) * CHUNK) * CHUNK]);
  }

  material(x: number, y: number, z: number): number {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunk(cx, cy, cz);
    if (!c.material) return c.uniformMaterial;
    return c.material[x - c.ox + (y - c.oy + (z - c.oz) * CHUNK) * CHUNK];
  }

  /** Trilinearly interpolated density at a continuous position. */
  sample(x: number, y: number, z: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const tx = x - x0, ty = y - y0, tz = z - z0;
    const c000 = this.density(x0, y0, z0), c100 = this.density(x0 + 1, y0, z0);
    const c010 = this.density(x0, y0 + 1, z0), c110 = this.density(x0 + 1, y0 + 1, z0);
    const c001 = this.density(x0, y0, z0 + 1), c101 = this.density(x0 + 1, y0, z0 + 1);
    const c011 = this.density(x0, y0 + 1, z0 + 1), c111 = this.density(x0 + 1, y0 + 1, z0 + 1);
    const a = c000 + (c100 - c000) * tx, b = c010 + (c110 - c010) * tx;
    const c = c001 + (c101 - c001) * tx, d = c011 + (c111 - c011) * tx;
    const e = a + (b - a) * ty, f = c + (d - c) * ty;
    return e + (f - e) * tz;
  }

  /** Density gradient by central differences (points toward solid). */
  gradient(x: number, y: number, z: number, out: { x: number; y: number; z: number }) {
    const h = 0.5;
    out.x = (this.sample(x + h, y, z) - this.sample(x - h, y, z)) / (2 * h);
    out.y = (this.sample(x, y + h, z) - this.sample(x, y - h, z)) / (2 * h);
    out.z = (this.sample(x, y, z + h) - this.sample(x, y, z - h)) / (2 * h);
    return out;
  }

  /**
   * Apply a smooth edit. `field(x,y,z)` returns the brush's signed distance (negative inside).
   * Digging carves (density = min(d, sdf)); building adds (density = max(d, -sdf)) with `mat`.
   * Returns the keys of LOD0 chunks whose meshes need rebuilding.
   */
  edit(
    min: [number, number, number], max: [number, number, number],
    field: (x: number, y: number, z: number) => number,
    mode: 'dig' | 'build', mat: number,
  ): { changed: number; dirty: Set<number> } {
    const dirty = new Set<number>();
    let changed = 0;
    const x0 = Math.floor(min[0]), y0 = Math.floor(min[1]), z0 = Math.floor(min[2]);
    const x1 = Math.ceil(max[0]), y1 = Math.ceil(max[1]), z1 = Math.ceil(max[2]);
    const touched = new Set<ChunkVoxels>();

    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const sdf = field(x, y, z);
          if (sdf > DENSITY_CLAMP) continue;
          const c = this.chunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK));
          this.materialize(c);
          const i = x - c.ox + (y - c.oy + (z - c.oz) * CHUNK) * CHUNK;
          const old = dequantize(c.density![i]);
          let nd: number;
          if (mode === 'dig') {
            nd = Math.min(old, sdf);
          } else {
            nd = Math.max(old, -sdf);
            if (-sdf > old - 0.5 && -sdf > -1.5) c.material![i] = mat;
          }
          const q = quantize(Math.max(-DENSITY_CLAMP, Math.min(DENSITY_CLAMP, nd)));
          if (q !== c.density![i]) {
            if ((c.density![i] > 128) !== (q > 128)) changed++;
            c.density![i] = q;
            touched.add(c);
          }
        }

    for (const c of touched) {
      c.edited = true;
      this.edited.add(chunkKey(c.ox / CHUNK, c.oy / CHUNK, c.oz / CHUNK));
    }
    if (touched.size) {
      // Any chunk whose padded sample range [-PAD, CHUNK+PAD] overlaps the edit must be remeshed.
      const r0 = (v: number) => Math.ceil((v - CHUNK - PAD) / CHUNK), r1 = (v: number) => Math.floor((v + PAD) / CHUNK);
      for (let cz = r0(z0); cz <= r1(z1); cz++)
        for (let cy = r0(y0); cy <= r1(y1); cy++)
          for (let cx = r0(x0); cx <= r1(x1); cx++) dirty.add(chunkKey(cx, cy, cz));
    }
    return { changed, dirty };
  }

  private materialize(c: ChunkVoxels) {
    if (c.density) return;
    c.density = new Uint8Array(CHUNK3).fill(c.uniformDensity);
    c.material = new Uint8Array(CHUNK3).fill(c.uniformMaterial);
  }

  /** Edited chunks overlapping the voxel box [min, max) (inclusive bounds in voxels). */
  overlaysIn(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Overlay[] {
    const out: Overlay[] = [];
    if (!this.edited.size) return out;
    for (const key of this.edited) {
      const c = this.chunks.get(key)!;
      if (c.ox + CHUNK <= minX || c.oy + CHUNK <= minY || c.oz + CHUNK <= minZ) continue;
      if (c.ox > maxX || c.oy > maxY || c.oz > maxZ) continue;
      out.push({ ox: c.ox, oy: c.oy, oz: c.oz, density: c.density!, material: c.material! });
    }
    return out;
  }

  private evict() {
    const list = [...this.chunks.entries()].filter(([, c]) => !c.edited).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const remove = this.chunks.size - Math.floor(MAX_CACHED * 0.8);
    for (let i = 0; i < remove && i < list.length; i++) this.chunks.delete(list[i][0]);
    this.last = null;
    this.lastKey = -1;
  }

  get size() {
    return this.chunks.size;
  }
}
