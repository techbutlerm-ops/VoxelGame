import * as THREE from 'three';
import { PLAYER } from '../config';
import { HOTBAR, MATERIALS, hexColor } from '../world/materials';
import { VoxelStore } from '../world/VoxelStore';
import { Terrain } from '../world/Terrain';
import { Player } from '../player/Player';
import { Input } from '../player/Input';

export type BrushShape = 'sphere' | 'cube';

export interface Hit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

export const MIN_BRUSH = 1;
export const MAX_BRUSH = 24;

const tmpG = { x: 0, y: 0, z: 0 };

/** March a ray through the density field; refine the first surface crossing by bisection. */
export function raycast(store: VoxelStore, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): Hit | null {
  const step = 0.35;
  let prevT = 0;
  for (let t = step; t <= maxDist; t += step) {
    const f = store.sample(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
    if (f > 0) {
      let lo = prevT, hi = t;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (store.sample(origin.x + dir.x * mid, origin.y + dir.y * mid, origin.z + dir.z * mid) > 0) hi = mid;
        else lo = mid;
      }
      const point = origin.clone().addScaledVector(dir, hi);
      store.gradient(point.x, point.y, point.z, tmpG);
      const normal = new THREE.Vector3(-tmpG.x, -tmpG.y, -tmpG.z);
      if (normal.lengthSq() < 1e-8) normal.copy(dir).negate();
      normal.normalize();
      return { point, normal, distance: hi };
    }
    // Take bigger steps when far from any surface.
    if (f < -3) t += Math.min(2, -f - 3);
    prevT = t;
  }
  return null;
}

/**
 * Terraforming tools. Left mouse digs, right mouse builds, both with a smooth brush so the
 * results blend into the terrain. Cube brushes align to the local up and your heading, so
 * walls and floors come out level anywhere on the planet.
 */
export class Tools {
  slot = 0;
  radius = 3;
  shape: BrushShape = 'sphere';
  target: Hit | null = null;
  readonly preview = new THREE.Group();
  private sphereMesh: THREE.Mesh;
  private cubeMesh: THREE.Mesh;
  private previewMat: THREE.MeshBasicMaterial;
  private cooldown = 0;
  lastChanged = 0;

  constructor(private store: VoxelStore, private terrain: Terrain, private player: Player) {
    this.previewMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false });
    const wire = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 });
    this.sphereMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this.previewMat);
    this.sphereMesh.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 2)), wire));
    this.cubeMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.previewMat);
    this.cubeMesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), wire));
    this.preview.add(this.sphereMesh, this.cubeMesh);
    this.preview.renderOrder = 10;
    this.preview.visible = false;
  }

  get material(): number {
    return HOTBAR[this.slot];
  }

  get materialName(): string {
    return MATERIALS[this.material].name;
  }

  update(dt: number, input: Input) {
    const digits = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
    digits.forEach((k, i) => {
      if (input.pressed.has(k) && i < HOTBAR.length) this.slot = i;
    });
    if (input.pressed.has('KeyQ')) this.slot = (this.slot + HOTBAR.length - 1) % HOTBAR.length;
    if (input.pressed.has('KeyE')) this.slot = (this.slot + 1) % HOTBAR.length;
    if (input.wheel) this.radius = clamp(this.radius - input.wheel, MIN_BRUSH, MAX_BRUSH);
    if (input.pressed.has('BracketLeft')) this.radius = clamp(this.radius - 1, MIN_BRUSH, MAX_BRUSH);
    if (input.pressed.has('BracketRight')) this.radius = clamp(this.radius + 1, MIN_BRUSH, MAX_BRUSH);
    if (input.pressed.has('KeyB')) this.shape = this.shape === 'sphere' ? 'cube' : 'sphere';

    this.target = raycast(this.store, this.player.eye, this.player.forward, PLAYER.reach);
    this.cooldown -= dt;
    const dig = input.clicked.has(0) || (input.buttons.has(0) && this.cooldown <= 0);
    const build = input.clicked.has(2) || (input.buttons.has(2) && this.cooldown <= 0);
    if (this.target && dig) {
      this.apply('dig', this.target);
      this.cooldown = 0.15;
    } else if (this.target && build) {
      this.apply('build', this.target);
      this.cooldown = 0.2;
    }
    this.updatePreview();
  }

  /** Brush frame: local up, and the heading projected onto the tangent plane. */
  private frame(center: THREE.Vector3) {
    const up = center.clone().normalize();
    const fwd = this.player.heading.clone().addScaledVector(up, -this.player.heading.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    return { up, fwd, right };
  }

  /** Where the brush is centered: on the surface for digging, resting on it for building. */
  brushCenter(mode: 'dig' | 'build', hit: Hit): THREE.Vector3 {
    if (mode === 'dig') return hit.point.clone();
    return hit.point.clone().addScaledVector(hit.normal, this.radius * 0.85);
  }

  apply(mode: 'dig' | 'build', hit: Hit): number {
    const r = this.radius;
    const c = this.brushCenter(mode, hit);
    const { up, fwd, right } = this.frame(c);
    const ext = r * (this.shape === 'cube' ? 1.75 : 1) + 3;
    let field: (x: number, y: number, z: number) => number;
    if (this.shape === 'sphere') {
      field = (x, y, z) => Math.hypot(x - c.x, y - c.y, z - c.z) - r;
    } else {
      field = (x, y, z) => {
        const dx = x - c.x, dy = y - c.y, dz = z - c.z;
        const qx = Math.abs(dx * right.x + dy * right.y + dz * right.z) - r;
        const qy = Math.abs(dx * up.x + dy * up.y + dz * up.z) - r;
        const qz = Math.abs(dx * fwd.x + dy * fwd.y + dz * fwd.z) - r;
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
        return outside + Math.min(Math.max(qx, qy, qz), 0);
      };
    }
    if (mode === 'build') {
      // Never build into the player's own body.
      const inner = field;
      const p = new THREE.Vector3();
      field = (x, y, z) => (this.player.overlapsPoint(p.set(x, y, z), 1.5) ? 99 : inner(x, y, z));
    }
    const { changed, dirty } = this.store.edit(
      [c.x - ext, c.y - ext, c.z - ext], [c.x + ext, c.y + ext, c.z + ext], field, mode, this.material,
    );
    this.terrain.remesh(dirty);
    this.lastChanged = changed;
    return changed;
  }

  private updatePreview() {
    const t = this.target;
    this.preview.visible = !!t;
    if (!t) return;
    const c = this.brushCenter('dig', t);
    const r = this.radius;
    this.preview.position.copy(c);
    const { up, fwd, right } = this.frame(c);
    this.preview.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate()));
    this.preview.scale.setScalar(r);
    this.sphereMesh.visible = this.shape === 'sphere';
    this.cubeMesh.visible = this.shape === 'cube';
    this.previewMat.color.set(hexColor(this.material));
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
