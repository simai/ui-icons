// A pool of subset workers (worker_threads), size SUBSET_WORKERS. The
// service built every new list with subset-font on its main thread: the event
// loop was blocked for each one, so lists asked for together came back
// together, one build after another (5 new lists: all at 18.8 s), and cache
// hits waited behind them (R074). Each worker keeps its own decoded sources.
// Size 0 runs subset-core in the main thread (tests, a single-process debug).
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { subsetIcons, warmSource } from './subset-core.js';

const WORKER_URL = new URL('./subset-worker.js', import.meta.url);

export function defaultPoolSize() {
  const cores =
    typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 1));
}

export function createSubsetPool({ size = defaultPoolSize(), log = console } = {}) {
  if (!size) {
    return {
      size: 0,
      run: (args) => subsetIcons(args),
      warm: async (args) => [await warmSource(args)],
      stats: () => ({ size: 0, busy: 0, queued: 0 }),
      close: async () => {},
    };
  }

  const slots = [];
  const queue = [];
  let nextId = 1;
  let closed = false;

  const spawnSlot = (index) => {
    const worker = new Worker(WORKER_URL);
    const slot = { index, worker, task: null };
    worker.on('message', ({ id, ok, result, error }) => {
      const task = slot.task;
      if (!task || task.id !== id) return;
      slot.task = null;
      worker.unref();
      if (ok) {
        task.resolve(result?.buffer ? { ...result, buffer: Buffer.from(result.buffer) } : result);
      } else {
        task.reject(new Error(error));
      }
      pump();
    });
    const fail = (error) => {
      const task = slot.task;
      slot.task = null;
      task?.reject(error instanceof Error ? error : new Error(String(error)));
      log.warn?.(`subset worker ${index} stopped: ${error?.message || error}; starting a new one`);
      slots[index] = spawnSlot(index);
      pump();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (!closed && code !== 0 && slots[index] === slot) fail(new Error(`exit code ${code}`));
    });
    worker.unref();
    return slot;
  };

  const pump = () => {
    for (const slot of slots) {
      if (slot.task || !queue.length) continue;
      const task = queue.shift();
      slot.task = task;
      // A worker with a task keeps the process alive; an idle one does not.
      slot.worker.ref();
      slot.worker.postMessage({ id: task.id, op: task.op, args: task.args });
    }
  };

  const enqueue = (op, args, slot = null) =>
    new Promise((resolve, reject) => {
      const task = { id: nextId++, op, args, resolve, reject };
      if (slot) {
        // A warm-up for one worker: waits for that worker.
        const send = () => {
          if (slot.task) return setTimeout(send, 5);
          slot.task = task;
          slot.worker.ref();
          slot.worker.postMessage({ id: task.id, op, args });
          return undefined;
        };
        send();
        return;
      }
      queue.push(task);
      pump();
    });

  for (let index = 0; index < size; index += 1) slots.push(spawnSlot(index));

  return {
    size,
    run: (args) => enqueue('subset', args),
    // Every worker decodes the source and shapes the names given.
    warm: (args) => Promise.all(slots.map((slot) => enqueue('warm', args, slot))),
    stats: () => ({
      size,
      busy: slots.filter((slot) => slot.task).length,
      queued: queue.length,
    }),
    close: () => {
      closed = true;
      return Promise.all(slots.map((slot) => slot.worker.terminate()));
    },
  };
}
