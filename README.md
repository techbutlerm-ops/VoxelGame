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
- **Structural physics.** Remove what holds something up and it breaks off, falls under planet
  gravity, smashes into rubble on hard landings, and settles back into the world as voxels.
  Buildings obey material span limits, debris collides with everything, and explosives demolish.
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

## Survival and creative

The start screen offers both modes; **M** switches between them in game.

- **Survival.** 100 health that regenerates after a few seconds without damage. Hard impacts
  hurt: a fall of more than about 3 m (12 m is fatal), being hit by falling debris, or being
  slammed into the ground by a blast. Being near a blast also hurts. Digging collects raw
  resources, and building spends them:

  | Build with | Costs per voxel |
  | --- | --- |
  | Dirt, Stone, Sand | 1 of the same |
  | Stone Block | 1 Stone |
  | Planks | ½ Wood |
  | Brick, Clay | 1 Dirt |
  | Concrete | ½ Stone + ½ Sand |
  | Glass | 1 Sand |
  | Metal | 2 Basalt (the dark stone ~40 m down) |
  | Blast charge | 10 Stone + 10 Sand |

  Grass and soil give Dirt, sandstone gives Stone, and tree trunks give Wood. Removing your own
  builds refunds their cost, and rubble refunds half. Flying and undo are off.
- **Creative.** No damage, unlimited materials, flying (F), no-clip (N) and undo (Ctrl+Z).

## Controls

| Input | Action |
| --- | --- |
| WASD / Space / Shift | Move / jump / sprint |
| F / N | Fly mode (speed scales with altitude) / no-clip (creative) |
| M | Switch survival / creative |
| C | Fly down |
| T, Shift+T | Next / previous tool |
| Right mouse | Place a piece / add terrain |
| Left mouse | Remove a piece / dig |
| Middle mouse | Pick the material you're looking at |
| Wheel or `[` `]` | Tool size |
| G | Grid size: 0.25, 0.5, 1 or 2 m |
| R | Rotate walls and ramps |
| 1–0, Q/E | Select material |
| Ctrl+Z | Undo, including any collapse it caused (creative) |
| P | Structural physics on/off |
| H | Help |

### Building

Grid tools (**Block, Wall, Floor, Pillar, Ramp**) snap to a build grid that is level with the
ground wherever you stand on the planet. Grids are anchored on a fixed lattice (one anchor about
every 128 m), so a building always lines up with itself when you come back to extend it. A ghost
shows where a piece will go, with a red outline for what left-click would remove. Pieces sit on
the face you aim at, rise from it, and line up with the cells around them.

Terrain tools sculpt smoothly: **Terrain** digs or adds a sphere, **Flatten** levels ground to
the nearest grid height (handy before laying a floor), and **Smooth** softens rough ground.

### Collapse, stress and explosives

After every edit, the game checks two things around it:

- **Support.** Do the solid regions next to a cut still connect to natural ground (untouched
  terrain; tree wood and leaves don't count)? Anything that doesn't breaks off.
- **Stress.** Can each part of a building still be carried from where it touches the ground?
  Every construction material spans a set distance horizontally: glass 1 m, clay 2 m, stone
  block 2.5 m, planks and brick 3 m, concrete 5 m, metal 8 m. Span is charged to whichever
  material is doing the spanning, and hanging below a support costs extra. Overlong cantilevers,
  roofs that are too wide, and pieces placed in mid-air come down.

Loose pieces become rigid bodies with mass from their materials. They fall toward the planet's
center, collide with the terrain, with each other and with you (you can be knocked over or stand
on them), and break into rubble on hard landings (more than about a 1 m fall) or when a building
lands badly tilted. Resting debris is written back as voxels. **Blast** (the last tool) carves a
crater, throws the material around it as flying rubble, shoves nearby debris and the player, and
lets whatever it undermined collapse.

One Ctrl+Z undoes an action together with everything it caused, including debris landing later.
**P** turns structural physics off (creative mode) and back on.

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
| `src/physics/Structure.ts` | Support check: flood fill toward the planet center from removed voxels, finding regions not connected to ground |
| `src/physics/Stress.ts` | Span-based structural stress for construction materials |
| `src/physics/Physics.ts` | Rigid bodies for falling pieces: mass/inertia, contacts with terrain, other debris and the player, shattering, explosions, settling back into voxels |
| `src/render/Effects.ts` | Explosion flash and camera shake |
| `src/game/Survival.ts` | Health, damage, resource inventory, building recipes and refunds |
| `src/render/` | Terrain material (procedural detail), sky dome, camera-centered ocean |

Units are voxels throughout (1 voxel = 0.25 m). Chunks are 32³ voxels at LOD 0; each LOD level
doubles the voxel size.
