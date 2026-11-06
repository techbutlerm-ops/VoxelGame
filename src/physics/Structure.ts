import { VoxelStore } from '../world/VoxelStore';
import { M } from '../world/materials';

/** A solid region that lost contact with the ground. */
export interface Component {
  /** Flat x,y,z voxel list. */
  voxels: Int32Array;
  keys: Set<number>;
  min: [number, number, number];
  max: [number, number, number];
}

const OFF = 32768;
const K = 65536;
export const voxelKey = (x: number, y: number, z: number) => ((x + OFF) * K + (y + OFF)) * K + (z + OFF);

/** Fills that grow beyond this are treated as part of the ground (too big to move anyway). */
export const MAX_FALLING = 40000;

const TREE = new Set<number>([M.WOOD, M.LEAVES, M.PINE, M.CACTUS]);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Find solid regions next to removed voxels that are no longer connected to the ground.
 * Flood-fills (6-connected) from every solid neighbour of a removed voxel. A fill is grounded as
 * soon as it reaches untouched natural ground: a solid voxel in a chunk that was never edited,
 * other than tree wood/leaves (so cutting a trunk fells the tree). Fills that grow past
 * MAX_FALLING are treated as grounded too.
 */
export function findFloating(store: VoxelStore, removed: number[]): Component[] {
  const owner = new Map<number, number>(); // voxel key -> fill id
  const grounded: boolean[] = [];
  const result: Component[] = [];

  for (let r = 0; r < removed.length; r += 3) {
    for (const [dx, dy, dz] of N6) {
      const sx = removed[r] + dx, sy = removed[r + 1] + dy, sz = removed[r + 2] + dz;
      const sk = voxelKey(sx, sy, sz);
      if (owner.has(sk) || !store.solid(sx, sy, sz)) continue;

      const fill = grounded.length;
      grounded.push(false);
      // Visit voxels closest to the planet centre first: ground is down, so a supported region
      // usually proves itself within a few dozen steps instead of flooding a whole chunk.
      const qx: number[] = [], qy: number[] = [], qz: number[] = [];
      const heap = new MinHeap();
      const push = (x: number, y: number, z: number) => {
        qx.push(x); qy.push(y); qz.push(z);
        heap.push(qx.length - 1, x * x + y * y + z * z);
      };
      const keys = new Set<number>([sk]);
      owner.set(sk, fill);
      push(sx, sy, sz);
      let ground = false;
      while (heap.size && !ground) {
        const q = heap.pop();
        const x = qx[q], y = qy[q], z = qz[q];
        if (!store.editedAt(x, y, z) && !TREE.has(store.material(x, y, z))) { ground = true; break; }
        for (const [nx, ny, nz] of N6) {
          const X = x + nx, Y = y + ny, Z = z + nz;
          const k = voxelKey(X, Y, Z);
          const o = owner.get(k);
          if (o !== undefined) {
            if (o !== fill && grounded[o]) { ground = true; break; }
            continue;
          }
          if (!store.solid(X, Y, Z)) continue;
          owner.set(k, fill);
          keys.add(k);
          push(X, Y, Z);
        }
        if (qx.length > MAX_FALLING) ground = true;
      }
      grounded[fill] = ground;
      if (ground) continue;

      const n = qx.length;
      const voxels = new Int32Array(n * 3);
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) {
        voxels[i * 3] = qx[i]; voxels[i * 3 + 1] = qy[i]; voxels[i * 3 + 2] = qz[i];
        if (qx[i] < min[0]) min[0] = qx[i]; if (qx[i] > max[0]) max[0] = qx[i];
        if (qy[i] < min[1]) min[1] = qy[i]; if (qy[i] > max[1]) max[1] = qy[i];
        if (qz[i] < min[2]) min[2] = qz[i]; if (qz[i] > max[2]) max[2] = qz[i];
      }
      result.push({ voxels, keys, min, max });
    }
  }
  return result;
}

/** Binary min-heap of integer ids keyed by number. */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!, lastKey = keys.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lastKey;
        if (l < n && keys[l] < mk) { m = l; mk = keys[l]; }
        if (r < n && keys[r] < mk) { m = r; mk = keys[r]; }
        if (m === i) break;
        ids[i] = ids[m]; keys[i] = keys[m];
        i = m;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}
