// The subset itself: a woff2 holding the requested icons' ligature glyphs.
//
// subset-font keeps every ligature the requested letters can spell (HarfBuzz
// layout closure over the text): 40 names hold nearly every letter, so the
// subset held most of the font (730 KB of TrueType from a 1.38 MB source) and
// its woff2 encoding took 2.2 s of the 2.3 s a new list cost, on the request's
// thread, one list at a time (R074). Here each name is shaped once against
// the source to find its ligature glyph; the subset keeps those glyphs, the
// letters (so the ligature lookups still apply) and nothing else. A name that
// does not shape to one glyph, or a subset in which a name no longer shapes
// to one glyph, falls back to subset-font's closure subset for that list.
//
// Sources are decoded to TrueType once and kept, with the glyph of every
// name shaped so far (warm() fills it for a vocabulary ahead of time).
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const fontverter = require('fontverter');
const subsetFont = require('subset-font');

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_NAME_ID = 4;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;
const HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE = 0x00000200;

let subsetWasm = null;
async function subsetExports() {
  if (!subsetWasm) {
    subsetWasm = WebAssembly.instantiate(
      await readFile(require.resolve('harfbuzzjs/hb-subset.wasm')),
    ).then(({ instance }) => instance.exports);
  }
  return subsetWasm;
}

let shaper = null;
const hb = () => (shaper ||= require('harfbuzzjs'));

const sources = new Map();

// The points of the design space a name is shaped at: every combination of
// each axis's minimum, default, middle and maximum. Material Symbols swaps
// some glyphs by axis value (FILL 1 draws an alternate glyph through
// FeatureVariations), and a subset without layout closure holds only the
// glyphs it is given: each alternate must be shaped for and kept.
function designPoints(face) {
  const axes = Object.entries(face.getAxisInfos?.() || {});
  let points = [{}];
  for (const [tag, info] of axes) {
    const values = [...new Set([info.min, info.default, (info.min + info.max) / 2, info.max])];
    points = points.flatMap((point) => values.map((value) => ({ ...point, [tag]: value })));
  }
  return points;
}

function shapingFont(h, ttf) {
  const blob = h.createBlob(ttf);
  const face = h.createFace(blob, 0);
  const font = h.createFont(face);
  return {
    font,
    points: designPoints(face),
    destroy() {
      font.destroy();
      face.destroy();
      blob.destroy();
    },
  };
}

// The glyph ids a text shapes to with standard ligatures.
function shapeGlyphs(h, font, text) {
  const buffer = h.createBuffer();
  try {
    buffer.addText(text);
    buffer.guessSegmentProperties();
    h.shape(font, buffer, 'liga');
    return buffer.json().map((glyph) => glyph.g);
  } finally {
    buffer.destroy();
  }
}

async function decodeSource(sourcePath) {
  const raw = await readFile(sourcePath);
  const ttf = Buffer.from(await fontverter.convert(raw, 'truetype'));
  const h = await hb();
  return { ttf, shaping: shapingFont(h, ttf), glyphs: new Map() };
}

// keep: false for a one-off source (a per-request instance of the variable
// font): decoded for this list and dropped, not kept in the cache.
async function loadSource(sourcePath, keep = true) {
  if (!keep) return decodeSource(sourcePath);
  if (!sources.has(sourcePath)) {
    sources.set(
      sourcePath,
      decodeSource(sourcePath).catch((error) => {
        sources.delete(sourcePath);
        throw error;
      }),
    );
  }
  return sources.get(sourcePath);
}

// Whether a name shapes to one glyph at every design point; the glyphs it
// shapes to, or null.
function nameGlyphs(h, shaping, name) {
  const found = new Set();
  for (const point of shaping.points) {
    if (Object.keys(point).length) shaping.font.setVariations(point);
    const glyphs = shapeGlyphs(h, shaping.font, name);
    if (glyphs.length !== 1 || !(glyphs[0] > 0)) return null;
    found.add(glyphs[0]);
  }
  return [...found];
}

function ligatureGlyphs(h, source, name) {
  if (!source.glyphs.has(name)) source.glyphs.set(name, nameGlyphs(h, source.shaping, name));
  return source.glyphs.get(name);
}

// HarfBuzz hb-subset over a TrueType buffer: the unicodes of `text`, the
// glyph ids given, every layout feature, no layout closure.
async function subsetGlyphs(ttf, { text, glyphs, preserveNameIds }) {
  const wasm = await subsetExports();
  const input = wasm.hb_subset_input_create_or_fail();
  if (!input) throw new Error('hb_subset_input_create_or_fail returned zero');
  const fontBuffer = wasm.malloc(ttf.byteLength);
  new Uint8Array(wasm.memory.buffer).set(ttf, fontBuffer);
  const blob = wasm.hb_blob_create(fontBuffer, ttf.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = wasm.hb_face_create(blob, 0);
  wasm.hb_blob_destroy(blob);
  let subset = 0;
  try {
    const features = wasm.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
    wasm.hb_set_clear(features);
    wasm.hb_set_invert(features);
    const nameIds = wasm.hb_subset_input_set(input, HB_SUBSET_SETS_NAME_ID);
    for (const id of preserveNameIds) wasm.hb_set_add(nameIds, id);
    wasm.hb_subset_input_set_flags(
      input,
      wasm.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE,
    );
    const unicodes = wasm.hb_subset_input_unicode_set(input);
    for (const char of text) wasm.hb_set_add(unicodes, char.codePointAt(0));
    const glyphSet = wasm.hb_subset_input_glyph_set(input);
    for (const glyph of glyphs) wasm.hb_set_add(glyphSet, glyph);
    subset = wasm.hb_subset_or_fail(face, input);
    if (!subset) throw new Error('hb_subset_or_fail returned zero');
    const result = wasm.hb_face_reference_blob(subset);
    try {
      const offset = wasm.hb_blob_get_data(result, 0);
      const length = wasm.hb_blob_get_length(result);
      if (!length) throw new Error('hb-subset produced an empty font');
      return Buffer.from(new Uint8Array(wasm.memory.buffer).subarray(offset, offset + length));
    } finally {
      wasm.hb_blob_destroy(result);
    }
  } finally {
    wasm.hb_subset_input_destroy(input);
    if (subset) wasm.hb_face_destroy(subset);
    wasm.hb_face_destroy(face);
    wasm.free(fontBuffer);
  }
}

// Every name shapes to one glyph in the subset.
async function shapesEveryName(ttf, icons) {
  const h = await hb();
  const shaping = shapingFont(h, ttf);
  try {
    return icons.every((name) => nameGlyphs(h, shaping, name) !== null);
  } finally {
    shaping.destroy();
  }
}

/**
 * Subsets sourcePath (woff2 or TrueType) to the icons named.
 * Answers {buffer (woff2), mode: 'glyphs' | 'closure', glyphs}.
 */
export async function subsetIcons({ sourcePath, icons, preserveNameIds = [1, 4], keepSource = true }) {
  const source = await loadSource(sourcePath, keepSource);
  try {
    return await subsetFromSource(source, icons, preserveNameIds);
  } finally {
    if (!keepSource) source.shaping.destroy();
  }
}

async function subsetFromSource(source, icons, preserveNameIds) {
  const h = await hb();
  const text = icons.join(' ');
  const glyphs = icons.map((name) => ligatureGlyphs(h, source, name));
  if (glyphs.every((found) => found !== null)) {
    const ttf = await subsetGlyphs(source.ttf, {
      text,
      glyphs: [0, ...glyphs.flat()],
      preserveNameIds,
    });
    if (await shapesEveryName(ttf, icons)) {
      const buffer = Buffer.from(await fontverter.convert(ttf, 'woff2', 'truetype'));
      return { buffer, mode: 'glyphs', glyphs: glyphs.length };
    }
  }
  const buffer = await subsetFont(source.ttf, text, {
    targetFormat: 'woff2',
    preserveNameIds,
  });
  return { buffer: Buffer.from(buffer), mode: 'closure', glyphs: glyphs.length };
}

/** Decodes a source and shapes every name given, ahead of the requests. */
export async function warmSource({ sourcePath, icons = [] }) {
  const source = await loadSource(sourcePath);
  const h = await hb();
  let shaped = 0;
  for (const name of icons) {
    if (ligatureGlyphs(h, source, name) !== null) shaped += 1;
  }
  return { shaped, names: icons.length };
}
