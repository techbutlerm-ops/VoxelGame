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
  private toastTimer = 0;

  constructor() {
    HOTBAR.forEach((id, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="swatch" style="background:${hexColor(id)}"></span><span class="key">${(i + 1) % 10}</span>`;
      el.title = MATERIALS[id].name;
      this.hotbar.appendChild(el);
      this.slots.push(el);
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
