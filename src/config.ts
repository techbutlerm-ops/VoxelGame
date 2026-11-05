// Global tuning constants. All distances are in voxels unless noted.
// One voxel is 0.25 m. The planet radius is 6 km, so a full lap at a jog (~5 m/s) takes about 2 hours.

export const VOXEL_METERS = 0.25;
export const toMeters = (v: number) => v * VOXEL_METERS;

/** Planet radius at sea level. */
export const PLANET_RADIUS = 24000;
/** Terrain height bounds relative to sea level (used for culling and quick rejects). */
export const H_MIN = -480;
export const H_MAX = 1100;
/** Caves are carved down to this depth below the surface. */
export const CAVE_DEPTH = 240;
/** Tallest tree above the ground. */
export const TREE_MAX = 64;

/** Cells per chunk edge. Chunk at LOD level L spans CHUNK << L voxels. */
export const CHUNK = 32;
/** Samples per padded chunk edge: positions -2..34 (margin for seams and LOD overlap). */
export const PAD = 2;
export const SAMPLES = CHUNK + 2 * PAD + 1;
/** Highest octree level (root node size CHUNK << MAX_LEVEL must contain the planet). */
export const MAX_LEVEL = 11;
/** A node splits while the viewer is closer than SPLIT_K * node size. */
export const SPLIT_K = 1.15;

/** Stored densities are clamped to +/- this many voxels (positive = solid). */
export const DENSITY_CLAMP = 4;

export const PLAYER = {
  radius: 1.4,
  height: 7.2,
  eyeHeight: 6.6,
  walkSpeed: 18,
  sprintSpeed: 30,
  flySpeed: 60,
  flySprintSpeed: 600,
  jumpVelocity: 19,
  gravity: 39.2,
  terminalVelocity: 220,
  reach: 48,
};
