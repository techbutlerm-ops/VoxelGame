import * as THREE from 'three';
import { PLAYER, PLANET_RADIUS } from '../config';
import { VoxelStore } from '../world/VoxelStore';
import { Input } from './Input';

const tmpG = { x: 0, y: 0, z: 0 };
const v3 = new THREE.Vector3();
const basis = new THREE.Matrix4();
const qPitch = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
/** The player's mass in voxel-mass units (a stone voxel is 2.6). */
const PLAYER_MASS = 20;

/**
 * First-person walker on a spherical planet. "Up" is away from the planet center; the heading
 * vector is parallel-transported as you move so you can walk around the globe seamlessly.
 * Collision treats the player as a stack of spheres against the smooth density field.
 */
export class Player {
  /** Feet position. */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly up = new THREE.Vector3(0, 1, 0);
  /** Horizontal heading (unit, tangent to the surface). */
  readonly heading = new THREE.Vector3(0, 0, -1);
  pitch = 0;
  onGround = false;
  flying = false;
  noclip = false;
  readonly groundNormal = new THREE.Vector3();
  private stepSmooth = 0;

  /** Falling debris the player collides with (set once physics exists). */
  obstacles: { resolveSphere(c: THREE.Vector3, r: number, vel: THREE.Vector3, mass: number): THREE.Vector3 | null } | null = null;

  constructor(private store: VoxelStore) {}

  get right(): THREE.Vector3 {
    return new THREE.Vector3().crossVectors(this.heading, this.up).normalize();
  }

  /** Eye position. */
  get eye(): THREE.Vector3 {
    return this.pos.clone().addScaledVector(this.up, PLAYER.eyeHeight - this.stepSmooth);
  }

  /** Unit view direction. */
  get forward(): THREE.Vector3 {
    return this.heading.clone().multiplyScalar(Math.cos(this.pitch)).addScaledVector(this.up, Math.sin(this.pitch));
  }

  /** Camera orientation: heading/up frame, then pitch. */
  orientation(out: THREE.Quaternion): THREE.Quaternion {
    const r = this.right;
    const back = this.heading.clone().negate();
    basis.makeBasis(r, this.up, back);
    out.setFromRotationMatrix(basis);
    qPitch.setFromAxisAngle(X_AXIS, this.pitch);
    return out.multiply(qPitch);
  }

  /** Altitude of the feet above sea level, in voxels. */
  get altitude(): number {
    return this.pos.length() - PLANET_RADIUS;
  }

  spawnAt(dir: THREE.Vector3, height: number) {
    this.pos.copy(dir).normalize().multiplyScalar(PLANET_RADIUS + height);
    this.vel.set(0, 0, 0);
    this.updateFrame();
    this.unstick();
  }

  private updateFrame() {
    this.up.copy(this.pos).normalize();
    // Parallel transport: re-project the heading onto the new tangent plane.
    this.heading.addScaledVector(this.up, -this.heading.dot(this.up));
    if (this.heading.lengthSq() < 1e-6) {
      this.heading.set(1, 0, 0).addScaledVector(this.up, -this.up.x);
    }
    this.heading.normalize();
  }

  /** Push upward until the body is free (after spawning or building into ourselves). */
  private unstick() {
    for (let i = 0; i < 200 && this.penetration() > 0.05; i++) this.pos.addScaledVector(this.up, 1);
  }

  private penetration(): number {
    let worst = 0;
    for (const c of this.sphereCenters()) {
      const d = this.distance(c);
      worst = Math.max(worst, d + PLAYER.radius);
    }
    return worst;
  }

  private sphereCenters(): THREE.Vector3[] {
    const r = PLAYER.radius;
    const h = PLAYER.height;
    return [r, (h) / 2, h - r].map((t) => this.pos.clone().addScaledVector(this.up, t));
  }

  /** Approximate signed distance into solid (positive inside) at p. */
  private distance(p: THREE.Vector3): number {
    const f = this.store.sample(p.x, p.y, p.z);
    if (f < -3.5) return f;
    this.store.gradient(p.x, p.y, p.z, tmpG);
    const gl = Math.hypot(tmpG.x, tmpG.y, tmpG.z);
    return gl > 0.2 ? f / gl : f;
  }

  /** Does the body overlap a voxel position? Used to avoid building inside yourself. */
  overlapsPoint(p: THREE.Vector3, margin: number): boolean {
    const d = v3.copy(p).sub(this.pos);
    const along = d.dot(this.up);
    if (along < -margin || along > PLAYER.height + margin) return false;
    const radial = d.addScaledVector(this.up, -along).length();
    return radial < PLAYER.radius + margin;
  }

  update(dt: number, input: Input) {
    // --- Look ---
    const sens = 0.0022;
    if (input.lookDX) this.heading.applyAxisAngle(this.up, -input.lookDX * sens);
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.lookDY * sens, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

    if (input.pressed.has('KeyF')) {
      this.flying = !this.flying;
      if (!this.flying) this.noclip = false;
    }
    if (input.pressed.has('KeyN')) {
      this.noclip = !this.noclip;
      if (this.noclip) this.flying = true;
    }

    // --- Wish direction in the tangent plane ---
    let fx = 0, fz = 0;
    if (input.keys.has('KeyW')) fz += 1;
    if (input.keys.has('KeyS')) fz -= 1;
    if (input.keys.has('KeyD')) fx += 1;
    if (input.keys.has('KeyA')) fx -= 1;
    const wish = new THREE.Vector3().addScaledVector(this.heading, fz).addScaledVector(this.right, fx);
    if (wish.lengthSq() > 0) wish.normalize();
    const sprint = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');

    if (this.flying) {
      // Fly speed scales with altitude so the whole planet is reachable.
      const altBoost = 1 + Math.max(0, this.altitude - 400) / 300;
      const speed = (sprint ? PLAYER.flySprintSpeed : PLAYER.flySpeed) * Math.min(altBoost, 40);
      let wy = 0;
      if (input.keys.has('Space')) wy += 1;
      if (input.keys.has('KeyC') || input.keys.has('ControlLeft')) wy -= 1;
      const target = wish.clone().multiplyScalar(speed).addScaledVector(this.up, wy * speed);
      this.vel.lerp(target, 1 - Math.exp(-dt * 8));
    } else {
      const speed = sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
      const vUp = this.vel.dot(this.up);
      const horiz = this.vel.clone().addScaledVector(this.up, -vUp);
      horiz.lerp(wish.clone().multiplyScalar(speed), 1 - Math.exp(-dt * (this.onGround ? 12 : 2.5)));
      let nUp = vUp;
      if (this.onGround && input.keys.has('Space')) {
        nUp = PLAYER.jumpVelocity;
        this.onGround = false;
      } else {
        nUp = Math.max(-PLAYER.terminalVelocity, vUp - PLAYER.gravity * dt);
      }
      this.vel.copy(horiz).addScaledVector(this.up, nUp);
    }

    // --- Integrate in sub-steps of at most half a voxel ---
    const travel = this.vel.length() * dt;
    const steps = Math.min(64, Math.max(1, Math.ceil(travel / 0.5)));
    const h = dt / steps;
    const wasGrounded = this.onGround;
    this.onGround = false;
    for (let s = 0; s < steps; s++) {
      this.pos.addScaledVector(this.vel, h);
      this.updateFrame();
      if (!this.noclip) this.collide(wish);
    }

    // Stick to the ground when walking downhill instead of skipping into the air.
    if (!this.flying && wasGrounded && !this.onGround && this.vel.dot(this.up) <= 0) {
      const saved = this.pos.clone();
      this.pos.addScaledVector(this.up, -1.2);
      this.collide(wish);
      if (!this.onGround) this.pos.copy(saved);
    }

    this.stepSmooth = Math.max(0, this.stepSmooth - dt * 10);
  }

  private collide(wish: THREE.Vector3) {
    const r = PLAYER.radius;
    let blockedLow = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const offsets = [r, PLAYER.height / 2, PLAYER.height - r];
      for (let si = 0; si < offsets.length; si++) {
        const c = this.pos.clone().addScaledVector(this.up, offsets[si]);
        const f = this.store.sample(c.x, c.y, c.z);
        if (f < -r - 0.6) continue;
        this.store.gradient(c.x, c.y, c.z, tmpG);
        const gl = Math.hypot(tmpG.x, tmpG.y, tmpG.z);
        if (gl < 1e-4) continue;
        const dist = f / Math.max(gl, 0.2);
        const pen = dist + r;
        if (pen <= 0.001) continue;
        const n = v3.set(-tmpG.x / gl, -tmpG.y / gl, -tmpG.z / gl);
        const ndotup = n.dot(this.up);
        this.pos.addScaledVector(n, Math.min(pen, 1.5));
        const vn = this.vel.dot(n);
        if (vn < 0) this.vel.addScaledVector(n, -vn);
        if (ndotup > 0.55) {
          this.onGround = true;
          this.groundNormal.copy(n);
        } else if (si === 0 && Math.abs(ndotup) < 0.4) {
          blockedLow = true;
        }
        moved = true;
      }
      if (!moved) break;
    }

    // Falling debris: get knocked around by it, or stand on it.
    if (this.obstacles) {
      for (const off of [r, PLAYER.height / 2, PLAYER.height - r]) {
        const c = this.pos.clone().addScaledVector(this.up, off);
        const before = c.clone();
        const n = this.obstacles.resolveSphere(c, r, this.vel, PLAYER_MASS);
        if (!n) continue;
        this.pos.add(c.sub(before));
        if (n.dot(this.up) > 0.55) {
          this.onGround = true;
          this.groundNormal.copy(n);
        }
      }
    }

    // Step assist: climb small ledges (e.g. a built block) when walking into them.
    if (blockedLow && !this.flying && wish.lengthSq() > 0) {
      const saved = this.pos.clone();
      this.pos.addScaledVector(this.up, 2.4).addScaledVector(wish, 0.4);
      if (this.penetration() <= 0.05) {
        this.stepSmooth += 2.4;
        this.onGround = true;
      } else {
        this.pos.copy(saved);
      }
    }
  }
}
