import { SavedChunk, WorldMeta, deleteWorld, getChunks, importWorld, listWorlds, newId, openDB, putChunks, putWorld } from '../game/SaveGame';

const el = (id: string) => document.getElementById(id)!;

/**
 * The start menu: saved worlds (play / delete), a new world (name, seed, mode), and world-code
 * import. Resolves with the world to play and its saved chunks.
 */
export async function runMenu(seedParam: string | null): Promise<{ meta: WorldMeta; chunks: SavedChunk[] }> {
  const storageOk = !!(await openDB());
  if (!storageOk) {
    el('storage-note').textContent = "Saving isn't available in this browser (private window or blocked site data); worlds won't be kept.";
  }
  const nameInput = el('world-name') as HTMLInputElement;
  const seedInput = el('world-seed') as HTMLInputElement;
  seedInput.value = seedParam ?? String(Math.floor(Math.random() * 1e6));

  return new Promise((resolve) => {
    const play = async (meta: WorldMeta) => {
      el('menu').classList.add('busy');
      resolve({ meta, chunks: storageOk ? await getChunks(meta.id) : [] });
    };

    const render = async () => {
      const worlds = storageOk ? await listWorlds() : [];
      nameInput.placeholder = `World ${worlds.length + 1}`;
      const list = el('worlds');
      list.replaceChildren();
      if (worlds.length) {
        const h = document.createElement('h2');
        h.textContent = 'Your worlds';
        list.append(h);
      }
      for (const w of worlds) {
        const row = document.createElement('div');
        row.className = 'world';
        const info = document.createElement('div');
        info.className = 'info';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = w.name;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${w.mode === 'creative' ? 'Creative' : 'Survival'} · seed ${w.seed} · ${duration(w.playTime)} played · ${ago(w.updated)}`;
        info.append(name, meta);
        const playBtn = document.createElement('button');
        playBtn.className = 'play';
        playBtn.textContent = 'Play';
        playBtn.addEventListener('click', () => play(w));
        const del = document.createElement('button');
        del.className = 'danger';
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          if (del.dataset.confirm !== '1') {
            del.dataset.confirm = '1';
            del.textContent = 'Delete forever?';
            return;
          }
          await deleteWorld(w.id);
          void render();
        });
        row.append(info, playBtn, del);
        list.append(row);
      }
    };

    const create = (mode: 'survival' | 'creative') => {
      const seedText = seedInput.value.trim() || String(Math.floor(Math.random() * 1e6));
      const seed = /^\d+$/.test(seedText) ? Number(seedText) : hashString(seedText);
      const now = Date.now();
      void play({ id: newId(), name: nameInput.value.trim() || nameInput.placeholder, seed, mode, created: now, updated: now, playTime: 0, state: null });
    };
    el('new-world').addEventListener('submit', (e) => {
      e.preventDefault();
      create('survival');
    });
    el('new-creative').addEventListener('click', () => create('creative'));

    el('import-btn').addEventListener('click', async () => {
      const msg = el('import-msg');
      try {
        const { meta, chunks } = await importWorld((el('import-code') as HTMLTextAreaElement).value);
        meta.name = `${meta.name} (imported)`;
        if (!storageOk) {
          msg.textContent = 'Opening it without saving (storage is unavailable here).';
          resolve({ meta, chunks });
          return;
        }
        await putChunks(meta.id, chunks);
        await putWorld(meta);
        (el('import-code') as HTMLTextAreaElement).value = '';
        msg.textContent = `Imported "${meta.name}".`;
        void render();
      } catch (err) {
        msg.textContent = (err as Error).message;
      }
    });

    void render();
  });
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
