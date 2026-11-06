import { HOTBAR, MATERIALS, hexColor } from '../world/materials';

/** DOM overlay: crosshair, hotbar, brush readout, location, debug stats and the help panel. */
export class Hud {
  private hotbar = document.getElementById('hotbar')!;
  private toolbar = document.getElementById('tools')!;
  private toolEls: HTMLElement[] = [];
  private brush = document.getElementById('brush')!;
  private debug = document.getElementById('debug')!;
  private location = document.getElementById('location')!;
  private help = document.getElementById('help')!;
  private toast = document.getElementById('toast')!;
  private slots: HTMLElement[] = [];
  private counts: HTMLElement[] = [];
  private healthFill = document.getElementById('health-fill')!;
  private healthText = document.getElementById('health-text')!;
  private modeEl = document.getElementById('mode')!;
  private inventory = document.getElementById('inventory')!;
  private hurtEl = document.getElementById('hurt')!;
  private hurtLevel = 0;
  private toastTimer = 0;

  constructor() {
    HOTBAR.forEach((id, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="swatch" style="background:${hexColor(id)}"></span><span class="key">${(i + 1) % 10}</span><span class="count"></span>`;
      el.title = MATERIALS[id].name;
      this.hotbar.appendChild(el);
      this.slots.push(el);
      this.counts.push(el.querySelector('.count') as HTMLElement);
    });
  }

  setTools(names: string[], active: number) {
    if (!this.toolEls.length) {
      names.forEach((name) => {
        const el = document.createElement('span');
        el.className = 'tool';
        el.textContent = name;
        this.toolbar.appendChild(el);
        this.toolEls.push(el);
      });
    }
    this.toolEls.forEach((el, i) => el.classList.toggle('active', i === active));
  }

  setSlot(slot: number, name: string) {
    this.slots.forEach((el, i) => el.classList.toggle('active', i === slot));
    this.hotbar.dataset.name = name;
  }

  /** How many voxels of each hotbar material you can afford (Infinity in creative). */
  setCounts(counts: number[]) {
    counts.forEach((n, i) => {
      const text = Number.isFinite(n) ? compact(n) : '';
      if (this.counts[i].textContent !== text) this.counts[i].textContent = text;
      this.slots[i].classList.toggle('empty', n === 0);
    });
  }

  setHealth(health: number, max: number) {
    this.healthFill.style.width = `${(health / max) * 100}%`;
    const t = `${Math.ceil(health)} / ${max}`;
    if (this.healthText.textContent !== t) this.healthText.textContent = t;
  }

  setMode(text: string) {
    if (this.modeEl.textContent !== text) this.modeEl.textContent = text;
  }

  setInventory(rows: [string, number][]) {
    const html = rows.map(([name, n]) => `<span>${name}</span><span class="n">${compact(n)}</span>`).join('');
    if (this.inventory.innerHTML !== html) this.inventory.innerHTML = html;
  }

  /** Red vignette that flares with damage and fades out. */
  hurt(amount: number, dt: number) {
    this.hurtLevel = Math.min(1, this.hurtLevel + amount / 30) * Math.exp(-dt * 2.5);
    this.hurtEl.style.opacity = this.hurtLevel.toFixed(3);
  }

  setBrush(text: string) {
    if (this.brush.textContent !== text) this.brush.textContent = text;
  }

  setLocation(text: string) {
    if (this.location.textContent !== text) this.location.textContent = text;
  }

  setDebug(text: string) {
    this.debug.textContent = text;
  }

  toggleHelp() {
    this.help.classList.toggle('hidden');
  }

  flash(text: string) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 1400);
  }
}

/** 1234 -> "1.2k". */
function compact(n: number): string {
  n = Math.floor(n);
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
