// Material registry. Index 0 is air. Colors are sRGB, tuned for a soft, painterly look.

export interface Material {
  id: number;
  name: string;
  color: number;
  /** Material shown instead on steep slopes (grass becomes dirt/rock on cliffs). */
  cliff?: number;
  /** Construction material: meshed with sharp edges and flat faces instead of smooth terrain. */
  construct?: boolean;
  /** How far (voxels, horizontally) a construction material can span from its support. */
  strength?: number;
  /** Relative mass per voxel, used later by structural physics. */
  density: number;
  buildable: boolean;
}

export const AIR = 0;

export const M = {
  STONE: 1,
  DARK_STONE: 2,
  DIRT: 3,
  GRASS: 4,
  MEADOW: 5,
  FOREST_FLOOR: 6,
  COLD_GRASS: 7,
  SAND: 8,
  SANDSTONE: 9,
  SNOW: 10,
  GRAVEL: 11,
  WOOD: 12,
  LEAVES: 13,
  PINE: 14,
  CACTUS: 15,
  PLANKS: 16,
  BRICK: 17,
  CONCRETE: 18,
  METAL: 19,
  GLASS: 20,
  CLAY: 21,
  ICE: 22,
  STONE_BLOCK: 23,
  LAMP: 24,
} as const;

const defs: Omit<Material, 'id'>[] = [];
const def = (id: number, m: Omit<Material, 'id'>) => (defs[id] = m);

def(M.STONE, { name: 'Stone', color: 0x8b8a86, density: 2.6, buildable: true });
def(M.DARK_STONE, { name: 'Basalt', color: 0x55555a, density: 3.0, buildable: true });
def(M.DIRT, { name: 'Dirt', color: 0x75573c, density: 1.5, buildable: true });
def(M.GRASS, { name: 'Grass', color: 0x6f9e45, cliff: M.DIRT, density: 1.4, buildable: false });
def(M.MEADOW, { name: 'Meadow', color: 0x93a855, cliff: M.DIRT, density: 1.4, buildable: false });
def(M.FOREST_FLOOR, { name: 'Moss', color: 0x4f7d34, cliff: M.DIRT, density: 1.4, buildable: false });
def(M.COLD_GRASS, { name: 'Tundra', color: 0x7f9572, cliff: M.STONE, density: 1.4, buildable: false });
def(M.SAND, { name: 'Sand', color: 0xe0cc9c, cliff: M.SANDSTONE, density: 1.6, buildable: true });
def(M.SANDSTONE, { name: 'Sandstone', color: 0xc99f69, density: 2.2, buildable: true });
def(M.SNOW, { name: 'Snow', color: 0xf1f4f8, cliff: M.STONE, density: 0.4, buildable: true });
def(M.GRAVEL, { name: 'Gravel', color: 0x8f897f, density: 1.8, buildable: true });
def(M.WOOD, { name: 'Wood', color: 0x6e4c31, density: 0.7, buildable: true });
def(M.LEAVES, { name: 'Leaves', color: 0x548f37, density: 0.2, buildable: true });
def(M.PINE, { name: 'Pine', color: 0x325f3c, density: 0.2, buildable: false });
def(M.CACTUS, { name: 'Cactus', color: 0x5f8f3e, density: 0.5, buildable: false });
def(M.PLANKS, { construct: true, strength: 12, name: 'Planks', color: 0xb98a55, density: 0.6, buildable: true });
def(M.BRICK, { construct: true, strength: 12, name: 'Brick', color: 0xa5503a, density: 1.9, buildable: true });
def(M.CONCRETE, { construct: true, strength: 20, name: 'Concrete', color: 0xbdbcb5, density: 2.4, buildable: true });
def(M.METAL, { construct: true, strength: 32, name: 'Metal', color: 0x9aa4ae, density: 7.8, buildable: true });
def(M.GLASS, { construct: true, strength: 4, name: 'Glass', color: 0xc4e6f0, density: 2.5, buildable: true });
def(M.CLAY, { construct: true, strength: 8, name: 'Clay', color: 0xb5795a, density: 1.8, buildable: true });
def(M.ICE, { name: 'Ice', color: 0xbcdcea, density: 0.9, buildable: false });
def(M.LAMP, { construct: true, strength: 4, name: 'Lamp', color: 0xffd58a, density: 1.2, buildable: false });
def(M.STONE_BLOCK, { construct: true, strength: 10, name: 'Stone Block', color: 0x9c9890, density: 2.6, buildable: true });

/** Rubble: broken construction material keeps its color (a little darker) but meshes smooth. */
export const RUBBLE_OFFSET = 32;
for (const [id, m] of defs.entries()) {
  if (!m?.construct) continue;
  const c = m.color;
  const dark = (v: number) => Math.round(v * 0.82);
  def(id + RUBBLE_OFFSET, {
    name: `${m.name} rubble`,
    color: (dark((c >> 16) & 255) << 16) | (dark((c >> 8) & 255) << 8) | dark(c & 255),
    density: m.density,
    buildable: false,
  });
}

export const MATERIALS: Material[] = defs.map((m, id) => ({ ...m, id }));

/** The rubble variant of a material (natural materials are their own rubble). */
export function rubbleOf(id: number): number {
  return MATERIALS[id]?.construct ? id + RUBBLE_OFFSET : id;
}

/** Mass per voxel, by material id. */
export const MATERIAL_DENSITY = new Float32Array(64).fill(1);
/** Span strength in voxels for construction materials (0 for natural ones). */
export const MATERIAL_STRENGTH = new Float32Array(64);

/** Materials offered in the hotbar, in slot order (keys 1-9, 0). */
export const HOTBAR: number[] = [
  M.STONE_BLOCK,
  M.PLANKS,
  M.BRICK,
  M.CONCRETE,
  M.METAL,
  M.GLASS,
  M.CLAY,
  M.DIRT,
  M.STONE,
  M.SAND,
];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Linear RGB per material (for vertex colors) and the id of the cliff variant. */
export const MATERIAL_LINEAR = new Float32Array(64 * 3);
export const MATERIAL_CLIFF = new Uint8Array(64);
export const MATERIAL_CONSTRUCT = new Uint8Array(64);
for (const m of MATERIALS) {
  if (!m) continue;
  MATERIAL_LINEAR[m.id * 3] = srgbToLinear(((m.color >> 16) & 255) / 255);
  MATERIAL_LINEAR[m.id * 3 + 1] = srgbToLinear(((m.color >> 8) & 255) / 255);
  MATERIAL_LINEAR[m.id * 3 + 2] = srgbToLinear((m.color & 255) / 255);
  MATERIAL_CLIFF[m.id] = m.cliff ?? m.id;
  MATERIAL_CONSTRUCT[m.id] = m.construct ? 1 : 0;
  MATERIAL_DENSITY[m.id] = m.density;
  MATERIAL_STRENGTH[m.id] = m.strength ?? 0;
}

export function hexColor(id: number): string {
  return '#' + MATERIALS[id].color.toString(16).padStart(6, '0');
}
