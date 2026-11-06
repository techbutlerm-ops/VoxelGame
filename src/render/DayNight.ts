import * as THREE from 'three';

/** Real seconds per in-game day. */
export const DAY_SECONDS = 20 * 60;
/** Tilt of the sun's path (declination): poles get midnight sun or polar night. */
const DECLINATION = 0.35;

/**
 * The sun circles the planet once per in-game day, so local time depends on where you stand:
 * the far side of the planet is in night. The moon sits opposite the sun.
 */
export class DayNight {
  /** Seconds since the start of the game clock. */
  time = 0;
  /** Angle of the sun around the planet axis at time 0. */
  private phase = 0;
  readonly sun = new THREE.Vector3();
  readonly moon = new THREE.Vector3();

  /** Start the clock so that it is `hour` o'clock at `up` (a unit direction). */
  setLocalHour(up: THREE.Vector3, hour: number) {
    const lon = Math.atan2(up.z, up.x);
    this.phase = lon + ((hour - 12) * Math.PI) / 12 - (this.time / DAY_SECONDS) * Math.PI * 2;
  }

  update(dt: number) {
    this.time += dt;
    const theta = this.phase + (this.time / DAY_SECONDS) * Math.PI * 2;
    const c = Math.cos(DECLINATION);
    this.sun.set(Math.cos(theta) * c, Math.sin(DECLINATION), Math.sin(theta) * c);
    // The moon: roughly opposite, a little off so it isn't hidden behind the planet's shadow.
    this.moon.set(-Math.cos(theta + 0.3) * c, -Math.sin(DECLINATION) * 0.6 + 0.2, -Math.sin(theta + 0.3) * c).normalize();
  }

  /** Local solar time (0-24) at a unit direction. */
  localHour(up: THREE.Vector3): number {
    const lon = Math.atan2(up.z, up.x);
    const theta = this.phase + (this.time / DAY_SECONDS) * Math.PI * 2;
    let h = 12 + ((theta - lon) * 12) / Math.PI;
    h = ((h % 24) + 24) % 24;
    return h;
  }

  /** "08:30" for the HUD. */
  clock(up: THREE.Vector3): string {
    const h = this.localHour(up);
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /** Skip ahead by some hours. */
  advance(hours: number) {
    this.time += (hours / 24) * DAY_SECONDS;
  }
}

// Linear falloff (decay 1) keeps lamps from blowing out nearby walls while still reaching ~15 m.
const LAMP_INTENSITY = 24;
const FLASHLIGHT_INTENSITY = 60;

/** Lamps placed in the world: positions, kept valid, and lit by a fixed pool of point lights. */
export class LightPool {
  readonly group = new THREE.Group();
  /** Lamp centres (world). */
  readonly lamps: THREE.Vector3[] = [];
  private pool: THREE.PointLight[] = [];
  /** Used by explosions; part of the pool so the light count never changes (no recompiles). */
  readonly flash: THREE.PointLight;
  readonly flashlight: THREE.SpotLight;
  flashlightOn = false;

  constructor(size = 6) {
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffc27a, 0, 80, 1);
      this.pool.push(l);
      this.group.add(l);
    }
    this.flash = new THREE.PointLight(0xffa64d, 0, 120, 1.6);
    this.group.add(this.flash);
    this.flashlight = new THREE.SpotLight(0xfff2dd, 0, 160, Math.PI / 7, 0.45, 1);
    this.group.add(this.flashlight, this.flashlight.target);
  }

  addLamp(p: THREE.Vector3) {
    this.lamps.push(p.clone());
  }

  /**
   * Drop lamps whose block is gone (dug out, blasted, fallen) and light the nearest ones.
   * `exists` checks whether a lamp is still there.
   */
  update(viewer: THREE.Vector3, eye: THREE.Vector3, forward: THREE.Vector3, exists: (p: THREE.Vector3) => boolean) {
    for (let i = this.lamps.length - 1; i >= 0; i--) if (!exists(this.lamps[i])) this.lamps.splice(i, 1);
    const near = this.lamps
      .map((p) => ({ p, d: p.distanceToSquared(viewer) }))
      .filter((x) => x.d < 260 * 260)
      .sort((a, b) => a.d - b.d);
    this.pool.forEach((light, i) => {
      const lamp = near[i];
      light.intensity = lamp ? LAMP_INTENSITY : 0;
      if (lamp) light.position.copy(lamp.p);
    });
    this.flashlight.intensity = this.flashlightOn ? FLASHLIGHT_INTENSITY : 0;
    this.flashlight.position.copy(eye);
    this.flashlight.target.position.copy(eye).addScaledVector(forward, 20);
  }
}
