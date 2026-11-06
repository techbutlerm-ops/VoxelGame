import { VoxelStore } from '../world/VoxelStore';
import { MATERIAL_CONSTRUCT, MATERIAL_STRENGTH } from '../world/materials';
import { Component, voxelKey } from './Structure';

/** Structures bigger than this aren't analysed (too slow for one frame); they stay up. */
const MAX_STRUCTURE = 60000;
/** Hanging below a support costs this much span per voxel of drop. */
const HANG_COST = 0.5;
/** Budget units: a material with this strength spans exactly its strength in voxels. */
const REF_STRENGTH = 12;

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Span-based structural stress for construction materials. Support starts where a building
 * touches natural ground (or rubble) and spreads through the structure; each material can carry
 * a load horizontally for its strength in voxels (metal 8 m, planks 3 m, glass 1 m). Hanging
 * below a support costs extra. Voxels left with no support break off.
 */
export function findOverstressed(store: VoxelStore, seeds: number[]): Component[] {
  // --- Gather the construction voxels connected to the seeds ---
  const index = new Map<number, number>();
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], mats: number[] = [];
  const isConstructSolid = (x: number, y: number, z: number) =>
    store.solid(x, y, z) && MATERIAL_CONSTRUCT[store.material(x, y, z)] === 1;
  const visit = (x: number, y: number, z: number) => {
    const k = voxelKey(x, y, z);
    if (index.has(k) || !isConstructSolid(x, y, z)) return;
    index.set(k, xs.length);
    xs.push(x); ys.push(y); zs.push(z); mats.push(store.material(x, y, z));
  };
  for (let s = 0; s < seeds.length; s += 3) {
    visit(seeds[s], seeds[s + 1], seeds[s + 2]);
    for (const [dx, dy, dz] of N6) visit(seeds[s] + dx, seeds[s + 1] + dy, seeds[s + 2] + dz);
  }
  if (!xs.length) return [];
  const anchors: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs.length > MAX_STRUCTURE) return [];
    let grounded = false;
    for (const [dx, dy, dz] of N6) {
      const X = xs[i] + dx, Y = ys[i] + dy, Z = zs[i] + dz;
      if (!store.solid(X, Y, Z)) continue;
      if (MATERIAL_CONSTRUCT[store.material(X, Y, Z)]) visit(X, Y, Z);
      else grounded = true; // natural ground, tree, or rubble carries load
    }
    if (grounded) anchors.push(i);
  }

  // --- Spread support from the anchors (best-first, highest budget first) ---
  // A voxel's budget is how much span it has left, in units of the reference material. Moving
  // away from the anchor spends budget at the rate of the material doing the spanning: the walk
  // is split into segments where the material changes, and within a segment the cost is the net
  // change in reach (so zig-zag steps on a tilted voxel grid don't add up). A segment never
  // regains budget, which keeps the search monotone.
  const n = xs.length;
  // Float64 on purpose: with Float32 storage, rounding makes the same candidate look like an
  // improvement over and over and the search never finishes.
  const stab = new Float64Array(n).fill(-Infinity);
  const anchorOf = new Int32Array(n).fill(-1);
  const segStart = new Float64Array(n); // potential where the current segment began
  const segBudget = new Float64Array(n); // budget at that point
  const heap = new MaxHeap();
  for (const a of anchors) {
    stab[a] = REF_STRENGTH;
    anchorOf[a] = a;
    segStart[a] = 0;
    segBudget[a] = REF_STRENGTH;
    heap.push(a, REF_STRENGTH);
  }
  const potential = (v: number, a: number) => {
    const ax = xs[a], ay = ys[a], az = zs[a];
    const il = 1 / Math.hypot(ax, ay, az);
    const ox = xs[v] - ax, oy = ys[v] - ay, oz = zs[v] - az;
    const h = (ox * ax + oy * ay + oz * az) * il;
    return Math.sqrt(Math.max(0, ox * ox + oy * oy + oz * oz - h * h)) + Math.max(0, -h) * HANG_COST;
  };
  while (heap.size) {
    const [u, su] = heap.pop();
    if (su < stab[u]) continue; // stale entry
    const a = anchorOf[u];
    const pu = potential(u, a);
    for (const [dx, dy, dz] of N6) {
      const v = index.get(voxelKey(xs[u] + dx, ys[u] + dy, zs[u] + dz));
      if (v === undefined) continue;
      let start = segStart[u], budget = segBudget[u];
      if (mats[v] !== mats[u]) { start = pu; budget = su; }
      const rate = REF_STRENGTH / MATERIAL_STRENGTH[mats[v]];
      const s = Math.min(budget, budget - (potential(v, a) - start) * rate);
      if (s > stab[v] + 1e-9) {
        stab[v] = s;
        anchorOf[v] = a;
        segStart[v] = start;
        segBudget[v] = budget;
        heap.push(v, s);
      }
    }
  }

  // --- Unsupported voxels, grouped into connected pieces ---
  const result: Component[] = [];
  const done = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (done[i] || stab[i] > 0) continue;
    const queue = [i];
    done[i] = 1;
    const keys = new Set<number>();
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      keys.add(voxelKey(xs[u], ys[u], zs[u]));
      min[0] = Math.min(min[0], xs[u]); min[1] = Math.min(min[1], ys[u]); min[2] = Math.min(min[2], zs[u]);
      max[0] = Math.max(max[0], xs[u]); max[1] = Math.max(max[1], ys[u]); max[2] = Math.max(max[2], zs[u]);
      for (const [dx, dy, dz] of N6) {
        const v = index.get(voxelKey(xs[u] + dx, ys[u] + dy, zs[u] + dz));
        if (v === undefined || done[v] || stab[v] > 0) continue;
        done[v] = 1;
        queue.push(v);
      }
    }
    const voxels = new Int32Array(queue.length * 3);
    queue.forEach((u, j) => { voxels[j * 3] = xs[u]; voxels[j * 3 + 1] = ys[u]; voxels[j * 3 + 2] = zs[u]; });
    result.push({ voxels, keys, min, max });
  }
  return result;
}

/** Binary max-heap of (id, priority). */
class MaxHeap {
  private ids: number[] = [];
  private pr: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, p: number) {
    const { ids, pr } = this;
    let i = ids.length;
    ids.push(id); pr.push(p);
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (pr[q] >= p) break;
      ids[i] = ids[q]; pr[i] = pr[q];
      i = q;
    }
    ids[i] = id; pr[i] = p;
  }

  pop(): [number, number] {
    const { ids, pr } = this;
    const top: [number, number] = [ids[0], pr[0]];
    const li = ids.pop()!, lp = pr.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mp = lp;
        if (l < n && pr[l] > mp) { m = l; mp = pr[l]; }
        if (r < n && pr[r] > mp) { m = r; mp = pr[r]; }
        if (m === i) break;
        ids[i] = ids[m]; pr[i] = pr[m];
        i = m;
      }
      ids[i] = li; pr[i] = lp;
    }
    return top;
  }
}
