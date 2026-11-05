import * as THREE from 'three';
import { CAVE_DEPTH, CHUNK, H_MAX, H_MIN, MAX_LEVEL, PAD, PLANET_RADIUS as R, SPLIT_K, TREE_MAX } from '../config';
import { ChunkResult } from './job';
import { getSeed } from './planet';
import { VoxelStore, chunkKey } from './VoxelStore';
import { WorkerPool } from './WorkerPool';

interface Node {
  key: string;
  level: number;
  cx: number;
  cy: number;
  cz: number;
  mesh: THREE.Mesh | null;
  /** Has a finished result (possibly empty) been displayed for this node? */
  ready: boolean;
  /** A job is in flight for this version. */
  pending: number;
  version: number;
  wanted: boolean;
  queued: boolean;
  priority: number;
}

const nodeKey = (l: number, x: number, y: number, z: number) => `${l}:${x},${y},${z}`;

/**
 * Octree level-of-detail terrain around a moving viewer. Leaves near the viewer are 32^3 voxel
 * chunks at full resolution; each level up doubles the voxel size. Old meshes stay visible until
 * their replacements are ready, so the world never shows holes while streaming.
 */
export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.Material;
  private nodes = new Map<string, Node>();
  private queue: Node[] = [];
  private nextJobId = 1;
  private lastViewer = new THREE.Vector3(Infinity, 0, 0);
  private viewer = new THREE.Vector3();
  private reselect = false;
  private lastSelect = 0;
  triangles = 0;
  jobsDone = 0;
  jobMs = 0;

  constructor(private pool: WorkerPool, readonly store: VoxelStore, material: THREE.Material) {
    this.material = material;
    this.group.name = 'terrain';
  }

  /** Recompute the desired octree leaves when the viewer has moved enough. */
  update(viewer: THREE.Vector3, force = false, pumpMs = 8) {
    this.viewer.copy(viewer);
    const now = performance.now();
    if (force || viewer.distanceToSquared(this.lastViewer) > 4 * 4 || (this.reselect && now - this.lastSelect > 120)) {
      this.lastViewer.copy(viewer);
      this.lastSelect = now;
      this.reselect = false;
      this.select();
    }
    this.dispatch();
    this.pool.pump(pumpMs);
  }

  private select() {
    for (const n of this.nodes.values()) n.wanted = false;
    const rootCount = 1;
    for (let z = -rootCount; z < rootCount; z++)
      for (let y = -rootCount; y < rootCount; y++)
        for (let x = -rootCount; x < rootCount; x++) this.visit(MAX_LEVEL, x, y, z);

    // Drop unwanted nodes once their area is covered by ready replacements.
    const wanted: Node[] = [];
    for (const n of this.nodes.values()) if (n.wanted) wanted.push(n);
    for (const n of [...this.nodes.values()]) {
      if (n.wanted) continue;
      if (!n.ready || this.coveredByReady(n, wanted)) this.remove(n);
    }
    this.queue = wanted.filter((n) => n.queued);
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  private visit(level: number, cx: number, cy: number, cz: number) {
    const size = CHUNK << level;
    const x0 = cx * size, y0 = cy * size, z0 = cz * size;
    // Radial shell test: skip nodes that are entirely above the terrain or deep inside the planet.
    const nx = clamp(0, x0, x0 + size), ny = clamp(0, y0, y0 + size), nz = clamp(0, z0, z0 + size);
    const rmin = Math.hypot(nx, ny, nz);
    const rmax = Math.hypot(Math.max(Math.abs(x0), Math.abs(x0 + size)), Math.max(Math.abs(y0), Math.abs(y0 + size)), Math.max(Math.abs(z0), Math.abs(z0 + size)));
    const pad = 2 << level;
    if (rmin > R + H_MAX + TREE_MAX + pad || rmax < R + H_MIN - CAVE_DEPTH - pad) return;

    const v = this.viewer;
    const dx = Math.max(x0 - v.x, 0, v.x - x0 - size);
    const dy = Math.max(y0 - v.y, 0, v.y - y0 - size);
    const dz = Math.max(z0 - v.z, 0, v.z - z0 - size);
    const dist = Math.hypot(dx, dy, dz);

    if (level > 0 && dist < SPLIT_K * size) {
      for (let k = 0; k < 8; k++) this.visit(level - 1, cx * 2 + (k & 1), cy * 2 + ((k >> 1) & 1), cz * 2 + ((k >> 2) & 1));
      return;
    }
    const key = nodeKey(level, cx, cy, cz);
    let n = this.nodes.get(key);
    if (!n) {
      n = { key, level, cx, cy, cz, mesh: null, ready: false, pending: 0, version: 0, wanted: true, queued: true, priority: 0 };
      this.nodes.set(key, n);
    }
    n.wanted = true;
    n.priority = dist / size + (level === 0 ? -1 : 0);
  }

  /** Is the area of a stale node fully covered by wanted nodes that are ready? */
  private coveredByReady(stale: Node, wanted: Node[]): boolean {
    const s = CHUNK << stale.level;
    const x0 = stale.cx * s, y0 = stale.cy * s, z0 = stale.cz * s;
    for (const w of wanted) {
      const ws = CHUNK << w.level;
      const wx = w.cx * ws, wy = w.cy * ws, wz = w.cz * ws;
      if (wx >= x0 + s || wy >= y0 + s || wz >= z0 + s || wx + ws <= x0 || wy + ws <= y0 || wz + ws <= z0) continue;
      if (!w.ready) return false;
    }
    return true;
  }

  private remove(n: Node) {
    this.dropMeshes(n);
    this.nodes.delete(n.key);
  }

  private dropMeshes(n: Node) {
    const m = n.mesh;
    if (!m) return;
    this.triangles -= m.geometry.index!.count / 3;
    m.geometry.dispose();
    this.group.remove(m);
    n.mesh = null;
  }

  private addMesh(n: Node, attrs: Record<string, THREE.BufferAttribute>, index: Uint32Array, material: THREE.Material): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, a);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    const size = CHUNK << n.level;
    mesh.position.set(n.cx * size, n.cy * size, n.cz * size);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.triangles += index.length / 3;
    return mesh;
  }

  private dispatch() {
    while (this.queue.length && this.pool.available > 0) {
      const n = this.queue.shift()!;
      if (!n.wanted || !n.queued || this.nodes.get(n.key) !== n) continue;
      this.submit(n);
    }
  }

  private submit(n: Node) {
    n.queued = false;
    n.pending = n.version;
    const size = CHUNK << n.level;
    const stride = 1 << n.level;
    const ox = n.cx * size, oy = n.cy * size, oz = n.cz * size;
    const overlays = this.store.overlaysIn(
      ox - PAD * stride, oy - PAD * stride, oz - PAD * stride,
      ox + size + PAD * stride, oy + size + PAD * stride, oz + size + PAD * stride,
    );
    const job = { id: this.nextJobId++, seed: getSeed(), level: n.level, ox, oy, oz, overlays, wantCore: n.level === 0 };
    const version = n.version;
    this.pool.submit(job, (r) => this.onResult(n, version, r));
  }

  private onResult(n: Node, version: number, r: ChunkResult) {
    this.jobsDone++;
    this.jobMs += r.ms;
    if (r.core && n.level === 0) this.store.receive(n.cx, n.cy, n.cz, r.core);
    if (this.nodes.get(n.key) !== n || version !== n.version) return; // stale
    this.dropMeshes(n);
    if (r.mesh) {
      n.mesh = this.addMesh(n, {
        position: new THREE.BufferAttribute(r.mesh.positions, 3),
        normal: new THREE.BufferAttribute(r.mesh.normals, 3),
        color: new THREE.BufferAttribute(r.mesh.colors, 3),
      }, r.mesh.indices, this.material);
      n.mesh.castShadow = n.level <= 1;
      n.mesh.receiveShadow = true;
    }
    n.ready = true;
    // Newly ready nodes may let stale ones go.
    this.reselect = true;
  }

  /** Rebuild LOD0 nodes after an edit, ahead of everything else. */
  remesh(dirtyChunks: Set<number>) {
    for (const n of this.nodes.values()) {
      if (n.level !== 0 || !dirtyChunks.has(chunkKey(n.cx, n.cy, n.cz))) continue;
      n.version++;
      n.queued = true;
      n.priority = -100;
      this.queue.unshift(n);
    }
  }

  /** Fraction of wanted nodes that are ready (for the loading screen). */
  progress(): { ready: number; total: number } {
    let ready = 0, total = 0;
    for (const n of this.nodes.values()) {
      if (!n.wanted) continue;
      total++;
      if (n.ready) ready++;
    }
    return { ready, total };
  }

  get pendingJobs() {
    return this.queue.length + this.pool.busy;
  }

  get meshCount() {
    return this.group.children.length;
  }

  /** Are all wanted nodes up to `level` ready? Used to decide when the player can start. */
  readyUpTo(level: number): boolean {
    for (const n of this.nodes.values()) if (n.wanted && n.level <= level && !n.ready) return false;
    return this.nodes.size > 0;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
