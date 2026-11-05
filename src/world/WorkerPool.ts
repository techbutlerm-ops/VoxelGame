import { ChunkJob, ChunkResult, runJob } from './job';
import TerrainWorker from './terrain.worker?worker&inline';

interface Pending {
  job: ChunkJob;
  done: (r: ChunkResult) => void;
}

/**
 * Runs chunk jobs on a pool of Web Workers. If workers can't be created or fail to load (some
 * sandboxed iframes block them), jobs fall back to the main thread, a few per frame.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private inFlight = new Map<Worker, Pending>();
  private fallbackQueue: Pending[] = [];

  constructor(count: number) {
    try {
      for (let i = 0; i < count; i++) {
        const w = new TerrainWorker();
        w.onmessage = (e: MessageEvent<ChunkResult>) => {
          const p = this.inFlight.get(w);
          this.inFlight.delete(w);
          this.idle.push(w);
          p?.done(e.data);
        };
        w.onerror = (e) => {
          console.warn('Terrain worker failed; continuing on the main thread', e.message);
          this.retire(w);
        };
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch (err) {
      console.warn('Web Workers unavailable, generating terrain on the main thread', err);
      for (const w of this.workers) w.terminate();
      this.workers = [];
      this.idle = [];
    }
  }

  private retire(w: Worker) {
    w.terminate();
    this.workers = this.workers.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    const p = this.inFlight.get(w);
    this.inFlight.delete(w);
    if (p) this.fallbackQueue.push(p);
  }

  get threaded(): boolean {
    return this.workers.length > 0;
  }

  /** How many more jobs can be submitted right now. */
  get available(): number {
    return this.threaded ? this.idle.length : Math.max(0, 4 - this.fallbackQueue.length);
  }

  get busy(): number {
    return this.inFlight.size + this.fallbackQueue.length;
  }

  submit(job: ChunkJob, done: (r: ChunkResult) => void) {
    const w = this.idle.pop();
    if (w) {
      this.inFlight.set(w, { job, done });
      w.postMessage(job);
    } else {
      this.fallbackQueue.push({ job, done });
    }
  }

  /** Main-thread fallback: run queued jobs within a time budget (always at least one). */
  pump(budgetMs: number) {
    const t0 = performance.now();
    while (this.fallbackQueue.length) {
      const { job, done } = this.fallbackQueue.shift()!;
      done(runJob(job));
      if (performance.now() - t0 > budgetMs) break;
    }
  }
}
