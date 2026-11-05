import { CHUNK, SAMPLES } from '../config';
import { setSeed } from './planet';
import { MeshData, surfaceNets } from './surfaceNets';
import { Overlay, VOLUME_SIZE, applyOverlays, extractCore, generateVolume } from './volume';

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
  if (r.mesh) t.push(r.mesh.positions.buffer, r.mesh.normals.buffer, r.mesh.colors.buffer, r.mesh.indices.buffer);
  if (r.core && !r.core.uniform) t.push(r.core.density.buffer, r.core.material.buffer);
  return t;
}

export const CORE_SIZE = CHUNK * CHUNK * CHUNK;
export { SAMPLES };
