// Axis parameters: the service's names, the old names read as aliases until
// 2027-01-01, ranges kept, values clamped to the design space.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALIAS_SUNSET,
  normalizeAxes,
  parseAxisValue,
  parseStaticAxisList,
} from '../src/axes.js';

const quiet = () => {};

test('grad and opsz ranges are read as ranges', () => {
  const axes = normalizeAxes({ grad: '-25..0', opsz: '20..48' });
  assert.deepEqual(axes.GRAD, { mode: 'range', min: -25, max: 0, raw: '-25..0' });
  assert.deepEqual(axes.opsz, { mode: 'range', min: 20, max: 48, raw: '20..48' });
});

test('the old names grade and optical_size are aliases until 2027-01-01', () => {
  assert.equal(ALIAS_SUNSET, '2027-01-01');
  const log = console.log;
  console.log = quiet;
  try {
    assert.deepEqual(normalizeAxes({ grade: '-25..0', optical_size: '20..48' }), normalizeAxes({ grad: '-25..0', opsz: '20..48' }));
    assert.deepEqual(normalizeAxes({ 'optical-size': '40' }).opsz, { mode: 'fixed', value: 40, raw: '40' });
  } finally {
    console.log = log;
  }
});

test('the service name wins over an alias, in either order', () => {
  const log = console.log;
  console.log = quiet;
  try {
    assert.equal(normalizeAxes({ grade: '200', grad: '-25..0' }).GRAD.max, 0);
    assert.equal(normalizeAxes({ grad: '-25..0', grade: '200' }).GRAD.max, 0);
    assert.equal(normalizeAxes({ opsz: '20..48', optical_size: '24' }).opsz.mode, 'range');
  } finally {
    console.log = log;
  }
});

test('a range past the design space is clamped; a one-point range is a value', () => {
  assert.deepEqual(parseAxisValue('-100..500', 'GRAD'), { mode: 'range', min: -25, max: 200, raw: '-100..500' });
  assert.deepEqual(parseAxisValue('10..60', 'opsz'), { mode: 'range', min: 20, max: 48, raw: '10..60' });
  assert.deepEqual(parseAxisValue('24..24', 'opsz'), { mode: 'fixed', value: 24, raw: '24..24' });
  assert.deepEqual(parseAxisValue('-25,0', 'GRAD'), { mode: 'range', min: -25, max: 0, raw: '-25,0' });
  assert.equal(parseAxisValue('500', 'GRAD'), null);
});

test('prebuild lists take values and ranges', () => {
  const specs = parseStaticAxisList('0,-25..0,0,bad,999', 'GRAD');
  assert.deepEqual(specs.map((spec) => spec.mode === 'range' ? `${spec.min}..${spec.max}` : spec.value), [0, '-25..0']);
  assert.deepEqual(parseStaticAxisList('24,20..48', 'opsz').map((spec) => spec.mode), ['fixed', 'range']);
});
