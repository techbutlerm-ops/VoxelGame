import { CHUNK, PAD, PLANET_RADIUS, SAMPLES } from '../config';
import { setSeed } from './planet';
import { MeshData, surfaceNets } from './surfaceNets';
import { Overlay, VOLUME_SIZE, applyOverlays, extractCore, generateVolume, latticeHeight } from './volume';

export interface ChunkJob {
  id: number;
  seed: number;
  level: number;
  ox: number;
  oy: number;
  oz: number;
  overlays: Overlay[];
  /** Return the 32^3 core voxel data (LOD0 only) so the main thread can cache it. */
  wantCore: boolean;
}

export type CoreData =
  | { uniform: true; density: number; material: number }
  | { uniform: false; density: Uint8Array; material: Uint8Array };

export interface ChunkResult {
  id: number;
  mesh: MeshData | null;
  core: CoreData | null;
  ms: number;
}

const density = new Float32Array(VOLUME_SIZE);
const material = new Uint8Array(VOLUME_SIZE);

export function runJob(job: ChunkJob): ChunkResult {
  const t0 = performance.now();
  setSeed(job.seed);
  let kind = generateVolume(job.ox, job.oy, job.oz, job.level, density, material);
  if (job.overlays.length) {
    applyOverlays(job.ox, job.oy, job.oz, job.level, density, material, job.overlays);
    kind = 'mixed';
  }
  const mesh = kind === 'mixed' ? surfaceNets(density, material, 1 << job.level, job.ox, job.oy, job.oz) : null;
  if (mesh) bakeSkyLight(mesh, density, 1 << job.level, job.ox, job.oy, job.oz);
  let core: CoreData | null = null;
  if (job.wantCore) {
    if (kind === 'mixed') core = { uniform: false, ...extractCore(density, material) };
    else core = { uniform: true, density: kind === 'solid' ? 255 : 0, material: material[0] };
  }
  return { id: job.id, mesh, core, ms: performance.now() - t0 };
}

/** Transferable buffers of a result, so posting it doesn't copy. */
export function transferables(r: ChunkResult): Transferable[] {
  const t: Transferable[] = [];
  if (r.mesh) t.push(r.mesh.positions.buffer, r.mesh.normals.buffer, r.mesh.colors.buffer, r.mesh.light.buffer, r.mesh.indices.buffer);
  if (r.core && !r.core.uniform) t.push(r.core.density.buffer, r.core.material.buffer);
  return t;
}

export const CORE_SIZE = CHUNK * CHUNK * CHUNK;
export { SAMPLES };

/**
 * Sky exposure per vertex, so caves are dark: full light near the original surface, fading
 * over ~2.5 m deeper down unless nothing solid is overhead (open pits and shafts stay lit).
 */
function bakeSkyLight(mesh: MeshData, density: Float32Array, stride: number, ox: number, oy: number, oz: number) {
  const p = mesh.positions, n = mesh.normals, light = mesh.light;
  const S = SAMPLES;
  for (let v = 0; v < light.length / 2; v++) {
    const wx = ox + p[v * 3], wy = oy + p[v * 3 + 1], wz = oz + p[v * 3 + 2];
    const r = Math.hypot(wx, wy, wz);
    const h = latticeHeight(wx, wy, wz);
    if (h === null) continue;
    const depth = h - (r - PLANET_RADIUS);
    if (depth <= 3) continue;
    // March upward (in sample space) from just off the surface looking for a ceiling.
    const ux = wx / r, uy = wy / r, uz = wz / r;
    let sx = p[v * 3] / stride + PAD + n[v * 3] * 1.2, sy = p[v * 3 + 1] / stride + PAD + n[v * 3 + 1] * 1.2, sz = p[v * 3 + 2] / stride + PAD + n[v * 3 + 2] * 1.2;
    let covered = false;
    for (let step = 0; step < 48; step++) {
      sx += ux; sy += uy; sz += uz;
      const i = Math.round(sx), j = Math.round(sy), k = Math.round(sz);
      if (i < 0 || j < 0 || k < 0 || i >= S || j >= S || k >= S) break;
      if (density[i + (j + k * S) * S] > 0) { covered = true; break; }
    }
    if (covered) light[v * 2] = Math.max(0, Math.min(1, 1 - (depth - 3) / 10));
  }
}
