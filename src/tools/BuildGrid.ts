import * as THREE from 'three';
import { buildFrameAt } from '../world/planet';

/**
 * A flat building grid laid on the planet. Anchors sit on a fixed lattice of cube-sphere face
 * coordinates (one every ~128 m), so the same spot always gets the same grid and builds line up
 * when you come back. Within an anchor cell the grid is planar and level with local "up"; the
 * planet's curvature over 64 m is under 35 cm, which is invisible for buildings.
 */
export interface BuildFrame {
  origin: THREE.Vector3;
  x: THREE.Vector3;
  y: THREE.Vector3; // up
  z: THREE.Vector3;
  key: string;
}

const cache = new Map<string, BuildFrame>();

export function frameAt(p: THREE.Vector3): BuildFrame {
  const f = buildFrameAt(p.x, p.y, p.z);
  let frame = cache.get(f.key);
  if (!frame) {
    frame = {
      origin: new THREE.Vector3(...f.o),
      x: new THREE.Vector3(...f.x),
      y: new THREE.Vector3(...f.y),
      z: new THREE.Vector3(...f.z),
      key: f.key,
    };
    cache.set(f.key, frame);
  }
  return frame;
}

/** World point -> frame coordinates (voxels). */
export function toLocal(f: BuildFrame, p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const dx = p.x - f.origin.x, dy = p.y - f.origin.y, dz = p.z - f.origin.z;
  return out.set(dx * f.x.x + dy * f.x.y + dz * f.x.z, dx * f.y.x + dy * f.y.y + dz * f.y.z, dx * f.z.x + dy * f.z.y + dz * f.z.z);
}

/** Frame coordinates (voxels) -> world point. */
export function toWorld(f: BuildFrame, l: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(f.origin).addScaledVector(f.x, l.x).addScaledVector(f.y, l.y).addScaledVector(f.z, l.z);
}

/** Which way a ramp rises, as a frame axis and sign. */
export interface Rise {
  axis: 0 | 2;
  sign: 1 | -1;
}

/** A grid-aligned piece: a box of cells, optionally cut diagonally into a ramp. */
export interface Piece {
  frame: BuildFrame;
  /** Inclusive-exclusive bounds in voxels, in frame coordinates. */
  min: THREE.Vector3;
  max: THREE.Vector3;
  ramp: Rise | null;
}

/** Signed distance (voxels, negative inside) from a world point to a piece. */
export function pieceSdf(piece: Piece): (x: number, y: number, z: number) => number {
  const f = piece.frame;
  const cx = (piece.min.x + piece.max.x) / 2, cy = (piece.min.y + piece.max.y) / 2, cz = (piece.min.z + piece.max.z) / 2;
  const hx = (piece.max.x - piece.min.x) / 2, hy = (piece.max.y - piece.min.y) / 2, hz = (piece.max.z - piece.min.z) / 2;
  const ox = f.origin.x, oy = f.origin.y, oz = f.origin.z;
  const X = f.x, Y = f.y, Z = f.z;
  const ramp = piece.ramp;
  let run = 0, rise = 0, norm = 1;
  if (ramp) {
    run = ramp.axis === 0 ? 2 * hx : 2 * hz;
    rise = 2 * hy;
    norm = Math.hypot(run, rise);
  }
  return (x, y, z) => {
    const dx = x - ox, dy = y - oy, dz = z - oz;
    const lx = dx * X.x + dy * X.y + dz * X.z - cx;
    const ly = dx * Y.x + dy * Y.y + dz * Y.z - cy;
    const lz = dx * Z.x + dy * Z.y + dz * Z.z - cz;
    const qx = Math.abs(lx) - hx, qy = Math.abs(ly) - hy, qz = Math.abs(lz) - hz;
    let d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
    if (ramp) {
      // u: distance along the rise from the low end; v: height above the bottom.
      const along = ramp.axis === 0 ? lx : lz;
      const u = ramp.sign > 0 ? along + run / 2 : run / 2 - along;
      const v = ly + hy;
      d = Math.max(d, (v * run - u * rise) / norm);
    }
    return d;
  };
}
