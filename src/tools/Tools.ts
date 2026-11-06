import * as THREE from 'three';
import { PLAYER, toMeters } from '../config';
import { HOTBAR, MATERIALS, MATERIAL_CONSTRUCT, hexColor } from '../world/materials';
import { EditOp, UndoRecord, VoxelStore } from '../world/VoxelStore';
import { Terrain } from '../world/Terrain';
import { Player } from '../player/Player';
import { Input } from '../player/Input';
import { BuildFrame, Piece, Rise, frameAt, pieceSdf, toLocal, toWorld } from './BuildGrid';

export interface Hit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

export type ToolId = 'block' | 'wall' | 'floor' | 'pillar' | 'ramp' | 'sphere' | 'flatten' | 'smooth';

interface ToolDef {
  id: ToolId;
  name: string;
  /** Snaps to the build grid and places crisp pieces. */
  grid: boolean;
  size: number;
  maxSize: number;
}

export const TOOLS: ToolDef[] = [
  { id: 'block', name: 'Block', grid: true, size: 1, maxSize: 16 },
  { id: 'wall', name: 'Wall', grid: true, size: 4, maxSize: 24 },
  { id: 'floor', name: 'Floor', grid: true, size: 4, maxSize: 24 },
  { id: 'pillar', name: 'Pillar', grid: true, size: 4, maxSize: 24 },
  { id: 'ramp', name: 'Ramp', grid: true, size: 4, maxSize: 16 },
  { id: 'sphere', name: 'Terrain', grid: false, size: 3, maxSize: 24 },
  { id: 'flatten', name: 'Flatten', grid: false, size: 8, maxSize: 32 },
  { id: 'smooth', name: 'Smooth', grid: false, size: 4, maxSize: 16 },
];

/** Grid cell sizes in voxels (0.25, 0.5, 1 and 2 m). */
export const GRID_SIZES = [1, 2, 4, 8];

const tmpG = { x: 0, y: 0, z: 0 };
const UNDO_LIMIT = 64;
/** Horizontal directions in quarter-turn order around the frame's up axis. */
const QUARTER: Rise[] = [{ axis: 0, sign: 1 }, { axis: 2, sign: 1 }, { axis: 0, sign: -1 }, { axis: 2, sign: -1 }];

/** March a ray through the density field; refine the first surface crossing by bisection. */
export function raycast(store: VoxelStore, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): Hit | null {
  const step = 0.3;
  let prevT = 0;
  for (let t = step; t <= maxDist; t += step) {
    const f = store.sample(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
    if (f > 0) {
      let lo = prevT, hi = t;
      for (let i = 0; i < 10; i++) {
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
 * Building and terraforming tools. Grid tools (block, wall, floor, pillar, ramp) place crisp
 * pieces snapped to a planet-level build grid: right mouse places, left mouse removes. Terrain
 * tools sculpt smoothly: the terrain sphere digs/adds, flatten levels ground to a grid height and
 * smooth softens it. Every edit can be undone.
 */
export class Tools {
  tool = 0;
  slot = 0;
  gridIndex = 1;
  rotation = 0;
  private sizes = TOOLS.map((t) => t.size);
  target: Hit | null = null;
  buildPiece: Piece | null = null;
  digPiece: Piece | null = null;
  private undoStack: UndoRecord[] = [];
  private cooldown = 0;
  lastChanged = 0;
  /** Messages for the HUD (e.g. "Undone"); consumed by main. */
  message: string | null = null;

  readonly preview = new THREE.Group();
  private pieceGroup = new THREE.Group();
  private ghost: THREE.Mesh;
  private ghostBox: THREE.BufferGeometry;
  private ghostWedge: THREE.BufferGeometry;
  private ghostMat: THREE.MeshBasicMaterial;
  private ghostEdges: THREE.LineSegments;
  private boxEdges: THREE.BufferGeometry;
  private wedgeEdges: THREE.BufferGeometry;
  private digGroup = new THREE.Group();
  private digWire: THREE.LineSegments;
  private gridGroup = new THREE.Group();
  private gridLines: THREE.LineSegments;
  private sphere: THREE.Mesh;
  private disc: THREE.Mesh;
  private brushMat: THREE.MeshBasicMaterial;

  constructor(private store: VoxelStore, private terrain: Terrain, private player: Player) {
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    this.ghostBox = new THREE.BoxGeometry(1, 1, 1);
    this.ghostWedge = wedgeGeometry();
    this.boxEdges = new THREE.EdgesGeometry(this.ghostBox);
    this.wedgeEdges = new THREE.EdgesGeometry(this.ghostWedge);
    this.ghost = new THREE.Mesh(this.ghostBox, this.ghostMat);
    this.ghostEdges = new THREE.LineSegments(this.boxEdges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
    this.ghost.add(this.ghostEdges);
    this.pieceGroup.add(this.ghost);

    this.digWire = new THREE.LineSegments(this.boxEdges, new THREE.LineBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.85 }));
    this.digGroup.add(this.digWire);

    this.gridLines = new THREE.LineSegments(gridGeometry(6), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
    this.gridGroup.add(this.gridLines);

    this.brushMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false });
    this.sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this.brushMat);
    this.sphere.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 2)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })));
    this.disc = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.15, 48), this.brushMat);

    this.preview.add(this.pieceGroup, this.digGroup, this.gridGroup, this.sphere, this.disc);
    this.preview.renderOrder = 10;
  }

  get def(): ToolDef {
    return TOOLS[this.tool];
  }

  get size(): number {
    return this.sizes[this.tool];
  }

  get grid(): number {
    return GRID_SIZES[this.gridIndex];
  }

  get material(): number {
    return HOTBAR[this.slot];
  }

  get materialName(): string {
    return MATERIALS[this.material].name;
  }

  /** Short description of the current tool settings for the HUD. */
  describe(): string {
    const g = toMeters(this.grid);
    const def = this.def;
    if (def.grid) {
      const d = this.dims().map((n) => toMeters(n * this.grid).toFixed(2).replace(/\.?0+$/, ''));
      return `${def.name} ${d[0]}×${d[1]}×${d[2]} m · grid ${g} m`;
    }
    return `${def.name} · ${toMeters(this.radius * 2).toFixed(2).replace(/\.?0+$/, '')} m`;
  }

  update(dt: number, input: Input) {
    const k = input.pressed;
    const digits = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
    digits.forEach((key, i) => {
      if (k.has(key) && i < HOTBAR.length) this.slot = i;
    });
    if (k.has('KeyQ')) this.slot = (this.slot + HOTBAR.length - 1) % HOTBAR.length;
    if (k.has('KeyE')) this.slot = (this.slot + 1) % HOTBAR.length;
    if (k.has('KeyT')) this.tool = (this.tool + (input.pressedShift.has('KeyT') ? TOOLS.length - 1 : 1)) % TOOLS.length;
    if (k.has('KeyG')) this.gridIndex = (this.gridIndex + 1) % GRID_SIZES.length;
    if (k.has('KeyR')) this.rotation = (this.rotation + 1) % 4;
    const resize = (delta: number) => {
      this.sizes[this.tool] = Math.max(1, Math.min(this.def.maxSize, this.size + delta));
    };
    if (input.wheel) resize(-input.wheel);
    if (k.has('BracketLeft')) resize(-1);
    if (k.has('BracketRight')) resize(1);
    if (input.pressedCtrl.has('KeyZ')) this.undo();

    this.target = raycast(this.store, this.player.eye, this.player.forward, PLAYER.reach);
    const t = this.target;
    this.buildPiece = t && this.def.grid ? this.placement(t, 'build') : null;
    this.digPiece = t && this.def.grid ? this.placement(t, 'dig') : null;

    if (t && input.clicked.has(1)) this.pick(t);

    this.cooldown -= dt;
    const left = input.clicked.has(0) || (input.buttons.has(0) && this.cooldown <= 0);
    const right = input.clicked.has(2) || (input.buttons.has(2) && this.cooldown <= 0);
    if (t && (left || right)) {
      this.apply(right ? 'build' : 'dig', t);
      this.cooldown = this.def.grid ? 0.25 : 0.15;
    }
    this.updatePreview();
  }

  /** Brush radius in voxels for the terrain tools. */
  get radius(): number {
    return (this.size * this.grid) / 2;
  }

  /** Piece dimensions in grid cells along the frame's (x, up, z), for the current heading. */
  dims(frame?: BuildFrame): [number, number, number] {
    const n = this.size;
    switch (this.def.id) {
      case 'block': return [n, n, n];
      case 'floor': return [n, 1, n];
      case 'pillar': return [1, n, 1];
      case 'wall': return this.facing(frame).axis === 2 ? [n, n, 1] : [1, n, n];
      case 'ramp': return [n, n, n];
      default: return [n, n, n];
    }
  }

  /** The horizontal direction the player faces in the build frame, turned by the rotation key. */
  facing(frame?: BuildFrame): Rise {
    const f = frame ?? frameAt(this.player.pos);
    const hx = this.player.heading.dot(f.x), hz = this.player.heading.dot(f.z);
    const base = Math.abs(hx) > Math.abs(hz) ? (hx > 0 ? 0 : 2) : hz > 0 ? 1 : 3;
    return QUARTER[(base + this.rotation) % 4];
  }

  /**
   * Snap a piece to the grid next to (build) or into (dig) the surface that was hit. Along the
   * hit face's axis it extends away from (or into) the surface; vertically it rises from the
   * target cell; along the remaining axis it is centered.
   */
  placement(hit: Hit, mode: 'build' | 'dig'): Piece {
    const G = this.grid;
    const frame = frameAt(hit.point);
    const nl = [hit.normal.dot(frame.x), hit.normal.dot(frame.y), hit.normal.dot(frame.z)];
    const a = Math.abs(nl[0]) > Math.abs(nl[1]) ? (Math.abs(nl[0]) > Math.abs(nl[2]) ? 0 : 2) : Math.abs(nl[1]) > Math.abs(nl[2]) ? 1 : 2;
    const s = nl[a] > 0 ? 1 : -1;
    const probe = hit.point.clone().addScaledVector(hit.normal, (mode === 'build' ? 0.5 : -0.5) * Math.min(G, 2));
    const l = toLocal(frame, probe);
    const c = [Math.floor(l.x / G), Math.floor(l.y / G), Math.floor(l.z / G)];
    const dims = this.dims(frame);
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const n = dims[k];
      const outward = mode === 'build' ? s : -s;
      if (k === a) {
        lo[k] = outward > 0 ? c[k] : c[k] - n + 1;
      } else if (k === 1) {
        lo[k] = c[k];
      } else {
        lo[k] = c[k] - Math.floor((n - 1) / 2);
      }
      hi[k] = lo[k] + n;
    }
    return {
      frame,
      min: new THREE.Vector3(lo[0] * G, lo[1] * G, lo[2] * G),
      max: new THREE.Vector3(hi[0] * G, hi[1] * G, hi[2] * G),
      ramp: this.def.id === 'ramp' ? this.facing(frame) : null,
    };
  }

  apply(mode: 'dig' | 'build', hit: Hit): number {
    const id = this.def.id;
    const mat = this.material;
    let op: EditOp;
    let min: THREE.Vector3, max: THREE.Vector3;

    if (this.def.grid) {
      const piece = mode === 'build' ? this.buildPiece ?? this.placement(hit, 'build') : this.digPiece ?? this.placement(hit, 'dig');
      return this.applyPiece(piece, mode);
    } else if (id === 'sphere') {
      const r = this.radius;
      const c = mode === 'dig' ? hit.point.clone() : hit.point.clone().addScaledVector(hit.normal, r * 0.85);
      const p = new THREE.Vector3();
      op = mode === 'dig'
        ? (x, y, z, d, m, out) => {
            const sd = Math.hypot(x - c.x, y - c.y, z - c.z) - r;
            if (sd > 4) return false;
            out.d = Math.min(d, sd);
            out.m = m;
            return true;
          }
        : (x, y, z, d, m, out) => {
            const sd = Math.hypot(x - c.x, y - c.y, z - c.z) - r;
            if (sd > 4 || this.player.overlapsPoint(p.set(x, y, z), 1.5)) return false;
            out.d = Math.max(d, -sd);
            out.m = -sd > d - 0.5 && -sd > -1.5 ? mat : m;
            return true;
          };
      min = c.clone().subScalar(r + 4);
      max = c.clone().addScalar(r + 4);
    } else if (id === 'flatten') {
      ({ op, min, max } = this.flattenOp(hit));
    } else {
      ({ op, min, max } = this.smoothOp(hit));
    }

    return this.commit(min, max, op);
  }

  /** Place (build) or cut out (dig) a grid piece with the selected material. */
  applyPiece(piece: Piece, mode: 'dig' | 'build', mat = this.material): number {
    if (mode === 'build' && this.overlapsPlayer(piece)) {
      this.message = 'Blocked: you are standing there';
      return 0;
    }
    const exact = pieceSdf(piece);
    // Inflate (or, when cutting, enlarge) by a hair so pieces that touch face-to-face overlap;
    // otherwise samples on the shared face quantize to exactly 0 and leave an air seam.
    // Mesh snapping puts the faces back on the grid plane.
    const grow = 0.03;
    const sdf = (x: number, y: number, z: number) => exact(x, y, z) - grow;
    const op: EditOp = mode === 'build'
      ? (x, y, z, d, m, out) => {
          const sd = sdf(x, y, z);
          if (sd > 2.5) return false;
          if (sd <= 0) {
            out.d = Math.max(d, -sd);
            out.m = -sd >= d - 0.25 ? mat : m;
            return true;
          }
          if (d > 0) return false; // solid ground or another piece stays as it is
          // Air next to the piece takes the piece's exact distance, so its faces mesh flat. Air
          // already shaped by other pieces keeps the union (max); terrain air is replaced, since
          // the terrain's field there would skew the piece's crossings and normals.
          out.d = MATERIAL_CONSTRUCT[m] ? Math.max(d, -sd) : -sd;
          out.m = sd < 1.5 && -sd >= d - 0.25 ? mat : m;
          return true;
        }
      : (x, y, z, d, m, out) => {
          const sd = sdf(x, y, z);
          if (sd > 3) return false;
          out.d = Math.min(d, sd);
          out.m = m;
          return true;
        };
    const { min, max } = worldBounds(piece, 3);
    return this.commit(min, max, op);
  }

  private commit(min: THREE.Vector3, max: THREE.Vector3, op: EditOp): number {
    const { changed, dirty, undo } = this.store.edit([min.x, min.y, min.z], [max.x, max.y, max.z], op);
    if (undo) {
      this.undoStack.push(undo);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.terrain.remesh(dirty);
    }
    this.lastChanged = changed;
    return changed;
  }

  undo() {
    const rec = this.undoStack.pop();
    if (!rec) {
      this.message = 'Nothing to undo';
      return;
    }
    this.terrain.remesh(this.store.revert(rec));
    this.message = 'Undone';
  }

  /** Middle click: select the hotbar material you are looking at. */
  private pick(hit: Hit) {
    const p = hit.point.clone().addScaledVector(hit.normal, -0.6);
    const m = this.store.material(Math.round(p.x), Math.round(p.y), Math.round(p.z));
    const i = HOTBAR.indexOf(m);
    if (i >= 0) {
      this.slot = i;
      this.message = `Picked ${MATERIALS[m].name}`;
    } else {
      this.message = `${MATERIALS[m]?.name ?? 'That'} isn't in the hotbar`;
    }
  }

  /** Level the ground to the nearest grid height within a soft-edged disc. */
  private flattenOp(hit: Hit) {
    const frame = frameAt(hit.point);
    const G = this.grid;
    const l = toLocal(frame, hit.point);
    const h0 = Math.round(l.y / G) * G;
    const r = this.radius;
    const below = hit.point.clone().addScaledVector(hit.normal, -0.6);
    let fill = this.store.material(Math.round(below.x), Math.round(below.y), Math.round(below.z));
    if (!fill) fill = this.material;
    const tmp = new THREE.Vector3();
    const q = new THREE.Vector3();
    const op: EditOp = (x, y, z, d, m, out) => {
      toLocal(frame, tmp.set(x, y, z), q);
      const dist = Math.hypot(q.x - l.x, q.z - l.z);
      if (dist > r + 2) return false;
      if (this.player.overlapsPoint(tmp, 1) && h0 - q.y > 0) return false;
      const w = Math.min(1, (r + 2 - dist) / 4);
      const target = Math.max(-4, Math.min(4, h0 - q.y));
      out.d = d + (target - d) * w;
      out.m = d <= 0 && out.d > 0 ? fill : m;
      return true;
    };
    const centre = toWorld(frame, new THREE.Vector3(l.x, h0, l.z));
    const ext = r + 4 + Math.abs(l.y - h0);
    return { op, min: centre.clone().subScalar(ext + 8), max: centre.clone().addScalar(ext + 8) };
  }

  /** Blur the density field inside a sphere. */
  private smoothOp(hit: Hit) {
    const r = this.radius;
    const c = hit.point.clone();
    const x0 = Math.floor(c.x - r - 2), y0 = Math.floor(c.y - r - 2), z0 = Math.floor(c.z - r - 2);
    const n = Math.ceil(2 * r + 5);
    // Snapshot first so the blur reads the original field, not partially written values.
    const snap = new Float32Array(n * n * n);
    const mats = new Uint8Array(n * n * n);
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const s = i + (j + k * n) * n;
          snap[s] = this.store.density(x0 + i, y0 + j, z0 + k);
          mats[s] = this.store.material(x0 + i, y0 + j, z0 + k);
        }
    const at = (i: number, j: number, k: number) => snap[Math.max(0, Math.min(n - 1, i)) + (Math.max(0, Math.min(n - 1, j)) + Math.max(0, Math.min(n - 1, k)) * n) * n];
    const op: EditOp = (x, y, z, d, m, out) => {
      const dist = Math.hypot(x - c.x, y - c.y, z - c.z);
      if (dist > r) return false;
      const i = x - x0, j = y - y0, k = z - z0;
      const avg = (at(i - 1, j, k) + at(i + 1, j, k) + at(i, j - 1, k) + at(i, j + 1, k) + at(i, j, k - 1) + at(i, j, k + 1) + 2 * d) / 8;
      const w = 0.6 * Math.min(1, (r - dist) / 2 + 0.3);
      out.d = d + (avg - d) * w;
      out.m = m;
      if (d <= 0 && out.d > 0) {
        // Newly solid: borrow the material of the most solid neighbour.
        let best = -Infinity;
        for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const ii = Math.max(0, Math.min(n - 1, i + di)), jj = Math.max(0, Math.min(n - 1, j + dj)), kk = Math.max(0, Math.min(n - 1, k + dk));
          const s = ii + (jj + kk * n) * n;
          if (snap[s] > best) { best = snap[s]; out.m = mats[s]; }
        }
      }
      return true;
    };
    return { op, min: c.clone().subScalar(r + 1), max: c.clone().addScalar(r + 1) };
  }

  private overlapsPlayer(piece: Piece): boolean {
    const lp = toLocal(piece.frame, this.player.pos);
    const r = PLAYER.radius;
    return (
      lp.x + r > piece.min.x && lp.x - r < piece.max.x &&
      lp.z + r > piece.min.z && lp.z - r < piece.max.z &&
      lp.y + PLAYER.height > piece.min.y && lp.y < piece.max.y
    );
  }

  private updatePreview() {
    const t = this.target;
    this.preview.visible = !!t;
    this.pieceGroup.visible = this.digGroup.visible = this.gridGroup.visible = false;
    this.sphere.visible = this.disc.visible = false;
    if (!t) return;
    const color = hexColor(this.material);

    if (this.def.grid && this.buildPiece && this.digPiece) {
      const bp = this.buildPiece;
      placePiece(this.pieceGroup, bp);
      const sx = bp.max.x - bp.min.x, sy = bp.max.y - bp.min.y, sz = bp.max.z - bp.min.z;
      if (bp.ramp) {
        this.ghost.geometry = this.ghostWedge;
        this.ghostEdges.geometry = this.wedgeEdges;
        // The wedge rises along its own +X; turn it toward the rise direction.
        const turn = bp.ramp.axis === 0 ? (bp.ramp.sign > 0 ? 0 : Math.PI) : bp.ramp.sign > 0 ? -Math.PI / 2 : Math.PI / 2;
        this.ghost.rotation.set(0, turn, 0);
        this.ghost.scale.set(bp.ramp.axis === 0 ? sx : sz, sy, bp.ramp.axis === 0 ? sz : sx);
      } else {
        this.ghost.geometry = this.ghostBox;
        this.ghostEdges.geometry = this.boxEdges;
        this.ghost.rotation.set(0, 0, 0);
        this.ghost.scale.set(sx, sy, sz);
      }
      this.ghostMat.color.set(color);
      this.pieceGroup.visible = true;

      const dp = this.digPiece;
      placePiece(this.digGroup, dp);
      this.digWire.scale.set(dp.max.x - dp.min.x + 0.04, dp.max.y - dp.min.y + 0.04, dp.max.z - dp.min.z + 0.04);
      this.digGroup.visible = true;

      this.placeGrid(t, bp);
      return;
    }

    const r = this.radius;
    if (this.def.id === 'flatten') {
      const frame = frameAt(t.point);
      const l = toLocal(frame, t.point);
      l.y = Math.round(l.y / this.grid) * this.grid;
      toWorld(frame, l, this.disc.position);
      this.disc.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.x, frame.y, frame.z));
      this.disc.scale.set(r, 1, r);
      this.brushMat.color.set(0xffffff);
      this.disc.visible = true;
    } else {
      const c = t.point.clone();
      this.sphere.position.copy(c);
      this.sphere.scale.setScalar(r);
      this.brushMat.color.set(this.def.id === 'smooth' ? 0xffffff : color);
      this.sphere.visible = true;
    }
  }

  /** A faint grid on the plane of the face being built against, centered on the target cell. */
  private placeGrid(hit: Hit, piece: Piece) {
    const f = piece.frame;
    const G = this.grid;
    const nl = [hit.normal.dot(f.x), hit.normal.dot(f.y), hit.normal.dot(f.z)];
    const a = Math.abs(nl[0]) > Math.abs(nl[1]) ? (Math.abs(nl[0]) > Math.abs(nl[2]) ? 0 : 2) : Math.abs(nl[1]) > Math.abs(nl[2]) ? 1 : 2;
    const l = toLocal(f, hit.point);
    const coords = [l.x, l.y, l.z];
    const pmin = [piece.min.x, piece.min.y, piece.min.z], pmax = [piece.max.x, piece.max.y, piece.max.z];
    // Plane sits on the piece face touching the surface; other axes snap to grid lines.
    const plane = nl[a] > 0 ? pmin[a] : pmax[a];
    const centre = [0, 0, 0];
    for (let k = 0; k < 3; k++) centre[k] = k === a ? plane + (nl[a] > 0 ? 0.03 : -0.03) : Math.round(coords[k] / G) * G;
    this.gridGroup.position.copy(toWorld(f, new THREE.Vector3(centre[0], centre[1], centre[2])));
    this.gridGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.x, f.y, f.z));
    this.gridLines.rotation.set(a === 2 ? Math.PI / 2 : 0, 0, a === 0 ? -Math.PI / 2 : 0);
    this.gridLines.scale.setScalar(G);
    this.gridGroup.visible = true;
  }
}

/** Position a group at a piece's center with the build frame's orientation. */
function placePiece(group: THREE.Object3D, p: Piece) {
  const c = new THREE.Vector3().addVectors(p.min, p.max).multiplyScalar(0.5);
  group.position.copy(toWorld(p.frame, c));
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(p.frame.x, p.frame.y, p.frame.z));
}

/** World-space bounding box of a piece, padded by `pad` voxels. */
function worldBounds(p: Piece, pad: number) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? p.max.x : p.min.x, i & 2 ? p.max.y : p.min.y, i & 4 ? p.max.z : p.min.z);
    const w = toWorld(p.frame, v);
    min.min(w);
    max.max(w);
  }
  return { min: min.subScalar(pad), max: max.addScalar(pad) };
}

/** Unit wedge in [-0.5, 0.5]^3 rising along +X (low edge at x = -0.5, top edge at x = +0.5). */
function wedgeGeometry(): THREE.BufferGeometry {
  const v = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], // bottom
    [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], // top edge
  ];
  const tris = [
    [0, 1, 2], [0, 2, 3], // bottom (facing down)
    [1, 4, 5], [1, 5, 2], // back wall at x = +0.5
    [0, 3, 5], [0, 5, 4], // slope
    [0, 4, 1], // side z = -0.5
    [3, 2, 5], // side z = +0.5
  ];
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Grid lines on the XZ plane from -n to n (unit spacing). */
function gridGeometry(n: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let i = -n; i <= n; i++) {
    pos.push(i, 0, -n, i, 0, n);
    pos.push(-n, 0, i, n, 0, i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
