// The service keeps grad and opsz as variable axes in the subset, as it keeps
// FILL, and reads the old names as aliases. Starts the service on a free port
// in a scratch working directory (its own cache), no prebuild.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fontverter = require('fontverter');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const NAMES = 'home,search,settings,menu,chevron_right';

async function freePort() {
  const server = createServer();
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  const { port } = server.address();
  await new Promise((settle) => server.close(settle));
  return port;
}

async function axesOf(buffer) {
  const hb = await require('harfbuzzjs');
  const ttf = Buffer.from(await fontverter.convert(buffer, 'truetype'));
  const blob = hb.createBlob(ttf);
  const face = hb.createFace(blob, 0);
  try {
    return face.getAxisInfos();
  } finally {
    face.destroy();
    blob.destroy();
  }
}

test('grad and opsz ranges stay variable axes; old names give the same font', { timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-icons-test-'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SOURCE_MODE: 'prebuilt',
      PREBUILD_STATIC_SOURCES: '0',
      PREBUILD_FRAMEWORK_RANGES: '0',
      PREBUILD_ICON_NAMES: '0',
      SUBSET_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  t.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((settle) => setTimeout(settle, 250));
  }

  const ask = async (query) => {
    const response = await fetch(`${base}/ms/css?icon_names=${NAMES}&type=sharp&weight=400&${query}`);
    assert.equal(response.ok, true, `${query}: ${response.status} ${log.slice(-2000)}`);
    await response.text();
    const manifest = JSON.parse(Buffer.from(response.headers.get('x-simai-font-manifest'), 'base64url').toString('utf8'));
    const font = Buffer.from(await (await fetch(manifest.fonts[0].url)).arrayBuffer());
    return { manifest, font };
  };

  const ranged = await ask('grad=-25..0&opsz=20..48');
  assert.deepEqual(ranged.manifest.axes.GRAD, { mode: 'range', min: -25, max: 0, raw: '-25..0' });
  const axes = await axesOf(ranged.font);
  assert.deepEqual([axes.GRAD?.min, axes.GRAD?.max], [-25, 0]);
  assert.deepEqual([axes.opsz?.min, axes.opsz?.max], [20, 48]);
  assert.equal(axes.wght, undefined, 'a static weight');

  const aliased = await ask('grade=-25..0&optical_size=20..48');
  assert.equal(aliased.manifest.fonts[0].hash, ranged.manifest.fonts[0].hash);
  assert.match(log, /axis alias read: grade -> grad/);

  const fixed = await ask('grad=0&opsz=24');
  assert.deepEqual(await axesOf(fixed.font), {});
  assert.ok(fixed.font.length < ranged.font.length);
});
