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
import { Effects } from './render/Effects';
import { DayNight, LightPool } from './render/DayNight';
import { Mode, RESOURCES, RESOURCE_NAMES, Survival } from './game/Survival';
import { HOTBAR, M } from './world/materials';
import { SavedChunk, exportWorld, getChunks, openDB, putChunks, putWorld } from './game/SaveGame';
import { runMenu } from './ui/Menu';
import './style.css';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;
  const loadBar = document.getElementById('load-bar')!;
  const loadLabel = document.getElementById('load-label')!;
  const startBtn = document.getElementById('start') as HTMLButtonElement;
  const el = (id: string) => document.getElementById(id)!;

  // --- Pick (or create) a world first; nothing is generated until then ---
  const params = new URLSearchParams(location.search);
  const { meta, chunks: savedChunks } = await runMenu(params.get('seed'));
  el('menu').hidden = true;
  el('loading').hidden = false;
  const state = meta.state;

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
  scene.add(sky.mesh, sky.stars);
  const moonLight = new THREE.DirectionalLight(0x9fb6ff, 0);
  scene.add(moonLight, moonLight.target);
  const lights = new LightPool();
  scene.add(lights.group);
  const dayNight = new DayNight();
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
  setSeed(meta.seed);
  const workerParam = params.get('workers');
  const workers = workerParam !== null ? Number(workerParam) : Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const pool = new WorkerPool(workers);
  const store = new VoxelStore();
  // Saved edits go in before streaming so every level of detail includes them.
  for (const c of savedChunks) store.importChunk(c.cx, c.cy, c.cz, c.density, c.material);
  const terrain = new Terrain(pool, store, createTerrainMaterial());
  scene.add(terrain.group);
  const ocean = new Ocean();
  scene.add(ocean.mesh);

  // --- Player / tools / UI ---
  const player = new Player(store);
  const spawn = state ? { dir: new THREE.Vector3().fromArray(state.spawn.dir), h: state.spawn.h } : findSpawn();
  if (state) {
    player.pos.fromArray(state.player.pos);
    player.heading.fromArray(state.player.heading);
    player.pitch = state.player.pitch;
    player.updateFrame();
  } else {
    player.spawnAt(spawn.dir, spawn.h + 40);
  }
  const tools = new Tools(store, terrain, player);
  scene.add(tools.preview);
  const physics = new Physics(store, terrain, terrain.material, (record, origin) => tools.debrisLanded(record, origin));
  tools.physics = physics;
  player.obstacles = physics;
  scene.add(physics.group);
  const effects = new Effects(lights.flash);
  scene.add(effects.group);
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
  if (state) {
    player.flying = state.player.flying;
    dayNight.state = state.time;
    for (const l of state.lamps) lights.addLamp(new THREE.Vector3().fromArray(l));
    physics.enabled = state.physicsEnabled;
    physics.restore(state.bodies);
  } else {
    player.spawnAt(spawn.dir, spawn.h + 2);
    dayNight.setLocalHour(spawn.dir, 8.5);
  }
  tools.onLamp = (p) => lights.addLamp(p);

  // --- Survival / creative ---
  const survival = new Survival();
  tools.survival = survival;
  const deathEl = document.getElementById('death')!;
  const setMode = (mode: Mode) => {
    survival.mode = mode;
    player.canFly = mode === 'creative';
    document.body.classList.toggle('creative', mode === 'creative');
    hud.setMode(mode === 'creative' ? 'Creative · M for survival' : 'Survival · M for creative');
  };
  setMode(meta.mode);
  if (state) {
    survival.health = state.survival.health;
    for (const [res, n] of state.survival.inventory) survival.inventory.set(res, n);
  }

  // --- Saving ---
  let storageOk = !!(await openDB());
  let saving = false;
  let playTime = meta.playTime;
  const saveStatus = el('save-status');
  const save = async (): Promise<boolean> => {
    if (!storageOk || saving) return false;
    saving = true;
    const keys = [...store.unsaved];
    store.unsaved.clear();
    try {
      await putChunks(meta.id, keys.map((k) => store.exportChunk(k)).filter((c): c is SavedChunk => !!c));
      meta.mode = survival.mode;
      meta.updated = Date.now();
      meta.playTime = playTime;
      meta.state = {
        player: { pos: player.pos.toArray(), heading: player.heading.toArray(), pitch: player.pitch, flying: player.flying },
        spawn: { dir: spawn.dir.toArray(), h: spawn.h },
        survival: { health: survival.dead ? survival.maxHealth : survival.health, inventory: [...survival.inventory] },
        time: dayNight.state,
        lamps: lights.lamps.map((l) => l.toArray()),
        physicsEnabled: physics.enabled,
        distance: distanceWalked,
        bodies: physics.snapshot(),
      };
      await putWorld(meta);
      saveStatus.textContent = `Saved at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      return true;
    } catch (err) {
      for (const k of keys) store.unsaved.add(k);
      saveStatus.textContent = `Couldn't save: ${(err as Error).message}`;
      storageOk = !!(await openDB());
      return false;
    } finally {
      saving = false;
    }
  };
  if (!storageOk) saveStatus.textContent = "Saving isn't available here (private window or blocked site data), so this world won't be kept.";
  setInterval(() => {
    if (started && !survival.dead) void save();
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && started) void save();
  });

  const input = new Input(canvas, (active) => {
    overlay.classList.toggle('hidden', active || survival.dead);
    document.body.classList.toggle('playing', active);
    if (!active && started) {
      // Paused: save, and prepare a world code for copying.
      void save().then(() => prepareCode());
    }
  });
  startBtn.disabled = false;
  startBtn.textContent = 'Play';
  loadLabel.textContent = `${meta.name} · seed ${meta.seed}`;
  let started = false;
  startBtn.addEventListener('click', () => {
    started = true;
    document.body.classList.remove('in-menu');
    el('loading').hidden = true;
    el('pause').hidden = false;
    input.engage();
    void save(); // so a brand-new world shows up in the list right away
  });
  el('resume').addEventListener('click', () => input.engage());
  el('quit').addEventListener('click', async () => {
    (el('quit') as HTMLButtonElement).disabled = true;
    saveStatus.textContent = 'Saving…';
    await save();
    location.reload();
  });
  // World code: built after each save so the click can copy it right away.
  let code = '';
  const prepareCode = async () => {
    if (!storageOk) return;
    try {
      code = await exportWorld(meta, await getChunks(meta.id));
    } catch {
      code = '';
    }
  };
  el('copy-code').addEventListener('click', async () => {
    const area = el('export-code') as HTMLTextAreaElement;
    if (!code) await prepareCode();
    if (!code) {
      saveStatus.textContent = "The world code isn't ready; it needs saving to work.";
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      saveStatus.textContent = `World code copied (${Math.round(code.length / 1024)} KB of text). Paste it into "Import a world code" on any browser.`;
    } catch {
      area.hidden = false;
      area.value = code;
      area.select();
      saveStatus.textContent = 'Copy the world code from the box above.';
    }
  });
  canvas.addEventListener('click', () => {
    if (!input.active && started && !survival.dead) input.engage();
  });
  document.getElementById('respawn')!.addEventListener('click', () => {
    survival.respawn();
    player.spawnAt(spawn.dir, spawn.h + 2);
    deathEl.classList.add('hidden');
    input.engage();
  });

  Object.assign(window as unknown as Record<string, unknown>, { game: { store, terrain, player, tools, physics, survival, dayNight, lights, input, camera, scene, renderer, raycast, BuildGrid, THREE, planet } });

  // --- Loop ---
  const surf: Surface = { h: 0, biome: 0, top: 0, sub: 0, temp: 0, moist: 0 };
  const sunDir = new THREE.Vector3();
  let last = performance.now();
  let fpsAccum = 0, fpsFrames = 0, fps = 0;
  let distanceWalked = state ? state.distance : 0;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (input.active && !survival.dead) {
      playTime += dt;
      if (input.pressed.has('KeyH')) hud.toggleHelp();
      if (input.pressed.has('KeyM')) {
        setMode(survival.creative ? 'survival' : 'creative');
        hud.flash(survival.creative ? 'Creative mode' : 'Survival mode');
      }
      const wasFlying = player.flying, wasNoclip = player.noclip;
      const before = player.pos.clone();
      player.update(dt, input);
      survival.impact(player.impact, player.hitByDebris ? 'crushed by falling debris' : 'hit the ground too hard');
      if (!player.flying) distanceWalked += before.distanceTo(player.pos);
      if (wasNoclip !== player.noclip) hud.flash(player.noclip ? 'No-clip ON' : 'No-clip OFF');
      else if (wasFlying !== player.flying) hud.flash(player.flying ? 'Fly mode ON' : 'Fly mode OFF');
      tools.update(dt, input);
      if (input.pressed.has('KeyO')) {
        dayNight.advance(3);
        hud.flash(`Time skipped to ${dayNight.clock(player.up)}`);
      }
      if (input.pressed.has('KeyL')) {
        lights.flashlightOn = !lights.flashlightOn;
        hud.flash(lights.flashlightOn ? 'Flashlight on' : 'Flashlight off');
      }
      if (input.pressed.has('KeyP')) {
        physics.enabled = !physics.enabled;
        hud.flash(physics.enabled ? 'Structural physics ON' : 'Structural physics OFF (creative)');
      }
      if (tools.message) {
        hud.flash(tools.message);
        tools.message = null;
      }
      if (tools.blast) {
        effects.explosion(tools.blast.center, tools.blast.radius, player.eye);
        tools.blast = null;
      }
    }
    input.endFrame();
    physics.update(dt);
    survival.update(dt);
    hud.hurt(survival.hurt, dt);
    survival.hurt = 0;
    if (survival.dead && deathEl.classList.contains('hidden')) {
      document.getElementById('death-cause')!.textContent = `You ${survival.deathCause}.`;
      deathEl.classList.remove('hidden');
      input.release();
    }
    store.tick();

    // Camera
    camera.position.copy(player.eye).add(effects.update(dt));
    player.orientation(camera.quaternion);
    const alt = player.altitude;
    terrain.update(camera.position);
    ocean.update(camera.position);

    // Day and night: the sun circles the planet; light, sky and exposure follow its elevation.
    dayNight.update(dt);
    const up = player.up;
    sunDir.copy(dayNight.sun);
    const elev = sunDir.dot(up);
    const day = THREE.MathUtils.smoothstep(elev, -0.18, 0.22);
    sun.intensity = 2.6 * THREE.MathUtils.smoothstep(elev, -0.03, 0.12);
    sun.color.copy(SUNSET_LIGHT).lerp(NOON_LIGHT, THREE.MathUtils.smoothstep(elev, 0, 0.35));
    sun.position.copy(player.pos).addScaledVector(sunDir, 600);
    sun.target.position.copy(player.pos);
    const moonDir = dayNight.moon;
    // (MathUtils.smoothstep needs min < max, so "fades in as the sun sets" is 1 - smoothstep.)
    moonLight.intensity = 0.7 * (1 - THREE.MathUtils.smoothstep(elev, -0.15, 0.1)) * THREE.MathUtils.smoothstep(moonDir.dot(up), -0.05, 0.15);
    moonLight.position.copy(player.pos).addScaledVector(moonDir, 600);
    moonLight.target.position.copy(player.pos);
    hemi.position.copy(up);
    hemi.intensity = 0.32 + 0.78 * day;
    hemi.color.copy(NIGHT_SKY).lerp(DAY_SKY, day);
    hemi.groundColor.copy(NIGHT_GROUND).lerp(DAY_GROUND, day);
    renderer.toneMappingExposure = 1.9 - 0.85 * day;
    const horizon = sky.update(camera, up, sunDir, moonDir);
    fog.color.copy(horizon);
    lights.update(camera.position, player.eye, player.forward, (p) => {
      const x = Math.round(p.x), y = Math.round(p.y), z = Math.round(p.z);
      return store.material(x, y, z) === M.LAMP && store.solid(x, y, z);
    });
    fog.density = 0.00032 / (1 + Math.max(0, alt - 200) / 400);

    // HUD
    surfaceAt(up.x, up.y, up.z, surf);
    hud.setSlot(tools.slot, tools.materialName);
    hud.setHealth(survival.health, survival.maxHealth);
    hud.setCounts(HOTBAR.map((m) => survival.affordable(m)));
    hud.setInventory(RESOURCES.map((r) => [RESOURCE_NAMES[r], survival.inventory.get(r) ?? 0]));
    hud.setTools(TOOLS.map((t) => t.name), tools.tool);
    hud.setBrush(`${tools.materialName} · ${tools.describe()} · ${player.noclip ? 'no-clip' : player.flying ? 'flying' : 'walking'}`);
    const lat = Math.asin(up.y) * (180 / Math.PI);
    const lon = Math.atan2(up.x, up.z) * (180 / Math.PI);
    hud.setLocation(
      `${BIOME_NAMES[surf.biome]} · ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'} · ` +
        `${toMeters(alt).toFixed(0)} m · ${dayNight.clock(up)} · walked ${(toMeters(distanceWalked) / 1000).toFixed(2)} km`,
    );
    fpsAccum += dt; fpsFrames++;
    if (fpsAccum >= 0.5) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0; fpsFrames = 0;
      hud.setDebug(
        `${fps} fps · ${(terrain.triangles / 1e6).toFixed(2)}M tris · ${terrain.meshCount} meshes` +
          (terrain.pendingJobs ? ` · ${terrain.pendingJobs} jobs` : '') + ` · ${store.size} cached` +
          (physics.bodies.length ? ` · ${physics.bodies.length} falling` : '') + (physics.enabled ? '' : ' · physics off'),
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

const NOON_LIGHT = new THREE.Color(0xfff1dc);
const SUNSET_LIGHT = new THREE.Color(0xff9a5a);
const DAY_SKY = new THREE.Color(0xcfe3ff);
const NIGHT_SKY = new THREE.Color(0x3a4f80);
const DAY_GROUND = new THREE.Color(0x6a5a45);
const NIGHT_GROUND = new THREE.Color(0x0c0b0a);


main().catch((err) => {
  console.error(err);
  const label = document.getElementById('load-label');
  if (label) label.textContent = `Failed to start: ${err?.message ?? err}`;
});
