import * as THREE from 'three';

interface Flash {
  ball: THREE.Mesh;
  age: number;
  radius: number;
}

/** Short-lived visual effects: explosion flashes and camera shake. */
export class Effects {
  readonly group = new THREE.Group();
  private flashes: Flash[] = [];
  private shake = 0;
  private readonly offset = new THREE.Vector3();

  /** `light` is a pooled point light (adding lights at runtime would recompile every shader). */
  constructor(private light: THREE.PointLight) {}

  explosion(center: THREE.Vector3, radius: number, viewer: THREE.Vector3) {
    this.light.position.copy(center);
    const ball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ball.position.copy(center);
    this.group.add(ball);
    this.flashes.push({ ball, age: 0, radius });
    const dist = viewer.distanceTo(center);
    this.shake = Math.max(this.shake, Math.min(1.6, (radius * 6) / Math.max(dist, 1)));
  }

  /** Advance effects; returns a camera offset for shake. */
  update(dt: number): THREE.Vector3 {
    for (const f of [...this.flashes]) {
      f.age += dt;
      const t = f.age / 0.45;
      this.light.intensity = 3000 * f.radius * Math.max(0, 1 - t) ** 2;
      f.ball.scale.setScalar(f.radius * (0.6 + 1.6 * Math.sqrt(Math.min(1, t))));
      (f.ball.material as THREE.MeshBasicMaterial).opacity = 0.9 * Math.max(0, 1 - t);
      if (t >= 1) {
        f.ball.geometry.dispose();
        (f.ball.material as THREE.Material).dispose();
        this.group.remove(f.ball);
        this.flashes.splice(this.flashes.indexOf(f), 1);
      }
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const a = this.shake * this.shake;
    return this.offset.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
  }
}
