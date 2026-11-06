# Voxel Planet

A fully destructible, smooth-voxel sandbox on a round planet, running in the browser
(TypeScript + Three.js + Web Workers).

- **Round world.** The planet radius is 6 km, so a lap is ~37.7 km: about 2 hours at a jog.
  Gravity points to the center, and you can walk, fly or dig all the way around.
- **Smooth voxels.** Voxels are 25 cm and store a density value, not a block type. Terrain is
  meshed with Surface Nets, so it reads as natural ground rather than cubes, and every voxel can
  still be dug out or built up.
- **Biomes.** Ocean, beach, plains, forest, desert, tundra, taiga and mountains (with snow caps).
  They're driven by continent, climate (latitude and altitude) and moisture noise. Trees and
  cacti are voxels too.
- **Persistence.** Edited chunks are kept and override the procedural world wherever they're
  meshed, at any level of detail.

## Running

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # static build in dist/
npm run build:single   # one self-contained HTML file in dist-single/index.html
```

URL options: `?seed=anything` picks a different planet; `?workers=0` forces main-thread
generation (for debugging).

## Controls

| Input | Action |
| --- | --- |
| WASD / Space / Shift | Move / jump / sprint |
| F / N | Fly mode (speed scales with altitude) / no-clip |
| C | Fly down |
| T, Shift+T | Next / previous tool |
| Right mouse | Place a piece / add terrain |
| Left mouse | Remove a piece / dig |
| Middle mouse | Pick the material you're looking at |
| Wheel or `[` `]` | Tool size |
| G | Grid size: 0.25, 0.5, 1 or 2 m |
| R | Rotate walls and ramps |
| 1–0, Q/E | Select material |
| Ctrl+Z | Undo |
| H | Help |

### Building

Grid tools (**Block, Wall, Floor, Pillar, Ramp**) snap to a build grid that is level with the
ground wherever you stand on the planet. Grids are anchored on a fixed lattice (one anchor about
every 128 m), so a building always lines up with itself when you come back to extend it. A ghost
shows where a piece will go, with a red outline for what left-click would remove. Pieces sit on
the face you aim at, rise from it, and line up with the cells around them.

Terrain tools sculpt smoothly: **Terrain** digs or adds a sphere, **Flatten** levels ground to
the nearest grid height (handy before laying a floor), and **Smooth** softens rough ground.

Construction materials (stone block, planks, brick, concrete, metal, glass, clay) are meshed with
sharp edges and flat faces. Natural materials (dirt, stone, sand) stay smooth.

## Architecture

| Path | Role |
| --- | --- |
| `src/world/planet.ts` | Height field over the sphere, biomes, caves, tree SDFs, cube-sphere face coordinates |
| `src/world/volume.ts` | Generates a chunk's padded density/material volume (height lattice + interpolation), applies edit overlays |
| `src/world/surfaceNets.ts` | Hybrid mesher: smooth Surface Nets for terrain; dual contouring for construction materials, with hermite normals and vertices snapped to the build grid so pieces come out flat-faced and sharp |
| `src/world/job.ts`, `terrain.worker.ts`, `WorkerPool.ts` | Off-thread generate+mesh jobs, with main-thread fallback |
| `src/world/Terrain.ts` | Octree LOD around the viewer; swaps meshes only once their replacements are ready |
| `src/world/VoxelStore.ts` | Full-resolution voxels near the player (cache + edited chunks), density queries, smooth edits |
| `src/player/Player.ts` | Spherical-gravity character controller against the density field |
| `src/tools/BuildGrid.ts` | Build frames on the sphere, grid pieces and their signed distance fields |
| `src/tools/Tools.ts` | Raymarched targeting, grid pieces, terrain brushes, previews and undo |
| `src/render/` | Terrain material (procedural detail), sky dome, camera-centered ocean |

Units are voxels throughout (1 voxel = 0.25 m). Chunks are 32³ voxels at LOD 0; each LOD level
doubles the voxel size.
