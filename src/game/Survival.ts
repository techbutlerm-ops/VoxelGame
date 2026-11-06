import { M, MATERIALS, RUBBLE_OFFSET } from '../world/materials';

export type Mode = 'survival' | 'creative';

/** Raw resources, in display order. Basalt is the deep dark stone. */
export const RESOURCES = [M.DIRT, M.STONE, M.SAND, M.GRAVEL, M.WOOD, M.DARK_STONE] as const;

export const RESOURCE_NAMES: Record<number, string> = {
  [M.DIRT]: 'Dirt',
  [M.STONE]: 'Stone',
  [M.SAND]: 'Sand',
  [M.GRAVEL]: 'Gravel',
  [M.WOOD]: 'Wood',
  [M.DARK_STONE]: 'Basalt',
};

type Recipe = Partial<Record<number, number>>;

/** What one voxel of a material costs to place, in raw resources. */
const RECIPES: Record<number, Recipe> = {
  [M.DIRT]: { [M.DIRT]: 1 },
  [M.STONE]: { [M.STONE]: 1 },
  [M.SAND]: { [M.SAND]: 1 },
  [M.GRAVEL]: { [M.GRAVEL]: 1 },
  [M.WOOD]: { [M.WOOD]: 1 },
  [M.STONE_BLOCK]: { [M.STONE]: 1 },
  [M.PLANKS]: { [M.WOOD]: 0.5 },
  [M.BRICK]: { [M.DIRT]: 1 },
  [M.CLAY]: { [M.DIRT]: 1 },
  [M.CONCRETE]: { [M.STONE]: 0.5, [M.SAND]: 0.5 },
  [M.GLASS]: { [M.SAND]: 1 },
  [M.METAL]: { [M.DARK_STONE]: 2 },
};

/** What digging one voxel of a natural material yields. */
const YIELD: Record<number, number> = {
  [M.DIRT]: M.DIRT, [M.GRASS]: M.DIRT, [M.MEADOW]: M.DIRT, [M.FOREST_FLOOR]: M.DIRT, [M.COLD_GRASS]: M.DIRT,
  [M.STONE]: M.STONE, [M.SANDSTONE]: M.STONE,
  [M.SAND]: M.SAND,
  [M.GRAVEL]: M.GRAVEL,
  [M.WOOD]: M.WOOD,
  [M.DARK_STONE]: M.DARK_STONE,
};

/** Explosive charge: a little stone and sand per blast. */
export const BLAST_COST: Recipe = { [M.STONE]: 10, [M.SAND]: 10 };

/** Impact speed (voxels/s of velocity lost in a collision) you can take without harm: a ~3 m fall. */
const SAFE_IMPACT = 32;
const IMPACT_DAMAGE = 3.6;
const REGEN_DELAY = 5;
const REGEN_RATE = 4;

/**
 * Survival rules: health, damage and an inventory of raw resources. Digging collects what you
 * dig; building spends it through simple recipes; removing your own builds refunds them.
 */
export class Survival {
  mode: Mode = 'survival';
  health = 100;
  readonly maxHealth = 100;
  readonly inventory = new Map<number, number>(RESOURCES.map((r) => [r, 0]));
  private sinceHurt = 99;
  /** Set when the player dies; cleared on respawn. */
  dead = false;
  /** Damage taken this frame (for the red flash). */
  hurt = 0;
  deathCause = '';

  get creative() {
    return this.mode === 'creative';
  }

  /** Raw cost of turning `counts` (material -> voxels) solid. */
  cost(counts: Map<number, number>): Map<number, number> {
    const total = new Map<number, number>();
    for (const [mat, n] of counts) {
      const recipe = RECIPES[mat] ?? RECIPES[YIELD[mat]] ?? { [M.DIRT]: 1 };
      for (const [res, per] of Object.entries(recipe)) total.set(+res, (total.get(+res) ?? 0) + per! * n);
    }
    return total;
  }

  /** Can we pay for this? Returns null if so, else a message naming what's missing. */
  check(cost: Map<number, number> | Recipe): string | null {
    if (this.creative) return null;
    const entries = cost instanceof Map ? [...cost] : Object.entries(cost).map(([k, v]) => [+k, v!] as [number, number]);
    const missing = entries
      .filter(([res, need]) => (this.inventory.get(res) ?? 0) + 1e-6 < need)
      .map(([res, need]) => `${Math.ceil(need - (this.inventory.get(res) ?? 0))} ${RESOURCE_NAMES[res] ?? MATERIALS[res].name}`);
    return missing.length ? `Need ${missing.join(' and ')} more` : null;
  }

  pay(cost: Map<number, number> | Recipe) {
    if (this.creative) return;
    const entries = cost instanceof Map ? [...cost] : Object.entries(cost).map(([k, v]) => [+k, v!] as [number, number]);
    for (const [res, need] of entries) this.inventory.set(res, Math.max(0, (this.inventory.get(res) ?? 0) - need));
  }

  /** Collect what was dug out (materials of the removed voxels). */
  collect(mats: number[]) {
    if (this.creative) return;
    for (const m of mats) {
      if (YIELD[m] !== undefined) {
        this.add(YIELD[m], 1);
        continue;
      }
      // Construction material refunds its recipe; rubble refunds half.
      const rubble = m >= RUBBLE_OFFSET && MATERIALS[m - RUBBLE_OFFSET]?.construct;
      const recipe = RECIPES[rubble ? m - RUBBLE_OFFSET : m];
      if (!recipe || (!rubble && !MATERIALS[m]?.construct)) continue; // leaves, snow, ice: nothing
      for (const [res, per] of Object.entries(recipe)) this.add(+res, per! * (rubble ? 0.5 : 1));
    }
  }

  private add(res: number, n: number) {
    this.inventory.set(res, (this.inventory.get(res) ?? 0) + n);
  }

  /** How many voxels of a material we could place right now. */
  affordable(mat: number): number {
    if (this.creative) return Infinity;
    const recipe = RECIPES[mat];
    if (!recipe) return 0;
    let n = Infinity;
    for (const [res, per] of Object.entries(recipe)) n = Math.min(n, Math.floor((this.inventory.get(+res) ?? 0) / per!));
    return n;
  }

  /** Damage from a collision that stopped `speed` voxels/s of motion. */
  impact(speed: number, cause: string) {
    if (speed > SAFE_IMPACT) this.damage((speed - SAFE_IMPACT) * IMPACT_DAMAGE, cause);
  }

  damage(amount: number, cause: string) {
    if (this.creative || this.dead || amount <= 0) return;
    this.health -= amount;
    this.hurt += amount;
    this.sinceHurt = 0;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.deathCause = cause;
    }
  }

  update(dt: number) {
    this.sinceHurt += dt;
    if (!this.dead && this.sinceHurt > REGEN_DELAY) this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt);
  }

  respawn() {
    this.dead = false;
    this.health = this.maxHealth;
    this.sinceHurt = 99;
  }
}
