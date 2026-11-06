import * as THREE from 'three';
import { toMeters } from './config';
import { BIOME_NAMES, B, setSeed, surfaceAt, Surface } from './world/planet';
import * as planet from './world/planet';
import { VoxelStore } from './world/VoxelStore';
import { Terrain } from './world/Terrain';
import { WorkerPool } from './world/WorkerPool';
import { createTerrainMaterial } from './render/terrainMaterial';
import { Ocean, Sky } from './render/Sky';
import { Player } from './player/Player';
import { Input } from './player/Input';
import { TOOLS, Tools, raycast } from './tools/Tools';
import * as BuildGrid from './tools/BuildGrid';
import { Hud } from './ui/Hud';
import { Physics } from './physics/Physics';
import './style.css';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;
  const loadBar = document.getElementById('load-bar')!;
  const loadLabel = document.getElementById('load-label')!;
  const startBtn = document.getElementById('start') as HTMLButtonElement;

  // --- Renderer / scene ---
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200000);
  const fog = new THREE.FogExp2(0xc9dcea, 0.0003);
  scene.fog = fog;

  const sky = new Sky();
  scene.add(sky.mesh);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6a5a45, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -140; sc.right = 140; sc.top = 140; sc.bottom = -140; sc.near = 1; sc.far = 1200;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // --- World ---
  const params = new URLSearchParams(location.search);
  const seedParam = params.get('seed');
  const seed = seedParam ? Number(seedParam) || hashString(seedParam) : 1337;
  setSeed(seed);

  const workerParam = params.get('workers');
  const workers = workerParam !== null ? Number(workerParam) : Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const pool = new WorkerPool(workers);
  const store = new VoxelStore();
  const terrain = new Terrain(pool, store, createTerrainMaterial());
  scene.add(terrain.group);
  const ocean = new Ocean();
  scene.add(ocean.mesh);

  // --- Player / tools / UI ---
  const player = new Player(store);
  const spawn = findSpawn();
  player.spawnAt(spawn.dir, spawn.h + 40);
  const tools = new Tools(store, terrain, player);
  scene.add(tools.preview);
  const physics = new Physics(store, terrain, terrain.material, (record) => tools.pushUndo({ records: [record], bodies: [] }));
  tools.physics = physics;
  scene.add(physics.group);
  const hud = new Hud();

  // Stream in the area around the spawn before letting the player in.
  loadLabel.textContent = 'Generating terrain';
  const t0 = performance.now();
  for (;;) {
    terrain.update(player.pos, false, 60);
    const { ready, total } = terrain.progress();
    loadBar.style.width = `${Math.round((ready / Math.max(1, total)) * 100)}%`;
    loadLabel.textContent = `Generating terrain · ${ready}/${total} chunks`;
    if (terrain.readyUpTo(4)) break;
    await new Promise((r) => setTimeout(r, 16));
  }
  console.info(`Terrain ready in ${Math.round(performance.now() - t0)} ms (${terrain.meshCount} meshes, ${terrain.jobsDone} jobs, ${Math.round(terrain.jobMs / Math.max(1, terrain.jobsDone))} ms/job, ${workers} workers)`);
  player.spawnAt(spawn.dir, spawn.h + 2);

  const input = new Input(canvas, (active) => {
    overlay.classList.toggle('hidden', active);
    document.body.classList.toggle('playing', active);
  });
  startBtn.disabled = false;
  startBtn.textContent = 'Click to play';
  loadLabel.textContent = `Ready · seed ${seed}`;
  startBtn.addEventListener('click', () => input.engage());
  canvas.addEventListener('click', () => {
    if (!input.active) input.engage();
  });

  Object.assign(window as unknown as Record<string, unknown>, { game: { store, terrain, player, tools, physics, input, camera, scene, renderer, raycast, BuildGrid, THREE, planet } });

  // --- Loop ---
  const surf: Surface = { h: 0, biome: 0, top: 0, sub: 0, temp: 0, moist: 0 };
  const sunDir = new THREE.Vector3();
  let last = performance.now();
  let fpsAccum = 0, fpsFrames = 0, fps = 0;
  let distanceWalked = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (input.active) {
      if (input.pressed.has('KeyH')) hud.toggleHelp();
      const wasFlying = player.flying, wasNoclip = player.noclip;
      const before = player.pos.clone();
      player.update(dt, input);
      if (!player.flying) distanceWalked += before.distanceTo(player.pos);
      if (wasNoclip !== player.noclip) hud.flash(player.noclip ? 'No-clip ON' : 'No-clip OFF');
      else if (wasFlying !== player.flying) hud.flash(player.flying ? 'Fly mode ON' : 'Fly mode OFF');
      tools.update(dt, input);
      if (tools.message) {
        hud.flash(tools.message);
        tools.message = null;
      }
    }
    input.endFrame();
    physics.update(dt);
    store.tick();

    // Camera
    camera.position.copy(player.eye);
    player.orientation(camera.quaternion);
    const alt = player.altitude;
    terrain.update(camera.position);
    ocean.update(camera.position);

    // Sun stays at a pleasant mid-morning angle relative to the local horizon.
    const up = player.up;
    const east = new THREE.Vector3(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-4) east.set(1, 0, 0);
    east.normalize();
    sunDir.copy(up).multiplyScalar(0.72).addScaledVector(east, 0.55).addScaledVector(new THREE.Vector3().crossVectors(up, east), 0.42).normalize();
    sun.position.copy(player.pos).addScaledVector(sunDir, 600);
    sun.target.position.copy(player.pos);
    hemi.position.copy(up);
    const horizon = sky.update(camera, up, sunDir);
    fog.color.copy(horizon);
    fog.density = 0.00032 / (1 + Math.max(0, alt - 200) / 400);

    // HUD
    surfaceAt(up.x, up.y, up.z, surf);
    hud.setSlot(tools.slot, tools.materialName);
    hud.setTools(TOOLS.map((t) => t.name), tools.tool);
    hud.setBrush(`${tools.describe()} · ${player.noclip ? 'no-clip' : player.flying ? 'flying' : 'walking'}`);
    const lat = Math.asin(up.y) * (180 / Math.PI);
    const lon = Math.atan2(up.x, up.z) * (180 / Math.PI);
    hud.setLocation(
      `${BIOME_NAMES[surf.biome]} · ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'} · ` +
        `${toMeters(alt).toFixed(0)} m · walked ${(toMeters(distanceWalked) / 1000).toFixed(2)} km`,
    );
    fpsAccum += dt; fpsFrames++;
    if (fpsAccum >= 0.5) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0; fpsFrames = 0;
      hud.setDebug(
        `${fps} fps · ${(terrain.triangles / 1e6).toFixed(2)}M tris · ${terrain.meshCount} meshes` +
          (terrain.pendingJobs ? ` · ${terrain.pendingJobs} jobs` : '') + ` · ${store.size} cached` +
          (physics.bodies.length ? ` · ${physics.bodies.length} falling` : ''),
      );
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Find a pleasant spawn: dry land in a temperate biome, searching outward from a fixed point. */
function findSpawn(): { dir: THREE.Vector3; h: number } {
  const s: Surface = { h: 0, biome: 0, top: 0, sub: 0, temp: 0, moist: 0 };
  const dir = new THREE.Vector3();
  const good = [B.PLAINS, B.FOREST];
  for (let i = 0; i < 4000; i++) {
    // Golden-angle spiral over the sphere, starting near the equator.
    const t = i * 2.399963;
    const lat = Math.sin(i * 0.37) * 0.6 * Math.min(1, i / 200);
    dir.set(Math.cos(t) * Math.cos(lat), Math.sin(lat), Math.sin(t) * Math.cos(lat)).normalize();
    surfaceAt(dir.x, dir.y, dir.z, s);
    if (good.includes(s.biome as 2 | 3) && s.h > 12 && s.h < 300) return { dir: dir.clone(), h: s.h };
  }
  return { dir: new THREE.Vector3(1, 0, 0), h: Math.max(0, surfaceAt(1, 0, 0, s).h) };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

main().catch((err) => {
  console.error(err);
  const label = document.getElementById('load-label');
  if (label) label.textContent = `Failed to start: ${err?.message ?? err}`;
});
