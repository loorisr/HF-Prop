// Small worker pool. Each worker holds its own engine (~45 MB), so the pool
// size is capped; on phones / low-memory devices it stays at 2.

export function defaultPoolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4; // GB (Chromium only)
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  let n = Math.max(1, cores - 1);
  n = Math.min(n, mobile || mem <= 4 ? 3 : 6);
  return n;
}

export class Pool {
  constructor(size) {
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this._done(w, ev.data);
      w.onerror = (ev) => this._crash(w, ev);
      this.workers.push(w);
      this.idle.push(w);
    }
  }
  get size() { return this.workers.length; }

  run(task, transfer = []) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, transfer, resolve, reject });
      this._pump();
    });
  }

  /** Drop queued (not yet started) tasks, rejecting them with 'cancelled'. */
  cancelQueued(pred = () => true) {
    const keep = [];
    for (const job of this.queue) {
      if (pred(job.task)) job.reject(new Error('cancelled'));
      else keep.push(job);
    }
    this.queue = keep;
  }

  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      const id = this.nextId++;
      this.pending.set(id, { job, w });
      w._jobId = id;
      w.postMessage({ id, task: job.task }, job.transfer);
    }
  }

  _done(w, msg) {
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    this.idle.push(w);
    if (p) {
      if (msg.ok) p.job.resolve(msg.data);
      else p.job.reject(new Error(msg.error));
    }
    this._pump();
  }

  _crash(w, ev) {
    const p = this.pending.get(w._jobId);
    if (p) {
      this.pending.delete(w._jobId);
      p.job.reject(new Error(ev.message || 'worker crashed'));
    }
    this.idle.push(w);
    this._pump();
  }
}
