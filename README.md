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
| F | Fly mode (speed scales with altitude, so you can reach orbit) |
| N | No-clip |
| C | Fly down |
| Left mouse | Dig (hold to repeat) |
| Right mouse | Build with the selected material |
| Wheel or `[` `]` | Brush size |
| B | Brush shape: sphere / cube (cubes align to local up and your heading) |
| 1–0, Q/E | Select material |
| H | Help |

## Architecture

| Path | Role |
| --- | --- |
| `src/world/planet.ts` | Height field over the sphere, biomes, caves, tree SDFs, cube-sphere face coordinates |
| `src/world/volume.ts` | Generates a chunk's padded density/material volume (height lattice + interpolation), applies edit overlays |
| `src/world/surfaceNets.ts` | Surface Nets mesher with gradient normals and slope-aware coloring |
| `src/world/job.ts`, `terrain.worker.ts`, `WorkerPool.ts` | Off-thread generate+mesh jobs, with main-thread fallback |
| `src/world/Terrain.ts` | Octree LOD around the viewer; swaps meshes only once their replacements are ready |
| `src/world/VoxelStore.ts` | Full-resolution voxels near the player (cache + edited chunks), density queries, smooth edits |
| `src/player/Player.ts` | Spherical-gravity character controller against the density field |
| `src/tools/Tools.ts` | Raymarched targeting and dig/build brushes |
| `src/render/` | Terrain material (procedural detail), sky dome, camera-centered ocean |

Units are voxels throughout (1 voxel = 0.25 m). Chunks are 32³ voxels at LOD 0; each LOD level
doubles the voxel size.
