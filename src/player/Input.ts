/**
 * Keyboard/mouse state. Uses pointer lock when the browser allows it; inside sandboxed
 * iframes where pointer lock is blocked it falls back to drag-to-look, click-to-act.
 */
export class Input {
  readonly keys = new Set<string>();
  /** Keys pressed since the last `endFrame()`. */
  readonly pressed = new Set<string>();
  /** Of those, the ones pressed while Ctrl/Cmd or Shift was held (captured at keydown). */
  readonly pressedCtrl = new Set<string>();
  readonly pressedShift = new Set<string>();
  lookDX = 0;
  lookDY = 0;
  wheel = 0;
  /** Mouse buttons currently held (pointer-lock mode only). */
  readonly buttons = new Set<number>();
  /** Buttons clicked since the last `endFrame()`. */
  readonly clicked = new Set<number>();
  locked = false;
  dragMode = false;
  /** Whether the game should react to input (pointer locked, or drag mode engaged). */
  active = false;

  private dragStart: { x: number; y: number; button: number; moved: number } | null = null;
  private onActiveChange: (active: boolean) => void;

  constructor(private canvas: HTMLCanvasElement, onActiveChange: (active: boolean) => void) {
    this.onActiveChange = onActiveChange;

    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (!this.keys.has(e.code)) {
        this.pressed.add(e.code);
        if (e.ctrlKey || e.metaKey) this.pressedCtrl.add(e.code);
        if (e.shiftKey) this.pressedShift.add(e.code);
      }
      // Ctrl+Z is the game's undo, not the browser's.
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') e.preventDefault();
      this.keys.add(e.code);
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'Quote', 'Slash'].includes(e.code)) e.preventDefault();
      if (e.code === 'Escape' && this.dragMode) this.setActive(false);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons.clear();
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.dragMode) this.setActive(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.enableDragMode());

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.active) return;
      if (this.dragMode) {
        this.dragStart = { x: e.clientX, y: e.clientY, button: e.button, moved: 0 };
      } else {
        this.buttons.add(e.button);
        this.clicked.add(e.button);
      }
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons.delete(e.button);
      if (this.dragMode && this.dragStart && this.dragStart.button === e.button) {
        if (this.dragStart.moved < 6) this.clicked.add(e.button);
        this.dragStart = null;
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.lookDX += e.movementX;
        this.lookDY += e.movementY;
      } else if (this.dragMode && this.dragStart) {
        this.dragStart.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
        this.lookDX += e.movementX * 1.4;
        this.lookDY += e.movementY * 1.4;
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.active) this.wheel += Math.sign(e.deltaY);
      },
      { passive: false },
    );
  }

  /** Try to capture the mouse. Falls back to drag-look if pointer lock is unavailable. */
  engage() {
    if (this.dragMode) {
      this.setActive(true);
      return;
    }
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => this.enableDragMode());
      }
    } catch {
      this.enableDragMode();
    }
  }

  private enableDragMode() {
    if (this.dragMode) return;
    this.dragMode = true;
    this.setActive(true);
  }

  private setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      this.keys.clear();
      this.buttons.clear();
    }
    this.onActiveChange(active);
  }

  release() {
    if (this.locked) document.exitPointerLock();
    else this.setActive(false);
  }

  endFrame() {
    this.pressed.clear();
    this.pressedCtrl.clear();
    this.pressedShift.clear();
    this.clicked.clear();
    this.lookDX = 0;
    this.lookDY = 0;
    this.wheel = 0;
  }
}
