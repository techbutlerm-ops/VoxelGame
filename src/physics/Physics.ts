import * as THREE from 'three';
import { CHUNK, PAD, PLAYER, SAMPLES } from '../config';
import { surfaceNets } from '../world/surfaceNets';
import { VOLUME_SIZE } from '../world/volume';
import { AIR, MATERIAL_CONSTRUCT, MATERIAL_DENSITY, rubbleOf } from '../world/materials';
import { UndoRecord, VoxelStore } from '../world/VoxelStore';
import { Terrain } from '../world/Terrain';
import { Component, findFloating, voxelKey } from './Structure';
import { findOverstressed } from './Stress';
import { mulberry32 } from '../world/noise';
import type { SavedBody } from '../game/SaveGame';

const MARGIN = 2;
const FRICTION = 0.6;
const RESTITUTION = 0.15;
/** Impact speed (voxels/s along the contact normal) that breaks a body apart: a fall of ~1 m. */
const SHATTER_SPEED = 18;
/** A building that ends up tilted more than this is wrecked: it breaks up before settling. */
const WRECK_TILT = (20 * Math.PI) / 180;
const MAX_BODIES = 64;
/** Detached pieces smaller than this (voxels) vanish as dust instead of falling. */
const MIN_BODY = 8;
const SETTLE_TIME = 0.5;
const MAX_AGE = 14;

const volD = new Float32Array(VOLUME_SIZE);
const volM = new Uint8Array(VOLUME_SIZE);
const tmpG = { x: 0, y: 0, z: 0 };
const TMP_P = new THREE.Vector3();
const TMP_R = new THREE.Vector3();

/**
 * A detached piece of the world. Its voxels live in a local grid (the world grid at the moment it
 * broke off, with a small air margin) and it moves as a rigid body under planet gravity.
 */
export class Body {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  /** Inverse of quat, refreshed whenever the body moves. */
  readonly iquat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  readonly ang = new THREE.Vector3();
  mass = 0;
  /** Centre of mass in grid coordinates. */
  readonly com = new THREE.Vector3();
  readonly invInertiaLocal = new THREE.Matrix3();
  /** Contact sample points relative to the centre of mass (local). */
  points: Float32Array;
  voxelCount = 0;
  /** Contains construction materials (buildings rather than terrain or trees). */
  built = false;
  /** Bounding radius around the centre of mass (voxels). */
  radius = 0;
  /** What set this body falling (an undo entry); fragments inherit it. */
  origin: unknown = null;
  age = 0;
  still = 0;
  impact = 0;

  constructor(
    readonly nx: number, readonly ny: number, readonly nz: number,
    readonly density: Float32Array, readonly material: Uint8Array,
    /** World voxel position of grid (0,0,0) when the body was created (for mesh snapping). */
    readonly worldOrigin: THREE.Vector3,
    readonly generation: number,
  ) {
    this.points = new Float32Array(0);
    this.computeMass();
  }

  index(i: number, j: number, k: number) {
    return i + (j + k * this.ny) * this.nx;
  }

  private computeMass() {
    const { nx, ny, nz, density, material } = this;
    let m = 0, cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const n = this.index(i, j, k);
          if (density[n] <= 0) continue;
          const w = MATERIAL_DENSITY[material[n]];
          m += w; cx += i * w; cy += j * w; cz += k * w;
          this.voxelCount++;
          if (MATERIAL_CONSTRUCT[material[n]]) this.built = true;
        }
    this.mass = Math.max(m, 1e-3);
    this.com.set(cx / this.mass, cy / this.mass, cz / this.mass);

    // Inertia tensor about the centre of mass (each voxel a unit cube), and surface points.
    let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
    const surface: number[] = [];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const n = this.index(i, j, k);
          if (density[n] <= 0) continue;
          const w = MATERIAL_DENSITY[material[n]];
          const x = i - this.com.x, y = j - this.com.y, z = k - this.com.z;
          ixx += w * (y * y + z * z + 1 / 6); iyy += w * (x * x + z * z + 1 / 6); izz += w * (x * x + y * y + 1 / 6);
          ixy -= w * x * y; ixz -= w * x * z; iyz -= w * y * z;
          const open =
            density[this.index(i + 1, j, k)] <= 0 || density[this.index(i - 1, j, k)] <= 0 ||
            density[this.index(i, j + 1, k)] <= 0 || density[this.index(i, j - 1, k)] <= 0 ||
            density[this.index(i, j, k + 1)] <= 0 || density[this.index(i, j, k - 1)] <= 0;
          if (open) surface.push(x, y, z);
        }
    this.radius = Math.hypot(Math.max(this.com.x, nx - this.com.x), Math.max(this.com.y, ny - this.com.y), Math.max(this.com.z, nz - this.com.z));
    const inertia = new THREE.Matrix3().set(ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz);
    this.invInertiaLocal.copy(inertia).invert();

    // Subsample the surface to a bounded number of contact points.
    const count = surface.length / 3;
    const target = Math.min(count, 24 + Math.floor(Math.sqrt(count) * 5), 220);
    const step = count / Math.max(1, target);
    const pts = new Float32Array(target * 3);
    for (let t = 0; t < target; t++) {
      const s = Math.floor(t * step) * 3;
      pts[t * 3] = surface[s]; pts[t * 3 + 1] = surface[s + 1]; pts[t * 3 + 2] = surface[s + 2];
    }
    this.points = pts;
  }

  /** Build render meshes, tiling the grid into mesher-sized blocks. */
  buildMeshes(material: THREE.Material) {
    const S = SAMPLES;
    for (let tz = 0; tz < this.nz; tz += CHUNK)
      for (let ty = 0; ty < this.ny; ty += CHUNK)
        for (let tx = 0; tx < this.nx; tx += CHUNK) {
          let mixed = false;
          const lim = Math.min(S, Math.max(this.nx - tx, this.ny - ty, this.nz - tz) + 2 * PAD + 2);
          volD.fill(-4);
          volM.fill(AIR);
          for (let c = 0; c < lim; c++)
            for (let b = 0; b < lim; b++)
              for (let a = 0; a < lim; a++) {
                const i = tx + a - PAD, j = ty + b - PAD, k = tz + c - PAD;
                const o = a + (b + c * S) * S;
                if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) {
                  volD[o] = -4;
                  volM[o] = AIR;
                } else {
                  const n = this.index(i, j, k);
                  volD[o] = this.density[n];
                  volM[o] = this.material[n];
                  if (volD[o] > 0) mixed = true;
                }
              }
          if (!mixed) continue;
          // Only visit samples that can hold this body's voxels (plus the padding margin).
          const extent = Math.max(this.nx - tx, this.ny - ty, this.nz - tz) + 2 * PAD + 1;
          const m = surfaceNets(volD, volM, 1, this.worldOrigin.x + tx, this.worldOrigin.y + ty, this.worldOrigin.z + tz, extent);
          if (!m) continue;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
          g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
          g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
          g.setAttribute('light', new THREE.BufferAttribute(m.light, 2));
          g.setIndex(new THREE.BufferAttribute(m.indices, 1));
          g.computeBoundingSphere();
          const mesh = new THREE.Mesh(g, material);
          mesh.position.set(tx - this.com.x, ty - this.com.y, tz - this.com.z);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.group.add(mesh);
        }
    this.syncGroup();
  }

  syncGroup() {
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
  }

  dispose() {
    for (const c of this.group.children) (c as THREE.Mesh).geometry.dispose();
    this.group.removeFromParent();
  }

  /** Trilinear density at grid coordinates (outside the grid is air). */
  sample(x: number, y: number, z: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx - 1 || j >= this.ny - 1 || k >= this.nz - 1) return -4;
    const tx = x - i, ty = y - j, tz = z - k;
    const d = this.density;
    const n = this.index(i, j, k), sy = this.nx, sz = this.nx * this.ny;
    const a = d[n] + (d[n + 1] - d[n]) * tx, b = d[n + sy] + (d[n + sy + 1] - d[n + sy]) * tx;
    const c = d[n + sz] + (d[n + sz + 1] - d[n + sz]) * tx, e = d[n + sz + sy] + (d[n + sz + sy + 1] - d[n + sz + sy]) * tx;
    const f = a + (b - a) * ty, g = c + (e - c) * ty;
    return f + (g - f) * tz;
  }

  /** Inverse inertia tensor in world space. */
  invInertiaWorld(out = new THREE.Matrix3()): THREE.Matrix3 {
    const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.quat));
    return out.copy(R).multiply(this.invInertiaLocal).multiply(R.transpose());
  }

  /** World point -> grid coordinates. */
  toGrid(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(p).sub(this.pos).applyQuaternion(this.iquat).add(this.com);
  }

  /** Density gradient at grid coordinates, rotated to world space (points into the body). */
  gradientWorld(g: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const h = 0.5;
    out.set(
      this.sample(g.x + h, g.y, g.z) - this.sample(g.x - h, g.y, g.z),
      this.sample(g.x, g.y + h, g.z) - this.sample(g.x, g.y - h, g.z),
      this.sample(g.x, g.y, g.z + h) - this.sample(g.x, g.y, g.z - h),
    );
    return out.applyQuaternion(this.quat);
  }

  /** Velocity of the body at a world point. */
  pointVelocity(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.ang).cross(new THREE.Vector3().subVectors(p, this.pos)).add(this.vel);
  }

  applyImpulse(p: THREE.Vector3, j: THREE.Vector3, invI?: THREE.Matrix3) {
    this.vel.addScaledVector(j, 1 / this.mass);
    const r = new THREE.Vector3().subVectors(p, this.pos);
    this.ang.add(r.cross(j).applyMatrix3(invI ?? this.invInertiaWorld()));
  }

  /** Rotation away from the pose it broke off in, in radians. */
  get tilt(): number {
    return 2 * Math.acos(Math.min(1, Math.abs(this.quat.w)));
  }
}

interface Contact {
  r: THREE.Vector3;
  n: THREE.Vector3;
  pen: number;
}

/**
 * Structural collapse: after material is removed, anything left hanging becomes a rigid body,
 * falls under planet gravity, breaks on hard impacts, and is written back as voxels once at rest.
 */
export class Physics {
  readonly bodies: Body[] = [];
  readonly group = new THREE.Group();
  private rand = mulberry32(7);
  /** Number of bodies created since start (for the HUD). */
  collapses = 0;

  constructor(
    private store: VoxelStore,
    private terrain: Terrain,
    private material: THREE.Material,
    /** Called when a body settles, with the undo record of writing it back into the world. */
    private onSettle: (record: UndoRecord, origin: unknown) => void,
  ) {
    this.group.name = 'bodies';
  }

  /** Is structural physics on? When off (creative mode), nothing collapses. */
  enabled = true;

  /**
   * After an edit: drop anything left unsupported next to removed voxels, and anything a
   * structure can no longer span (stress) around removed or added voxels.
   * Returns the undo record for lifting the pieces out of the world and the bodies created.
   */
  collapse(removed: number[], added: number[] = []): { record: UndoRecord | null; bodies: Body[] } {
    if (!this.enabled || (!removed.length && !added.length)) return { record: null, bodies: [] };
    const comps = removed.length ? findFloating(this.store, removed) : [];
    const taken = new Set<number>();
    for (const c of comps) for (const k of c.keys) taken.add(k);
    // Stress: seeds around the edit (subsampled; the analysis floods the whole structure).
    const seeds = subsample(removed.length ? removed : added, 600);
    for (const c of findOverstressed(this.store, seeds)) {
      // Skip pieces already falling as part of a floating region.
      let fresh = false;
      for (const k of c.keys) if (!taken.has(k)) { fresh = true; break; }
      if (fresh) comps.push(c);
    }
    if (!comps.length) return { record: null, bodies: [] };
    return this.detach(comps);
  }

  /**
   * Lift regions out of the world as rigid bodies. `launch` can give each new body an initial
   * velocity (explosions); `fragment` breaks them into rubble right away.
   */
  detach(
    comps: Component[],
    launch?: (b: Body) => void,
    fragment = false,
  ): { record: UndoRecord | null; bodies: Body[] } {
    // Specks too small to matter (e.g. a corner voxel touching only diagonally) turn to dust.
    const bodies = comps.filter((c) => c.keys.size >= MIN_BODY).map((c) => this.bodyFromComponent(c));
    // Lift every voxel out of the world in one undoable edit.
    const all = new Set<number>();
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const c of comps) {
      for (const k of c.keys) all.add(k);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], c.min[a]); max[a] = Math.max(max[a], c.max[a]); }
    }
    const { dirty, undo } = this.store.edit(min as [number, number, number], max as [number, number, number], (x, y, z, d, m, out) => {
      if (!all.has(voxelKey(x, y, z))) return false;
      out.d = Math.min(d, -1);
      out.m = m;
      return true;
    });
    this.terrain.remesh(dirty);
    const created: Body[] = [];
    for (const b of bodies) {
      launch?.(b);
      if (fragment && b.voxelCount > 24) created.push(...this.shatter(b, false));
      else {
        this.add(b);
        created.push(b);
      }
    }
    this.collapses += created.length;
    return { record: undo, bodies: created };
  }

  private bodyFromComponent(c: Component): Body {
    const nx = c.max[0] - c.min[0] + 1 + 2 * MARGIN;
    const ny = c.max[1] - c.min[1] + 1 + 2 * MARGIN;
    const nz = c.max[2] - c.min[2] + 1 + 2 * MARGIN;
    const ox = c.min[0] - MARGIN, oy = c.min[1] - MARGIN, oz = c.min[2] - MARGIN;
    const density = new Float32Array(nx * ny * nz);
    const material = new Uint8Array(nx * ny * nz);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const x = ox + i, y = oy + j, z = oz + k;
          const n = i + (j + k * ny) * nx;
          const d = this.store.density(x, y, z);
          material[n] = this.store.material(x, y, z);
          // Keep this region's voxels; other solids around it become air for the body.
          density[n] = c.keys.has(voxelKey(x, y, z)) ? d : d > 0 ? -1 : d;
        }
    const body = new Body(nx, ny, nz, density, material, new THREE.Vector3(ox, oy, oz), 0);
    body.pos.set(ox + body.com.x, oy + body.com.y, oz + body.com.z);
    return body;
  }

  private add(b: Body) {
    b.iquat.copy(b.quat).invert();
    b.buildMeshes(this.material);
    this.group.add(b.group);
    this.bodies.push(b);
    // Too many bodies: freeze the oldest where they are.
    while (this.bodies.length > MAX_BODIES) this.settle(this.bodies[0]);
  }

  /** Falling bodies, for saving. */
  snapshot(): SavedBody[] {
    return this.bodies.map((b) => ({
      nx: b.nx, ny: b.ny, nz: b.nz,
      density: b.density.slice(), material: b.material.slice(),
      origin: b.worldOrigin.toArray(), pos: b.pos.toArray(), quat: b.quat.toArray(),
      vel: b.vel.toArray(), ang: b.ang.toArray(), generation: b.generation,
    }));
  }

  /** Bring saved bodies back, still falling. */
  restore(saved: SavedBody[]) {
    for (const s of saved) {
      const b = new Body(s.nx, s.ny, s.nz, s.density, s.material, new THREE.Vector3().fromArray(s.origin), s.generation);
      b.pos.fromArray(s.pos);
      b.quat.fromArray(s.quat);
      b.vel.fromArray(s.vel);
      b.ang.fromArray(s.ang);
      this.add(b);
    }
  }

  /** Remove every body set falling by `origin` (undo), without writing them back. */
  removeFrom(origin: unknown) {
    for (const b of [...this.bodies]) if (b.origin === origin) this.remove(b);
  }

  /** Remove a body without writing it back (used by undo). */
  remove(b: Body) {
    const i = this.bodies.indexOf(b);
    if (i < 0) return;
    this.bodies.splice(i, 1);
    b.dispose();
  }

  update(dt: number) {
    if (!this.bodies.length) return;
    const steps = 2;
    const h = Math.min(dt, 1 / 30) / steps;
    for (let s = 0; s < steps; s++) {
      for (const b of [...this.bodies]) this.step(b, h);
      // Debris collides with other debris.
      const list = this.bodies;
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.still > 0.2 && b.still > 0.2) continue;
          if (a.pos.distanceToSquared(b.pos) > (a.radius + b.radius) ** 2) continue;
          this.pointsAgainst(a, b);
          this.pointsAgainst(b, a);
        }
    }
    for (const b of [...this.bodies]) {
      b.syncGroup();
      b.age += dt;
      const resting = b.vel.lengthSq() < 2 * 2 && b.ang.lengthSq() < 0.5 * 0.5;
      b.still = resting ? b.still + dt : 0;
      const canBreak = b.voxelCount > 24 && b.generation < 2;
      if (b.impact > SHATTER_SPEED && canBreak) this.shatter(b);
      else if (b.still > SETTLE_TIME || b.age > MAX_AGE) {
        if (b.built && b.tilt > WRECK_TILT && canBreak && b.voxelCount > 80) this.shatter(b);
        else this.settle(b);
      }
      b.impact = 0;
    }
  }

  private step(b: Body, h: number) {
    // Gravity toward the planet centre.
    const g = b.pos.clone().normalize().multiplyScalar(-PLAYER.gravity * h);
    b.vel.add(g);
    b.pos.addScaledVector(b.vel, h);
    const w = b.ang;
    if (w.lengthSq() > 0) {
      const dq = new THREE.Quaternion(w.x * h * 0.5, w.y * h * 0.5, w.z * h * 0.5, 0).multiply(b.quat);
      b.quat.set(b.quat.x + dq.x, b.quat.y + dq.y, b.quat.z + dq.z, b.quat.w + dq.w).normalize();
    }
    b.iquat.copy(b.quat).invert();

    // Contacts against the world's density field.
    const contacts: Contact[] = [];
    const p = TMP_P;
    const pts = b.points;
    for (let i = 0; i < pts.length; i += 3) {
      TMP_R.set(pts[i], pts[i + 1], pts[i + 2]).applyQuaternion(b.quat);
      p.copy(b.pos).add(TMP_R);
      const d = this.store.sample(p.x, p.y, p.z);
      if (d <= -0.05) continue;
      const r = TMP_R.clone();
      this.store.gradient(p.x, p.y, p.z, tmpG);
      const gl = Math.hypot(tmpG.x, tmpG.y, tmpG.z);
      if (gl < 1e-4) continue;
      contacts.push({ r, n: new THREE.Vector3(-tmpG.x / gl, -tmpG.y / gl, -tmpG.z / gl), pen: (d + 0.05) / Math.max(gl, 0.3) });
    }
    if (!contacts.length) return;
    if (contacts.length > 48) {
      contacts.sort((a, c) => c.pen - a.pen);
      contacts.length = 48;
    }

    const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(b.quat));
    const invI = R.clone().multiply(b.invInertiaLocal).multiply(R.clone().transpose());
    const invM = 1 / b.mass;
    const vp = new THREE.Vector3(), rn = new THREE.Vector3(), tmp = new THREE.Vector3();
    const pointVel = (r: THREE.Vector3) => vp.copy(b.ang).cross(r).add(b.vel);
    const effMass = (r: THREE.Vector3, n: THREE.Vector3) => {
      rn.copy(r).cross(n).applyMatrix3(invI).cross(r);
      return invM + n.dot(rn);
    };
    const applyImpulse = (r: THREE.Vector3, j: THREE.Vector3) => {
      b.vel.addScaledVector(j, invM);
      b.ang.add(tmp.copy(r).cross(j).applyMatrix3(invI));
    };

    for (const c of contacts) {
      const vn = pointVel(c.r).dot(c.n);
      if (-vn > b.impact) b.impact = -vn;
    }
    for (let iter = 0; iter < 4; iter++) {
      for (const c of contacts) {
        const vn = pointVel(c.r).dot(c.n);
        if (vn >= 0) continue;
        const e = vn < -4 ? RESTITUTION : 0;
        const jn = (-(1 + e) * vn) / effMass(c.r, c.n);
        applyImpulse(c.r, c.n.clone().multiplyScalar(jn));
        // Coulomb friction along the sliding direction.
        const v = pointVel(c.r);
        const vt = v.clone().addScaledVector(c.n, -v.dot(c.n));
        const speed = vt.length();
        if (speed > 1e-4) {
          const t = vt.divideScalar(speed);
          const jt = Math.min(speed / effMass(c.r, t), FRICTION * jn);
          applyImpulse(c.r, t.multiplyScalar(-jt));
        }
      }
    }
    // Push out of the ground along the average contact normal.
    let deepest = 0;
    const nAvg = new THREE.Vector3();
    for (const c of contacts) {
      nAvg.addScaledVector(c.n, c.pen);
      deepest = Math.max(deepest, c.pen);
    }
    if (deepest > 0.02 && nAvg.lengthSq() > 0) b.pos.addScaledVector(nAvg.normalize(), Math.min(deepest, 1) * 0.6);
    // A little damping so resting bodies come to a stop.
    b.ang.multiplyScalar(0.995);
  }

  /** Contacts of a's surface points against b's voxels, resolved with two-body impulses. */
  private pointsAgainst(a: Body, b: Body) {
    const pts = a.points;
    const p = new THREE.Vector3(), g = new THREE.Vector3(), n = new THREE.Vector3();
    const va = new THREE.Vector3(), vb = new THREE.Vector3();
    const invIa = a.invInertiaWorld(), invIb = b.invInertiaWorld();
    let pushed = 0;
    const push = new THREE.Vector3();
    for (let i = 0; i < pts.length && pushed < 24; i += 3) {
      p.set(pts[i], pts[i + 1], pts[i + 2]).applyQuaternion(a.quat).add(a.pos);
      b.toGrid(p, g);
      const d = b.sample(g.x, g.y, g.z);
      if (d <= -0.05) continue;
      b.gradientWorld(g, n);
      const gl = n.length();
      if (gl < 1e-4) continue;
      n.multiplyScalar(-1 / gl); // out of b, toward a
      const pen = (d + 0.05) / Math.max(gl, 0.3);
      const rel = a.pointVelocity(p, va).sub(b.pointVelocity(p, vb));
      const vn = rel.dot(n);
      if (vn < 0) {
        const ra = new THREE.Vector3().subVectors(p, a.pos), rb = new THREE.Vector3().subVectors(p, b.pos);
        const ka = 1 / a.mass + n.dot(ra.clone().cross(n).applyMatrix3(invIa).cross(ra));
        const kb = 1 / b.mass + n.dot(rb.clone().cross(n).applyMatrix3(invIb).cross(rb));
        const jn = (-(1 + RESTITUTION) * vn) / (ka + kb);
        const J = n.clone().multiplyScalar(jn);
        a.applyImpulse(p, J, invIa);
        b.applyImpulse(p, J.negate(), invIb);
        // Friction.
        const rel2 = a.pointVelocity(p, va).sub(b.pointVelocity(p, vb));
        const vt = rel2.addScaledVector(n, -rel2.dot(n));
        const speed = vt.length();
        if (speed > 1e-4) {
          const jt = Math.min(speed / (ka + kb), FRICTION * jn);
          const T = vt.multiplyScalar(-jt / speed);
          a.applyImpulse(p, T, invIa);
          b.applyImpulse(p, T.negate(), invIb);
        }
        a.impact = Math.max(a.impact, -vn);
        b.impact = Math.max(b.impact, -vn);
      }
      push.addScaledVector(n, pen);
      pushed++;
    }
    if (pushed) {
      // Separate, split by mass.
      push.divideScalar(pushed);
      const wa = b.mass / (a.mass + b.mass);
      a.pos.addScaledVector(push, wa * 0.5);
      b.pos.addScaledVector(push, -(1 - wa) * 0.5);
    }
  }

  /**
   * Push a sphere (the player) out of any falling body. Moves `center`, changes `vel` (the
   * sphere is knocked along by the body) and pushes back on the body. Returns the contact
   * normal of the deepest hit, or null.
   */
  resolveSphere(center: THREE.Vector3, r: number, vel: THREE.Vector3, mass: number): THREE.Vector3 | null {
    let normal: THREE.Vector3 | null = null;
    const g = new THREE.Vector3(), n = new THREE.Vector3(), vb = new THREE.Vector3();
    for (const b of this.bodies) {
      if (center.distanceToSquared(b.pos) > (b.radius + r + 1) ** 2) continue;
      b.toGrid(center, g);
      const d = b.sample(g.x, g.y, g.z);
      if (d <= -r - 0.5) continue;
      b.gradientWorld(g, n);
      const gl = n.length();
      if (gl < 1e-4) continue;
      n.multiplyScalar(-1 / gl);
      const pen = d / Math.max(gl, 0.3) + r;
      if (pen <= 0) continue;
      center.addScaledVector(n, Math.min(pen, 1.5));
      const rel = vel.clone().sub(b.pointVelocity(center, vb));
      const vn = rel.dot(n);
      if (vn < 0) {
        // Inelastic: the sphere takes on the body's motion along the normal; the body feels it.
        const j = (-vn * mass * b.mass) / (mass + b.mass);
        vel.addScaledVector(n, j / mass);
        b.applyImpulse(center, n.clone().multiplyScalar(-j));
      }
      normal = n.clone();
    }
    return normal;
  }

  /**
   * Explosion: vaporize a rough sphere, throw the shell around it as flying rubble, shove
   * nearby debris, and let whatever lost its support come down.
   */
  explode(center: THREE.Vector3, radius: number): { records: UndoRecord[]; bodies: Body[] } {
    const records: UndoRecord[] = [];
    const bodies: Body[] = [];
    const noise = (x: number, y: number, z: number) => Math.sin(x * 0.9 + y * 0.3) * Math.sin(y * 0.8 - z * 0.5) * Math.sin(z * 0.7 + x * 0.4);
    const c = center;
    const ext = radius * 1.6 + 3;
    const min: [number, number, number] = [c.x - ext, c.y - ext, c.z - ext];
    const max: [number, number, number] = [c.x + ext, c.y + ext, c.z + ext];
    // 1. Crater.
    const carved = this.store.edit(min, max, (x, y, z, d, m, out) => {
      const sd = Math.hypot(x - c.x, y - c.y, z - c.z) - radius * (1 + 0.18 * noise(x, y, z));
      if (sd > 4) return false;
      out.d = Math.min(d, sd);
      out.m = m;
      return true;
    });
    this.terrain.remesh(carved.dirty);
    if (carved.undo) records.push(carved.undo);
    const removed = [...carved.removed];

    // 2. The shell around it is torn loose and thrown.
    if (this.enabled) {
      const shell = radius * 1.4;
      const keys = new Set<number>();
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let z = Math.floor(c.z - shell); z <= Math.ceil(c.z + shell); z++)
        for (let y = Math.floor(c.y - shell); y <= Math.ceil(c.y + shell); y++)
          for (let x = Math.floor(c.x - shell); x <= Math.ceil(c.x + shell); x++) {
            const dist = Math.hypot(x - c.x, y - c.y, z - c.z);
            if (dist > shell * (1 + 0.15 * noise(z, x, y)) || !this.store.solid(x, y, z)) continue;
            keys.add(voxelKey(x, y, z));
            removed.push(x, y, z);
            lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
            hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
          }
      if (keys.size) {
        const comp: Component = { voxels: new Int32Array(0), keys, min: lo as [number, number, number], max: hi as [number, number, number] };
        const up = c.clone().normalize();
        const thrown = this.detach([comp], undefined, false);
        if (thrown.record) records.push(thrown.record);
        // Break the shell into many pieces and fling them outward and up.
        for (const b of thrown.bodies) {
          const pieces = this.shatter(b, true, 4 + Math.min(20, Math.round(b.voxelCount / 90)));
          for (const p of pieces) {
            const away = p.pos.clone().sub(c);
            const dist = away.length() || 1;
            const speed = 55 * (1 - Math.min(1, dist / (radius * 3))) + 10;
            p.vel.copy(away.divideScalar(dist)).multiplyScalar(speed).addScaledVector(up, 12 + this.rand() * 10);
            p.ang.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5).multiplyScalar(8);
            bodies.push(p);
          }
        }
      }
    }

    // 3. Shove debris that was already flying.
    for (const b of this.bodies) {
      if (bodies.includes(b)) continue;
      const away = b.pos.clone().sub(c);
      const dist = away.length();
      if (dist > radius * 4) continue;
      b.vel.addScaledVector(away.normalize(), 40 * (1 - dist / (radius * 4)));
      b.ang.add(new THREE.Vector3(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5).multiplyScalar(3));
    }

    // 4. Anything around the blast that lost its support comes down.
    const fall = this.collapse(removed);
    if (fall.record) records.push(fall.record);
    bodies.push(...fall.bodies);
    return { records, bodies };
  }

  /** Write a body back into the world as voxels and remove it. */
  settle(b: Body) {
    const i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
    b.syncGroup();
    const rubble = b.tilt > (8 * Math.PI) / 180;
    const inv = b.quat.clone().invert();
    // World bounds of the rotated grid.
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let c = 0; c < 8; c++) {
      const v = new THREE.Vector3(c & 1 ? b.nx : 0, c & 2 ? b.ny : 0, c & 4 ? b.nz : 0).sub(b.com).applyQuaternion(b.quat).add(b.pos);
      min.min(v);
      max.max(v);
    }
    const l = new THREE.Vector3();
    const { dirty, undo } = this.store.edit([min.x, min.y, min.z], [max.x, max.y, max.z], (x, y, z, d, m, out) => {
      l.set(x, y, z).sub(b.pos).applyQuaternion(inv).add(b.com);
      const bd = b.sample(l.x, l.y, l.z);
      if (bd <= d || bd < -2) return false;
      out.d = bd;
      out.m = m;
      if (bd > -1) {
        const n = b.index(
          Math.max(0, Math.min(b.nx - 1, Math.round(l.x))),
          Math.max(0, Math.min(b.ny - 1, Math.round(l.y))),
          Math.max(0, Math.min(b.nz - 1, Math.round(l.z))),
        );
        let mat = b.material[n];
        if (mat === AIR) mat = m;
        out.m = rubble && MATERIAL_CONSTRUCT[mat] ? rubbleOf(mat) : mat;
      }
      return true;
    });
    b.dispose();
    this.terrain.remesh(dirty);
    if (undo) this.onSettle(undo, b.origin);
  }

  /** Break a body into Voronoi fragments that fly apart and keep falling. Returns the pieces. */
  private shatter(b: Body, added = true, pieces = 0): Body[] {
    const solid: number[] = [];
    for (let n = 0; n < b.density.length; n++) if (b.density[n] > 0) solid.push(n);
    const k = pieces || Math.max(2, Math.min(8, Math.round(solid.length / 250)));
    const seeds: number[][] = [];
    for (let s = 0; s < k; s++) {
      const n = solid[Math.floor(this.rand() * solid.length)];
      seeds.push([n % b.nx, Math.floor(n / b.nx) % b.ny, Math.floor(n / (b.nx * b.ny)), 0.7 + this.rand() * 0.6]);
    }
    const label = new Int16Array(b.density.length).fill(-1);
    for (const n of solid) {
      const i = n % b.nx, j = Math.floor(n / b.nx) % b.ny, kk = Math.floor(n / (b.nx * b.ny));
      let best = Infinity, bi = 0;
      seeds.forEach(([sx, sy, sz, wgt], si) => {
        const d = ((i - sx) ** 2 + (j - sy) ** 2 + (kk - sz) ** 2) * wgt;
        if (d < best) { best = d; bi = si; }
      });
      label[n] = bi;
    }

    // Split each Voronoi cell into connected pieces and make a body from each.
    const seen = new Uint8Array(b.density.length);
    const made: Body[] = [];
    for (const start of solid) {
      if (seen[start]) continue;
      const lab = label[start];
      const queue = [start];
      seen[start] = 1;
      const cells: number[] = [];
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let q = 0; q < queue.length; q++) {
        const n = queue[q];
        cells.push(n);
        const i = n % b.nx, j = Math.floor(n / b.nx) % b.ny, kk = Math.floor(n / (b.nx * b.ny));
        mn = [Math.min(mn[0], i), Math.min(mn[1], j), Math.min(mn[2], kk)];
        mx = [Math.max(mx[0], i), Math.max(mx[1], j), Math.max(mx[2], kk)];
        for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const ni = i + di, nj = j + dj, nk = kk + dk;
          if (ni < 0 || nj < 0 || nk < 0 || ni >= b.nx || nj >= b.ny || nk >= b.nz) continue;
          const m = b.index(ni, nj, nk);
          if (seen[m] || label[m] !== lab || b.density[m] <= 0) continue;
          seen[m] = 1;
          queue.push(m);
        }
      }
      if (cells.length < 3) continue; // dust
      const inPiece = new Set(cells);
      const nx = mx[0] - mn[0] + 1 + 2 * MARGIN, ny = mx[1] - mn[1] + 1 + 2 * MARGIN, nz = mx[2] - mn[2] + 1 + 2 * MARGIN;
      const ox = mn[0] - MARGIN, oy = mn[1] - MARGIN, oz = mn[2] - MARGIN;
      const density = new Float32Array(nx * ny * nz).fill(-2);
      const material = new Uint8Array(nx * ny * nz);
      for (let kk = 0; kk < nz; kk++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const pi = ox + i, pj = oy + j, pk = oz + kk;
            if (pi < 0 || pj < 0 || pk < 0 || pi >= b.nx || pj >= b.ny || pk >= b.nz) continue;
            const pn = b.index(pi, pj, pk);
            const n = i + (j + kk * ny) * nx;
            const d = b.density[pn];
            // Fracture faces: other fragments' voxels become air.
            density[n] = inPiece.has(pn) ? d : d > 0 ? -0.6 : d;
            material[n] = rubbleOf(b.material[pn]);
          }
      const piece = new Body(nx, ny, nz, density, material, b.worldOrigin.clone().add(new THREE.Vector3(ox, oy, oz)), b.generation + 1);
      piece.origin = b.origin;
      // Place it where it was inside the parent, moving with the parent's motion plus a kick.
      const offset = new THREE.Vector3(ox, oy, oz).add(piece.com).sub(b.com).applyQuaternion(b.quat);
      piece.pos.copy(b.pos).add(offset);
      piece.quat.copy(b.quat);
      const kick = offset.clone().normalize().multiplyScalar(2 + this.rand() * 4);
      piece.vel.copy(b.ang).cross(offset).add(b.vel).add(kick);
      piece.ang.copy(b.ang).add(new THREE.Vector3(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5).multiplyScalar(2));
      made.push(piece);
    }
    if (added) this.remove(b);
    for (const p of made) this.add(p);
    return made;
  }
}

/** Every n-th voxel of a flat x,y,z list so at most `max` remain. */
function subsample(list: number[], max: number): number[] {
  const count = list.length / 3;
  if (count <= max) return list;
  const out: number[] = [];
  const step = count / max;
  for (let i = 0; i < max; i++) {
    const j = Math.floor(i * step) * 3;
    out.push(list[j], list[j + 1], list[j + 2]);
  }
  return out;
}
