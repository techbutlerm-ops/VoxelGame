/**
 * World saves in IndexedDB. A world is a small record (seed, player, inventory, time of day,
 * lamps, falling debris...) plus one compressed blob per edited chunk, written incrementally:
 * only chunks changed since the last save are rewritten. Worlds can also be exported as a text
 * "world code" and imported again (works where file downloads are blocked).
 */

export interface SavedBody {
  nx: number; ny: number; nz: number;
  density: Float32Array;
  material: Uint8Array;
  origin: number[];
  pos: number[];
  quat: number[];
  vel: number[];
  ang: number[];
  generation: number;
}

export interface SaveState {
  player: { pos: number[]; heading: number[]; pitch: number; flying: boolean };
  spawn: { dir: number[]; h: number };
  survival: { health: number; inventory: [number, number][] };
  time: { time: number; phase: number };
  lamps: number[][];
  physicsEnabled: boolean;
  distance: number;
  bodies: SavedBody[];
}

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  mode: 'survival' | 'creative';
  created: number;
  updated: number;
  playTime: number;
  state: SaveState | null;
}

export interface SavedChunk {
  cx: number;
  cy: number;
  cz: number;
  density: Uint8Array;
  material: Uint8Array;
}

const DB_NAME = 'voxel-planet';
const CHUNK_BYTES = 32 * 32 * 32;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Open the database, or null if storage isn't available (private window, blocked site data). */
export function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('worlds', { keyPath: 'id' });
        const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
        chunks.createIndex('world', 'world');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const done = (req: IDBRequest | IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    if ('oncomplete' in req) {
      (req as IDBTransaction).oncomplete = () => resolve();
      (req as IDBTransaction).onerror = () => reject((req as IDBTransaction).error);
      (req as IDBTransaction).onabort = () => reject((req as IDBTransaction).error);
    } else {
      (req as IDBRequest).onsuccess = () => resolve();
      (req as IDBRequest).onerror = () => reject((req as IDBRequest).error);
    }
  });

export async function listWorlds(): Promise<WorldMeta[]> {
  const db = await openDB();
  if (!db) return [];
  const req = db.transaction('worlds').objectStore('worlds').getAll();
  await done(req);
  return (req.result as WorldMeta[]).sort((a, b) => b.updated - a.updated);
}

export async function putWorld(meta: WorldMeta): Promise<void> {
  const db = await openDB();
  if (!db) throw new Error('storage unavailable');
  const tx = db.transaction('worlds', 'readwrite');
  tx.objectStore('worlds').put(meta);
  await done(tx);
}

export async function deleteWorld(id: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  const keys = await chunkIds(db, id);
  const tx = db.transaction(['worlds', 'chunks'], 'readwrite');
  tx.objectStore('worlds').delete(id);
  for (const k of keys) tx.objectStore('chunks').delete(k);
  await done(tx);
}

async function chunkIds(db: IDBDatabase, world: string): Promise<IDBValidKey[]> {
  const req = db.transaction('chunks').objectStore('chunks').index('world').getAllKeys(world);
  await done(req);
  return req.result;
}

/** Write (compressed) edited chunks of a world. */
export async function putChunks(world: string, chunks: SavedChunk[]): Promise<void> {
  if (!chunks.length) return;
  const db = await openDB();
  if (!db) throw new Error('storage unavailable');
  const packed = await Promise.all(chunks.map(async (c) => {
    const raw = new Uint8Array(CHUNK_BYTES * 2);
    raw.set(c.density, 0);
    raw.set(c.material, CHUNK_BYTES);
    return { id: `${world}:${c.cx},${c.cy},${c.cz}`, world, cx: c.cx, cy: c.cy, cz: c.cz, data: await compress(raw) };
  }));
  const tx = db.transaction('chunks', 'readwrite');
  for (const p of packed) tx.objectStore('chunks').put(p);
  await done(tx);
}

export async function getChunks(world: string): Promise<SavedChunk[]> {
  const db = await openDB();
  if (!db) return [];
  const req = db.transaction('chunks').objectStore('chunks').index('world').getAll(world);
  await done(req);
  return Promise.all((req.result as { cx: number; cy: number; cz: number; data: Uint8Array }[]).map(async (r) => {
    const raw = await decompress(r.data);
    return { cx: r.cx, cy: r.cy, cz: r.cz, density: raw.slice(0, CHUNK_BYTES), material: raw.slice(CHUNK_BYTES) };
  }));
}

// --- Compression (gzip where the browser supports it; first byte marks the format) ---

export async function compress(data: Uint8Array): Promise<Uint8Array> {
  try {
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
      const gz = new Uint8Array(await new Response(stream).arrayBuffer());
      const out = new Uint8Array(gz.length + 1);
      out[0] = 1;
      out.set(gz, 1);
      return out;
    }
  } catch {
    // fall through to raw
  }
  const out = new Uint8Array(data.length + 1);
  out[0] = 0;
  out.set(data, 1);
  return out;
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  if (data[0] === 0) return data.slice(1);
  const stream = new Blob([data.subarray(1)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- World codes (export / import as text) ---

const CODE_PREFIX = 'VOXELPLANET1:';

const toB64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Encode typed arrays so a world survives JSON. */
function encodeValue(_k: string, v: unknown): unknown {
  if (v instanceof Float32Array) return { $f32: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (v instanceof Uint8Array) return { $u8: toB64(v) };
  return v;
}
function decodeValue(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as { $f32?: string; $u8?: string };
    if (o.$f32 !== undefined) return new Float32Array(fromB64(o.$f32).buffer);
    if (o.$u8 !== undefined) return fromB64(o.$u8);
  }
  return v;
}

export async function exportWorld(meta: WorldMeta, chunks: SavedChunk[]): Promise<string> {
  const json = JSON.stringify({ meta, chunks }, encodeValue);
  return CODE_PREFIX + toB64(await compress(new TextEncoder().encode(json)));
}

/** Parse a world code into a new world (fresh id). Throws with a readable message if invalid. */
export async function importWorld(code: string): Promise<{ meta: WorldMeta; chunks: SavedChunk[] }> {
  const text = code.trim();
  if (!text.startsWith(CODE_PREFIX)) throw new Error("That doesn't look like a Voxel Planet world code.");
  let parsed: { meta: WorldMeta; chunks: SavedChunk[] };
  try {
    const bytes = await decompress(fromB64(text.slice(CODE_PREFIX.length)));
    parsed = JSON.parse(new TextDecoder().decode(bytes), decodeValue);
  } catch {
    throw new Error('The world code is damaged or incomplete.');
  }
  parsed.meta.id = newId();
  parsed.meta.updated = Date.now();
  return parsed;
}

export function newId(): string {
  return `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
