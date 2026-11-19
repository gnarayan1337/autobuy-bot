import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** The exclusive run lock protects concurrent CLI processes. The separate phase
 * record survives shutdown and prevents a new process from repeating a mutation. */
export class RunState {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'state.json'); }
  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.lock = await open(path.join(this.directory, 'run.lock'), 'wx', 0o600);
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another bot may be running. Check .runtime/run.lock; remove it only after confirming that process has stopped.');
      throw error;
    }
  }
  async read() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { phase: 'new' }; throw error; }
  }
  async write(state) {
    const temporary = `${this.file}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ ...state, updated: new Date().toISOString() }, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, this.file);
  }
  async release() {
    if (!this.lock) return;
    await this.lock.close();
    await rm(path.join(this.directory, 'run.lock'), { force: true });
  }
}

export function assertSafeToBuy(state) {
  if (['adding', 'cart', 'checkout', 'submitting', 'submitted', 'confirmed', 'needs-review'].includes(state.phase)) {
    throw new Error(`Previous run stopped at '${state.phase}'. Inspect Target cart and order history before manually clearing .runtime/state.json. Automatic retry is locked.`);
  }
}
