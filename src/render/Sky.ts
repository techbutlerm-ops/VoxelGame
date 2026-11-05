import * as THREE from 'three';
import { PLANET_RADIUS as R } from '../config';

/** Gradient sky dome with sun glow that fades to space with altitude. Follows the camera. */
export class Sky {
  readonly mesh: THREE.Mesh;
  private uniforms = {
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uSpace: { value: 0 },
    uZenith: { value: new THREE.Color(0x4f86c6) },
    uHorizon: { value: new THREE.Color(0xc9dcea) },
  };
  readonly horizonColor = new THREE.Color();

  constructor() {
    const geo = new THREE.SphereGeometry(1, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: `
        uniform vec3 uUp, uSun, uZenith, uHorizon;
        uniform float uSpace;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = dot(d, uUp);
          float t = pow(clamp(h, 0.0, 1.0), 0.45);
          vec3 col = mix(uHorizon, uZenith, t);
          col = mix(col, uHorizon * 0.82, smoothstep(0.0, -0.25, h));
          float s = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.85, 0.6) * (pow(s, 8.0) * 0.25 + pow(s, 64.0) * 0.35);
          col += vec3(1.0, 0.97, 0.9) * smoothstep(0.9993, 0.9997, s) * 2.0;
          vec3 space = vec3(0.01, 0.015, 0.035) + vec3(1.0) * smoothstep(0.9994, 0.9997, s) * 2.0;
          col = mix(col, space, uSpace);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  /** Update for the camera's position; returns the fog/horizon color. */
  update(camera: THREE.Camera, up: THREE.Vector3, sun: THREE.Vector3): THREE.Color {
    this.mesh.position.copy(camera.position);
    this.uniforms.uUp.value.copy(up);
    this.uniforms.uSun.value.copy(sun);
    const alt = camera.position.length() - R;
    const space = THREE.MathUtils.smoothstep(alt, 2000, 24000);
    this.uniforms.uSpace.value = space;
    this.horizonColor.copy(this.uniforms.uHorizon.value).lerp(new THREE.Color(0x05070d), space);
    return this.horizonColor;
  }
}

/**
 * The sea: one camera-centered patch of the sea-level sphere. Rings are dense under the viewer
 * and sparse toward the horizon, and the patch is re-projected onto the sphere every frame, so
 * it is seamless at any distance and costs a single draw call.
 */
export class Ocean {
  readonly mesh: THREE.Mesh;
  private rings = 110;
  private segments = 160;
  private theta: Float32Array;
  private cosPhi: Float32Array;
  private sinPhi: Float32Array;
  private position: THREE.BufferAttribute;
  private normal: THREE.BufferAttribute;

  constructor(private radius = R - 0.4) {
    const { rings, segments } = this;
    const nv = 1 + rings * segments;
    this.position = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    this.normal = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    this.theta = new Float32Array(rings + 1);
    for (let i = 1; i <= rings; i++) this.theta[i] = (Math.PI / 2) * Math.pow(i / rings, 3.2);
    this.cosPhi = new Float32Array(segments);
    this.sinPhi = new Float32Array(segments);
    for (let j = 0; j < segments; j++) {
      this.cosPhi[j] = Math.cos((j / segments) * Math.PI * 2);
      this.sinPhi[j] = Math.sin((j / segments) * Math.PI * 2);
    }
    const index: number[] = [];
    const v = (i: number, j: number) => (i === 0 ? 0 : 1 + (i - 1) * segments + (j % segments));
    // Counter-clockwise seen from above (phi increases counter-clockwise around the up axis).
    for (let j = 0; j < segments; j++) index.push(0, v(1, j), v(1, j + 1));
    for (let i = 1; i < rings; i++)
      for (let j = 0; j < segments; j++) {
        const a = v(i, j), b = v(i, j + 1), c = v(i + 1, j), d = v(i + 1, j + 1);
        index.push(a, c, d, a, d, b);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.position);
    g.setAttribute('normal', this.normal);
    g.setIndex(index);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2b7a96,
      roughness: 0.1,
      metalness: 0.05,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(viewer: THREE.Vector3) {
    const c = viewer.clone().normalize();
    const t1 = new THREE.Vector3(0, 1, 0).cross(c);
    if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = new THREE.Vector3().crossVectors(c, t1);
    const p = this.position.array as Float32Array;
    const n = this.normal.array as Float32Array;
    const R0 = this.radius;
    let o = 0;
    const put = (x: number, y: number, z: number) => {
      n[o] = x; n[o + 1] = y; n[o + 2] = z;
      p[o] = x * R0; p[o + 1] = y * R0; p[o + 2] = z * R0;
      o += 3;
    };
    put(c.x, c.y, c.z);
    for (let i = 1; i <= this.rings; i++) {
      const st = Math.sin(this.theta[i]), ct = Math.cos(this.theta[i]);
      for (let j = 0; j < this.segments; j++) {
        const cp = this.cosPhi[j] * st, sp = this.sinPhi[j] * st;
        put(c.x * ct + t1.x * cp + t2.x * sp, c.y * ct + t1.y * cp + t2.y * sp, c.z * ct + t1.z * cp + t2.z * sp);
      }
    }
    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
  }
}
