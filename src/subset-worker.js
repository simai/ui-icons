// A subset worker: runs subset-core off the service's main thread, so a new
// list no longer blocks the event loop (cache hits, health, other lists).
import { parentPort } from 'node:worker_threads';
import { subsetIcons, warmSource } from './subset-core.js';

parentPort.on('message', async ({ id, op, args }) => {
  try {
    if (op === 'warm') {
      parentPort.postMessage({ id, ok: true, result: await warmSource(args) });
      return;
    }
    const { buffer, ...rest } = await subsetIcons(args);
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    parentPort.postMessage({ id, ok: true, result: { ...rest, buffer: bytes } }, [bytes]);
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
