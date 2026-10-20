import express from 'express';
import crypto from 'node:crypto';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import subsetFont from 'subset-font';
import { createFont, woff2 } from 'fonteditor-core';

const app = express();
const TRUST_PROXY = parseBooleanEnv(process.env.TRUST_PROXY, true);
app.set('trust proxy', TRUST_PROXY);
const FONT_RESPONSE_HEADERS = [
  'X-SIMAI-Font-Hash',
  'X-SIMAI-Font-Mode',
  'X-SIMAI-Font-Manifest',
];
app.use(
  cors({
    exposedHeaders: FONT_RESPONSE_HEADERS,
  }),
);
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
const PORT = Number(process.env.PORT || 3189);
const HOST = process.env.HOST || '127.0.0.1';
const SERVICE_VERSION = 'v4-nodejs-full';
const MAX_ICON_COUNT = Number(process.env.MAX_ICON_COUNT || 200);
const MAX_QUERY_LENGTH = Number(process.env.MAX_QUERY_LENGTH || 4000);
const PYFTSUBSET_BIN = process.env.PYFTSUBSET_BIN || 'pyftsubset';
const FONTTOOLS_BIN = process.env.FONTTOOLS_BIN || 'fonttools';
const PYTHON_BIN =
  process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
const SUBSET_FALLBACK_MODE = process.env.SUBSET_FALLBACK_MODE || 'error'; // 'error' | 'stub'
const PREBUILD_STATIC_SOURCES = process.env.PREBUILD_STATIC_SOURCES !== '0';
const PREBUILD_STATIC_FILLS = (process.env.PREBUILD_STATIC_FILLS || '0,1,mixed')
  .split(',')
  .map((value) => String(value).trim().toLowerCase())
  .map((value) => (value === '0+1' || value === 'both' ? 'mixed' : value))
  .filter((value) => value === '0' || value === '1' || value === 'mixed');
const PREBUILD_STATIC_GRADES = (
  process.env.PREBUILD_STATIC_GRADES || '-25,0,200'
)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => [-25, 0, 200].includes(value));
const PREBUILD_STATIC_OPTICAL_SIZES = (
  process.env.PREBUILD_STATIC_OPTICAL_SIZES || '20,24,40,48'
)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => [20, 24, 40, 48].includes(value));
const SOURCE_MODE = ['prebuilt', 'raw'].includes(
  String(process.env.SOURCE_MODE || 'prebuilt').toLowerCase(),
)
  ? String(process.env.SOURCE_MODE || 'prebuilt').toLowerCase()
  : 'prebuilt';
const CACHE_TTL_DAYS = Math.max(1, Number(process.env.CACHE_TTL_DAYS || 30));
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const CACHE_MAINTENANCE_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.CACHE_MAINTENANCE_INTERVAL_MS || 60 * 60 * 1000),
);
const STATIC_SOURCE_VERSION = 'fonttools-varlib-instancer-v1';

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'cache');
const FONT_CACHE_DIR = path.join(CACHE_DIR, 'fonts');
const META_CACHE_DIR = path.join(CACHE_DIR, 'meta');
const ORIGIN_CACHE_DIR = path.join(CACHE_DIR, 'origins');
const STATIC_SOURCE_CACHE_DIR = path.join(CACHE_DIR, 'sources');
const LATEST_META_PATH = path.join(CACHE_DIR, 'latest.json');
const FONT_FAMILY_DIR = path.join(ROOT, 'src', 'fonts');
const DEFAULT_FONT_TYPE = 'outlined';
const FONT_TYPE_CONFIG = {
  outlined: {
    family: 'Material Symbols Outlined',
    sourcePath:
      process.env.FONT_SOURCE_PATH_OUTLINED ||
      path.join(FONT_FAMILY_DIR, 'Material-Outlined.woff2'),
  },
  rounded: {
    family: 'Material Symbols Rounded',
    sourcePath:
      process.env.FONT_SOURCE_PATH_ROUNDED ||
      path.join(FONT_FAMILY_DIR, 'Material-Rounded.woff2'),
  },
  sharp: {
    family: 'Material Symbols Sharp',
    sourcePath:
      process.env.FONT_SOURCE_PATH_SHARP ||
      path.join(FONT_FAMILY_DIR, 'Material-Sharp.woff2'),
  },
};

const inflight = new Map();
const sourceInflight = new Map();
const originInflight = new Map();
const sourceFontBufferPromises = new Map();
const sourceFontStatPromises = new Map();
const defaultStaticSourceIndex = new Map();
let cacheMaintenancePromise = null;
const DEFAULT_WEIGHT = 400;
const DEFAULT_GRADE = 0;
const DEFAULT_OPTICAL_SIZE = 24;
const STATIC_WEIGHT_VALUES = [100, 200, 300, 400, 500, 600, 700];
const AXIS_NAME_MAP = {
  wght: 'wght',
  weight: 'wght',
  fill: 'FILL',
  grad: 'GRAD',
  opsz: 'opsz',
  rond: 'ROND',
};

function parseBooleanEnv(raw, defaultValue = false) {
  if (raw == null || raw === '') return defaultValue;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return defaultValue;
}

function normalizeIconNames(raw) {
  if (typeof raw !== 'string') return [];
  if (raw.length > MAX_QUERY_LENGTH) {
    throw new Error('icon_names is too long');
  }

  const unique = new Set();
  raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .forEach((name) => {
      if (!/^[a-z0-9_]+$/.test(name)) {
        throw new Error(`Invalid icon name: ${name}`);
      }
      unique.add(name);
    });

  const names = Array.from(unique).sort();
  if (!names.length) throw new Error('icon_names is required');
  if (names.length > MAX_ICON_COUNT) {
    throw new Error(`Too many icons requested (max ${MAX_ICON_COUNT})`);
  }
  return names;
}

function normalizeFontType(raw) {
  const type = String(raw || DEFAULT_FONT_TYPE)
    .trim()
    .toLowerCase();
  if (!FONT_TYPE_CONFIG[type]) {
    throw new Error(
      `Unsupported type: ${type}. Expected one of: ${Object.keys(FONT_TYPE_CONFIG).join(', ')}`,
    );
  }
  return type;
}

function getFontTypeConfig(type) {
  return FONT_TYPE_CONFIG[normalizeFontType(type)];
}

function parseAxisValue(raw, axisName) {
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  const lowerValue = value.toLowerCase();

  const clampValue = (axisName, num) => {
    if (axisName === 'wght') {
      return Math.max(100, Math.min(700, num));
    }
    return num;
  };

  const isSupported = (axisName, num) => {
    if (axisName === 'wght') {
      return num >= 100 && num <= 700;
    }
    if (axisName === 'FILL') {
      return num >= 0 && num <= 1;
    }
    if (axisName === 'GRAD') {
      return num >= -25 && num <= 200;
    }
    if (axisName === 'opsz') {
      return num >= 20 && num <= 48;
    }
    return true;
  };

  if (axisName === 'FILL') {
    if (['true', 'yes', 'on', 'filled', 'both', 'mixed'].includes(lowerValue)) {
      return {
        mode: 'range',
        min: 0,
        max: 1,
        raw: value,
      };
    }
    if (['false', 'no', 'off', 'outline', 'outlined'].includes(lowerValue)) {
      return {
        mode: 'fixed',
        value: 0,
        raw: value,
      };
    }
    if (['only', 'filled-only', 'fill-only'].includes(lowerValue)) {
      return {
        mode: 'fixed',
        value: 1,
        raw: value,
      };
    }
  }

  // A comma-separated list: 100,200,300,400,500,600,700
  const listMatch = value.includes(',')
    ? value.match(/^(-?\d+(?:\.\d+)?)(,(-?\d+(?:\.\d+)?))*$/)
    : null;
  if (listMatch) {
    const values = Array.from(
      new Set(
        value
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((num) => Number.isFinite(num) && isSupported(axisName, num))
          .map((num) => clampValue(axisName, num)),
      ),
    ).sort((a, b) => a - b);
    if (!values.length) return null;
    if (axisName === 'wght') {
      return {
        mode: 'list',
        values,
        raw: value,
      };
    }
    if (axisName === 'FILL' && values.includes(0) && values.includes(1)) {
      return {
        mode: 'range',
        min: 0,
        max: 1,
        raw: value,
      };
    }
    const rangeValues = values.filter(
      (num) => Number.isFinite(num) && isSupported(axisName, num),
    );
    if (!rangeValues.length) return null;
    const min = Math.min(...rangeValues);
    const max = Math.max(...rangeValues);
    return {
      mode: 'range',
      min: clampValue(axisName, min),
      max: clampValue(axisName, max),
      raw: value,
    };
  }

  // A range: 100..900
  const rangeMatch = value.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    let min = Number(rangeMatch[1]);
    let max = Number(rangeMatch[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error(`Invalid axis range for ${axisName}: ${value}`);
    }
    min = clampValue(axisName, Math.min(min, max));
    max = clampValue(axisName, Math.max(min, max));
    if (min > max) return null;
    return {
      mode: 'range',
      min,
      max,
      raw: value,
    };
  }

  // A single number
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid axis value for ${axisName}: ${value}`);
  }
  if (!isSupported(axisName, num)) {
    return null;
  }
  return {
    mode: 'fixed',
    value: clampValue(axisName, num),
    raw: value,
  };
}

function normalizeAxes(query = {}) {
  const axes = {};

  Object.entries(query).forEach(([key, raw]) => {
    if (raw == null || raw === '') return;
    const normalizedKey = AXIS_NAME_MAP[String(key).toLowerCase()];
    if (!normalizedKey) return;
    const parsed = parseAxisValue(raw, normalizedKey);
    if (parsed) {
      axes[normalizedKey] = parsed;
    }
  });

  return axes;
}

function applyDefaultAxes(axes = {}) {
  const normalizedAxes = { ...axes };
  const forceFilledOnly = ['only', 'filled-only', 'fill-only'].includes(
    String(normalizedAxes.FILL?.raw || '').toLowerCase(),
  );
  if (
    normalizedAxes.FILL?.mode === 'fixed' &&
    normalizedAxes.FILL.value === 1 &&
    !forceFilledOnly
  ) {
    normalizedAxes.FILL = {
      mode: 'range',
      min: 0,
      max: 1,
      raw: normalizedAxes.FILL.raw,
    };
  }

  return {
    ...normalizedAxes,
    wght: normalizedAxes.wght || {
      mode: 'fixed',
      value: DEFAULT_WEIGHT,
      raw: 'default',
    },
  };
}

function buildAxisKeyPart(axes = {}) {
  const entries = Object.entries(axes).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return 'axes:none';
  return `axes:${entries
    .map(([axis, spec]) => {
      if (spec.mode === 'range') return `${axis}=${spec.min}..${spec.max}`;
      if (spec.mode === 'list') return `${axis}=${spec.values.join(',')}`;
      return `${axis}=${spec.value}`;
    })
    .join(',')}`;
}

function buildKey({ family = 'Material Symbols Outlined', icons, axes = {} }) {
  return `${family}|${icons.join(',')}|${buildAxisKeyPart(axes)}|${SERVICE_VERSION}`;
}

function buildCacheKey({
  family = 'Material Symbols Outlined',
  icons,
  axes = {},
  suffix = '',
}) {
  return `${buildKey({ family, icons, axes })}${suffix ? `|${suffix}` : ''}`;
}

function parseBooleanFlag(raw, defaultValue = false) {
  if (raw == null || raw === '') return defaultValue;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return defaultValue;
}

function buildOriginRegistryKey({
  origin,
  type,
  family,
  axes = {},
  scope = 'default',
}) {
  return [
    'origin-registry-v1',
    origin,
    type,
    family,
    buildAxisKeyPart(axes),
    `scope:${scope || 'default'}`,
  ].join('|');
}

function hashKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

function shortHash(value) {
  return hashKey(value).slice(0, 12);
}

function formatDuration(startMs) {
  return `${Math.round(performance.now() - startMs)}ms`;
}

function cloneAxesWithFixedWeight(axes = {}, weight) {
  return {
    ...axes,
    wght: {
      mode: 'fixed',
      value: weight,
      raw: String(weight),
    },
  };
}

function buildStaticSourceAxes(axes = {}, weight) {
  const fillAxis =
    axes.FILL?.mode === 'range'
      ? axes.FILL
      : axes.FILL?.mode === 'fixed'
        ? axes.FILL
        : {
            mode: 'fixed',
            value: 0,
            raw: 'default',
          };
  const gradeAxis =
    axes.GRAD?.mode === 'fixed'
      ? axes.GRAD
      : {
          mode: 'fixed',
          value: DEFAULT_GRADE,
          raw: 'default',
        };
  const opticalSizeAxis =
    axes.opsz?.mode === 'fixed'
      ? axes.opsz
      : {
          mode: 'fixed',
          value: DEFAULT_OPTICAL_SIZE,
          raw: 'default',
        };
  const sourceAxes = {
    wght: {
      mode: 'fixed',
      value: weight,
      raw: String(weight),
    },
    FILL: fillAxis,
    GRAD: gradeAxis,
    opsz: opticalSizeAxis,
  };

  Object.entries(axes).forEach(([axisName, spec]) => {
    if (
      axisName === 'wght' ||
      axisName === 'FILL' ||
      axisName === 'GRAD' ||
      axisName === 'opsz'
    ) {
      return;
    }
    if (spec?.mode === 'fixed') {
      sourceAxes[axisName] = spec;
    }
  });

  return sourceAxes;
}

function subtractAxes(axes = {}, fixedAxes = {}) {
  return Object.fromEntries(
    Object.entries(axes).filter(([axisName]) => !fixedAxes[axisName]),
  );
}

function formatAxisCoords(axes = {}) {
  return Object.entries(axes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([axisName, spec]) =>
      spec.mode === 'range'
        ? `${axisName}=${spec.min}:${spec.max}`
        : `${axisName}=${spec.value}`,
    );
}

function buildDefaultStaticSourcePrefix(type) {
  return `source-${type}-fill-0-grad-${DEFAULT_GRADE}-opsz-${DEFAULT_OPTICAL_SIZE}-wght-${DEFAULT_WEIGHT}-`;
}

function isDefaultStaticAxes(weight, axes = {}) {
  return (
    weight === DEFAULT_WEIGHT &&
    (!axes.FILL ||
      (axes.FILL.mode === 'fixed' && Number(axes.FILL.value) === 0)) &&
    (!axes.GRAD ||
      (axes.GRAD.mode === 'fixed' &&
        Number(axes.GRAD.value) === DEFAULT_GRADE)) &&
    (!axes.opsz ||
      (axes.opsz.mode === 'fixed' &&
        Number(axes.opsz.value) === DEFAULT_OPTICAL_SIZE))
  );
}

function isStaticWeightRequest(axes = {}) {
  const wght = axes.wght;
  if (!wght) return false;
  if (wght.mode === 'list') return true;
  return wght.mode === 'fixed' && STATIC_WEIGHT_VALUES.includes(wght.value);
}

function cssFontWeight(axes = {}) {
  const wght = axes.wght;
  if (!wght) return String(DEFAULT_WEIGHT);
  if (wght.mode === 'fixed') return String(wght.value);
  if (wght.mode === 'list') return wght.values.join(' ');
  return `${wght.min} ${wght.max}`;
}

function cssFontFace({ hash, weight, display, baseUrl }) {
  return (
    `@font-face {\n` +
    `  font-family: 'Material Symbols Outlined Subset';\n` +
    `  src: url('${baseUrl}/ms/font/${hash}.woff2') format('woff2');\n` +
    `  font-style: normal;\n` +
    `  font-weight: ${weight};\n` +
    `  font-display: ${display};\n` +
    `}\n`
  );
}

function cssResponse({
  hash,
  display = 'block',
  axes = {},
  baseUrl,
  fontFaces = null,
}) {
  const safeDisplay = [
    'auto',
    'block',
    'swap',
    'fallback',
    'optional',
  ].includes(display)
    ? display
    : 'block';
  const faces = fontFaces || [
    {
      hash,
      weight: cssFontWeight(axes),
    },
  ];

  return (
    faces
      .map((face) =>
        cssFontFace({
          hash: face.hash,
          weight: face.weight,
          display: safeDisplay,
          baseUrl,
        }),
      )
      .join('\n') +
    `\n` +
    `.sf-icon {\n` +
    `  font-family: 'Material Symbols Outlined Subset';\n` +
    `  font-weight: var(--sf-icon--weight, 400);\n` +
    `  font-style: normal;\n` +
    `  line-height: 1;\n` +
    `  display: inline-flex;\n` +
    `  white-space: nowrap;\n` +
    `  font-feature-settings: 'liga';\n` +
    `  font-variation-settings: ` +
    `'FILL' var(--sf-icon--fill, 0), ` +
    `'wght' var(--sf-icon--weight, 400), ` +
    `'GRAD' var(--sf-icon--grade, 0), ` +
    `'opsz' var(--sf-icon--optical-size, 24);\n` +
    `}\n`
  );
}

function encodeHeaderJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function buildHeaderManifest(result) {
  return {
    hash: result.hash,
    mode: result.mode,
    type: result.type,
    origin: result.origin,
    family: result.family,
    iconCount: result.iconCount,
    icons: result.icons,
    axes: result.axes,
    fonts: result.fonts.map((font) => ({
      hash: font.hash,
      weight: font.weight,
      url: font.url,
    })),
  };
}

function setFontResponseHeaders(res, result) {
  res.setHeader('X-SIMAI-Font-Hash', result.hash);
  res.setHeader('X-SIMAI-Font-Mode', result.mode);
  res.setHeader(
    'X-SIMAI-Font-Manifest',
    encodeHeaderJson(buildHeaderManifest(result)),
  );
}

function buildFontManifest({ payload, mode, fonts, css, baseUrl }) {
  return {
    hash: payload.hash,
    mode,
    type: payload.type,
    origin: payload.origin,
    family: payload.family,
    icons: payload.icons,
    iconCount: payload.icons.length,
    axes: payload.axes,
    fonts: fonts.map((font) => ({
      ...font,
      url: `${baseUrl}/ms/font/${font.hash}.woff2`,
    })),
    css,
  };
}

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(FONT_CACHE_DIR, { recursive: true }),
    fs.mkdir(META_CACHE_DIR, { recursive: true }),
    fs.mkdir(ORIGIN_CACHE_DIR, { recursive: true }),
    fs.mkdir(STATIC_SOURCE_CACHE_DIR, { recursive: true }),
  ]);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeMeta(hash, meta) {
  const metaPath = path.join(META_CACHE_DIR, `${hash}.json`);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

async function readMeta(hash) {
  const metaPath = path.join(META_CACHE_DIR, `${hash}.json`);
  if (!(await fileExists(metaPath))) return null;
  const content = await fs.readFile(metaPath, 'utf8');
  return JSON.parse(content);
}

function getOriginRegistryPath(registryKey) {
  return path.join(ORIGIN_CACHE_DIR, `${hashKey(registryKey)}.json`);
}

async function readOriginRegistry(registryKey) {
  const registryPath = getOriginRegistryPath(registryKey);
  if (!(await fileExists(registryPath))) return null;
  const content = await fs.readFile(registryPath, 'utf8');
  return JSON.parse(content);
}

async function writeOriginRegistry(registryKey, data) {
  const registryPath = getOriginRegistryPath(registryKey);
  await fs.writeFile(registryPath, JSON.stringify(data, null, 2), 'utf8');
}

async function writeLatestMeta(meta) {
  await fs.writeFile(LATEST_META_PATH, JSON.stringify(meta, null, 2), 'utf8');
}

async function readLatestMeta() {
  if (!(await fileExists(LATEST_META_PATH))) return null;
  const content = await fs.readFile(LATEST_META_PATH, 'utf8');
  return JSON.parse(content);
}

function getSourceFontBuffer(sourceFontPath) {
  if (!sourceFontBufferPromises.has(sourceFontPath)) {
    sourceFontBufferPromises.set(
      sourceFontPath,
      fs.readFile(sourceFontPath).catch((error) => {
        sourceFontBufferPromises.delete(sourceFontPath);
        throw error;
      }),
    );
  }
  return sourceFontBufferPromises.get(sourceFontPath);
}

function getSourceFontStat(sourceFontPath) {
  if (!sourceFontStatPromises.has(sourceFontPath)) {
    sourceFontStatPromises.set(
      sourceFontPath,
      fs.stat(sourceFontPath).catch((error) => {
        sourceFontStatPromises.delete(sourceFontPath);
        throw error;
      }),
    );
  }
  return sourceFontStatPromises.get(sourceFontPath);
}

async function warmSourceFontCache() {
  for (const [type, config] of Object.entries(FONT_TYPE_CONFIG)) {
    try {
      const [buffer, stat] = await Promise.all([
        getSourceFontBuffer(config.sourcePath),
        getSourceFontStat(config.sourcePath),
      ]);
      console.log(
        `source font cached in memory: ${type} ${config.sourcePath} (${buffer.length} bytes, stat ${stat.size} bytes)`,
      );
    } catch (error) {
      sourceFontBufferPromises.delete(config.sourcePath);
      sourceFontStatPromises.delete(config.sourcePath);
      console.warn(
        `source font preload failed for ${type}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}

function getFontCachePath(hash) {
  return path.join(FONT_CACHE_DIR, `${hash}.woff2`);
}

function getMetaCachePath(hash) {
  return path.join(META_CACHE_DIR, `${hash}.json`);
}

function resolveRetentionTime(meta, fallbackStat) {
  const candidates = [
    meta?.lastAccessedAt,
    meta?.createdAt,
    fallbackStat?.mtime?.toISOString?.(),
  ].filter(Boolean);
  const timestamp = candidates.length ? Date.parse(candidates[0]) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function touchFontAccess(hash) {
  try {
    const meta = await readMeta(hash);
    if (!meta) return;
    meta.lastAccessedAt = new Date().toISOString();
    meta.hitCount = Number(meta.hitCount || 0) + 1;
    await writeMeta(hash, meta);
  } catch (error) {
    console.warn(
      `font access meta update failed for ${hash}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
}

function getRequestOrigin(req) {
  const origin = req.get('origin');
  if (origin) {
    const value = String(origin).trim();
    if (value) return value;
  }

  const referer = req.get('referer');
  if (!referer) return null;
  try {
    return new URL(String(referer).trim()).origin;
  } catch {
    return null;
  }
}

async function resolveAccumulatedQuery(query = {}) {
  const accumulate = parseBooleanFlag(query.accumulate, false);
  const origin =
    query && Object.prototype.hasOwnProperty.call(query, '__origin')
      ? query.__origin || null
      : null;
  if (!accumulate || !origin) {
    return {
      query,
      origin,
      accumulate: false,
      registryKey: null,
      registry: null,
    };
  }

  const type = normalizeFontType(query.type);
  const config = getFontTypeConfig(type);
  const axes = applyDefaultAxes(normalizeAxes(query));
  const requestIcons = normalizeIconNames(String(query.icon_names || ''));
  const registryScope = String(query.subset_group || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  const registryKey = buildOriginRegistryKey({
    origin,
    type,
    family: config.family,
    axes,
    scope: registryScope,
  });

  if (originInflight.has(registryKey)) {
    await originInflight.get(registryKey);
  }

  const registry = await readOriginRegistry(registryKey);
  const mergedIcons = Array.from(
    new Set([...(registry?.icons || []), ...requestIcons]),
  ).sort();
  console.log(mergedIcons);

  return {
    query: {
      ...query,
      icon_names: mergedIcons.join(','),
      __origin: origin,
    },
    origin,
    accumulate: true,
    registryKey,
    registry,
  };
}

async function deleteCachedFontArtifacts(hash, reason) {
  const fontPath = getFontCachePath(hash);
  const metaPath = getMetaCachePath(hash);
  await Promise.allSettled([
    fs.rm(fontPath, { force: true }),
    fs.rm(metaPath, { force: true }),
  ]);
  console.log(`cache cleanup removed ${hash} (${reason})`);
}

async function runCacheMaintenance() {
  if (cacheMaintenancePromise) return cacheMaintenancePromise;

  cacheMaintenancePromise = (async () => {
    const start = Date.now();
    const now = Date.now();
    let removedFonts = 0;
    let removedOrphanMeta = 0;

    const fontEntries = await fs.readdir(FONT_CACHE_DIR, {
      withFileTypes: true,
    });
    for (const entry of fontEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.woff2')) continue;
      const hash = entry.name.slice(0, -'.woff2'.length);
      if (!/^[a-f0-9]{40}$/.test(hash)) continue;

      const fontPath = getFontCachePath(hash);
      const [meta, fontStat] = await Promise.all([
        readMeta(hash).catch(() => null),
        fs.stat(fontPath).catch(() => null),
      ]);
      const retentionTime = resolveRetentionTime(meta, fontStat);
      if (retentionTime == null) continue;
      if (now - retentionTime <= CACHE_TTL_MS) continue;

      await deleteCachedFontArtifacts(hash, `ttl>${CACHE_TTL_DAYS}d`);
      removedFonts += 1;
    }

    const metaEntries = await fs.readdir(META_CACHE_DIR, {
      withFileTypes: true,
    });
    for (const entry of metaEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const hash = entry.name.slice(0, -'.json'.length);
      if (!/^[a-f0-9]{40}$/.test(hash)) continue;

      const fontPath = getFontCachePath(hash);
      if (await fileExists(fontPath)) continue;

      const metaPath = getMetaCachePath(hash);
      const [meta, metaStat] = await Promise.all([
        readMeta(hash).catch(() => null),
        fs.stat(metaPath).catch(() => null),
      ]);
      const retentionTime = resolveRetentionTime(meta, metaStat);
      if (retentionTime == null || now - retentionTime <= CACHE_TTL_MS)
        continue;

      await fs.rm(metaPath, { force: true });
      removedOrphanMeta += 1;
      console.log(
        `cache cleanup removed orphan meta ${hash} (ttl>${CACHE_TTL_DAYS}d)`,
      );
    }

    console.log(
      `cache maintenance done: removed fonts=${removedFonts}, orphan meta=${removedOrphanMeta} (${Date.now() - start}ms)`,
    );
  })().finally(() => {
    cacheMaintenancePromise = null;
  });

  return cacheMaintenancePromise;
}

function scheduleCacheMaintenance() {
  const runSafe = () => {
    runCacheMaintenance().catch((error) => {
      console.warn(
        `cache maintenance failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    });
  };

  setTimeout(runSafe, 30 * 1000);
  setInterval(runSafe, CACHE_MAINTENANCE_INTERVAL_MS);
}

function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(Object.assign(error, { stdout, stderr, bin, args }));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }
      reject(
        Object.assign(new Error(`${bin} exited with code ${code}`), {
          code,
          stdout,
          stderr,
          bin,
          args,
        }),
      );
    });
  });
}

async function subsetWithSubsetFont({
  icons,
  tmpPath,
  sourceFontPath,
  sourceFontBuffer = null,
  hash = 'unknown',
}) {
  const totalStart = performance.now();
  const textArg = icons.join(' ');
  const readStart = performance.now();
  const sourceBuffer =
    sourceFontBuffer || (await getSourceFontBuffer(sourceFontPath));
  console.log(
    `timing ${hash}: subset read ${formatDuration(readStart)} (${sourceBuffer.length} bytes)`,
  );

  const subsetStart = performance.now();
  const subsetBuffer = await subsetFont(sourceBuffer, textArg, {
    targetFormat: 'woff2',
    preserveNameIds: [1, 4], // Keep the family and subfamily names
  });
  console.log(
    `timing ${hash}: subset core ${formatDuration(subsetStart)} (${subsetBuffer.length} bytes)`,
  );

  const writeStart = performance.now();
  await fs.writeFile(tmpPath, subsetBuffer);
  console.log(`timing ${hash}: subset write ${formatDuration(writeStart)}`);
  console.log(
    `timing ${hash}: subset total inner ${formatDuration(totalStart)}`,
  );
  return {
    command: `subset-font on ${sourceFontPath} with text "${textArg}"`,
    stdout: '',
    stderr: '',
  };
}

function buildInstancerAxisArg(axisName, spec) {
  if (!spec) return null;
  if (spec.mode === 'range') return `${axisName}=${spec.min}:${spec.max}`;
  return `${axisName}=${spec.value}`;
}

async function instanceVariableFont({ inputPath, outputPath, axes }) {
  const axisEntries = Object.entries(axes || {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const fixedAxisEntries = axisEntries.filter(
    ([, spec]) => spec?.mode === 'fixed',
  );
  const instancerArgs = axisEntries
    .map(([axisName, spec]) => buildInstancerAxisArg(axisName, spec))
    .filter(Boolean);
  if (!instancerArgs.length) {
    return {
      used: false,
      sourcePath: inputPath,
      outputPath: inputPath,
      command: null,
      stdout: '',
      stderr: '',
    };
  }

  if (SOURCE_MODE !== 'raw' && fixedAxisEntries.length === axisEntries.length) {
    await woff2.init();
    const buffer = await getSourceFontBuffer(inputPath);
    const font = createFont(buffer, { type: 'woff2' });

    const variation = {};
    fixedAxisEntries.forEach(([axisName, spec]) => {
      variation[axisName] = spec.value;
    });

    font.variation = variation;
    const outputBuffer = font.write({ type: 'woff2' });
    await fs.writeFile(outputPath, outputBuffer);

    return {
      used: true,
      sourcePath: inputPath,
      outputPath,
      command: `fonteditor-core instance ${Object.entries(variation)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
      stdout: '',
      stderr: '',
    };
  }

  const args = [
    'varLib.instancer',
    inputPath,
    ...instancerArgs,
    '--static',
    '-o',
    outputPath,
  ];
  const run = await runCommand(FONTTOOLS_BIN, args);
  return {
    used: true,
    sourcePath: inputPath,
    outputPath,
    command: `${FONTTOOLS_BIN} ${args.join(' ')}`,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

async function getStaticSourceCachePath({ staticAxes, sourceFontPath, type }) {
  const sourceStat = await getSourceFontStat(sourceFontPath);
  const coords = formatAxisCoords(staticAxes);
  const sourceKey = [
    STATIC_SOURCE_VERSION,
    type,
    sourceFontPath,
    sourceStat.size,
    sourceStat.mtimeMs,
    ...coords,
    SERVICE_VERSION,
  ].join('|');
  const filePart = coords
    .map((coord) => coord.replace('=', '-').replaceAll(':', '-').toLowerCase())
    .join('-');
  return path.join(
    STATIC_SOURCE_CACHE_DIR,
    `source-${type}-${filePart}-${shortHash(sourceKey)}.woff2`,
  );
}

async function migrateStaticSourceCacheByPrefix(targetPath, type, coords) {
  const targetName = path.basename(targetPath);
  const filePart = coords
    .map((coord) => coord.replace('=', '-').replaceAll(':', '-').toLowerCase())
    .join('-');
  const prefix = `source-${type}-${filePart}-`;
  const names = await fs.readdir(STATIC_SOURCE_CACHE_DIR);
  const legacyName = names.find(
    (name) =>
      name !== targetName && name.startsWith(prefix) && name.endsWith('.woff2'),
  );
  if (!legacyName) return null;

  const legacyPath = path.join(STATIC_SOURCE_CACHE_DIR, legacyName);
  await fs.rename(legacyPath, targetPath);
  console.log(`static source cache migrated: ${legacyName} -> ${targetName}`);
  return targetPath;
}

async function warmDefaultStaticSourceIndex() {
  defaultStaticSourceIndex.clear();
  const names = await fs.readdir(STATIC_SOURCE_CACHE_DIR);
  for (const type of Object.keys(FONT_TYPE_CONFIG)) {
    const prefix = buildDefaultStaticSourcePrefix(type);
    const match = names.find(
      (name) => name.startsWith(prefix) && name.endsWith('.woff2'),
    );
    if (match) {
      defaultStaticSourceIndex.set(
        type,
        path.join(STATIC_SOURCE_CACHE_DIR, match),
      );
    }
  }
  const loadedTypes = Array.from(defaultStaticSourceIndex.keys());
  console.log(
    loadedTypes.length
      ? `default static source index ready: ${loadedTypes.join(',')}`
      : 'default static source index empty',
  );
}

async function ensureStaticWeightSource(
  weight,
  axes = {},
  type,
  sourceFontPath,
) {
  if (!STATIC_WEIGHT_VALUES.includes(weight)) {
    throw new Error(`Unsupported static weight: ${weight}`);
  }

  const staticAxes = buildStaticSourceAxes(axes, weight);
  const coords = formatAxisCoords(staticAxes);

  if (isDefaultStaticAxes(weight, axes)) {
    const indexed = defaultStaticSourceIndex.get(type);
    if (indexed && (await fileExists(indexed))) {
      console.log(`static source cache hit (indexed default): ${type}`);
      return {
        path: indexed,
        axes: staticAxes,
        coords,
      };
    }
  }
  const coordLabel = coords.join(' ');
  const targetPath = await getStaticSourceCachePath({
    staticAxes,
    sourceFontPath,
    type,
  });
  if (await fileExists(targetPath)) {
    console.log(`static source cache hit: ${type} ${coordLabel}`);
    return {
      path: targetPath,
      axes: staticAxes,
      coords,
    };
  }
  const migratedPath = await migrateStaticSourceCacheByPrefix(
    targetPath,
    type,
    coords,
  );
  if (migratedPath) {
    if (isDefaultStaticAxes(weight, axes)) {
      defaultStaticSourceIndex.set(type, migratedPath);
    }
    console.log(`static source cache hit (migrated): ${type} ${coordLabel}`);
    return {
      path: migratedPath,
      axes: staticAxes,
      coords,
    };
  }

  const inflightKey = `source:${type}:${coordLabel}:${targetPath}`;
  if (sourceInflight.has(inflightKey)) return sourceInflight.get(inflightKey);

  const job = (async () => {
    const sourceStart = performance.now();
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    console.log(
      `static source cache miss: ${type} ${coordLabel} (${STATIC_SOURCE_VERSION})`,
    );
    try {
      await runCommand(FONTTOOLS_BIN, [
        'varLib.instancer',
        sourceFontPath,
        ...coords,
        '--static',
        '-o',
        tmpPath,
      ]);
      await fs.rename(tmpPath, targetPath);
      if (isDefaultStaticAxes(weight, axes)) {
        defaultStaticSourceIndex.set(type, targetPath);
      }
      console.log(
        `static source cached: ${type} ${coordLabel} via ${FONTTOOLS_BIN} -> ${targetPath} (${formatDuration(
          sourceStart,
        )})`,
      );
      return {
        path: targetPath,
        axes: staticAxes,
        coords,
      };
    } catch (error) {
      try {
        await fs.rm(tmpPath, { force: true });
      } catch {}
      throw error;
    }
  })().finally(() => sourceInflight.delete(inflightKey));

  sourceInflight.set(inflightKey, job);
  return job;
}

async function warmStaticWeightSources() {
  if (SOURCE_MODE === 'raw') {
    console.log('static source prebuild skipped (SOURCE_MODE=raw)');
    return;
  }
  if (!PREBUILD_STATIC_SOURCES) {
    console.log('static source prebuild skipped');
    return;
  }

  const start = performance.now();
  for (const [type, config] of Object.entries(FONT_TYPE_CONFIG)) {
    for (const opticalSize of PREBUILD_STATIC_OPTICAL_SIZES) {
      const opticalSizeAxis = {
        mode: 'fixed',
        value: opticalSize,
        raw: String(opticalSize),
      };
      for (const grade of PREBUILD_STATIC_GRADES) {
        const gradeAxis = {
          mode: 'fixed',
          value: grade,
          raw: String(grade),
        };
        for (const fill of PREBUILD_STATIC_FILLS) {
          const fillAxis =
            fill === 'mixed'
              ? {
                  mode: 'range',
                  min: 0,
                  max: 1,
                  raw: 'mixed',
                }
              : {
                  mode: 'fixed',
                  value: Number(fill),
                  raw: fill,
                };
          for (const weight of STATIC_WEIGHT_VALUES) {
            await ensureStaticWeightSource(
              weight,
              {
                FILL: fillAxis,
                GRAD: gradeAxis,
                opsz: opticalSizeAxis,
              },
              type,
              config.sourcePath,
            );
          }
        }
      }
    }
  }
  console.log(
    `static sources ready: types ${Object.keys(FONT_TYPE_CONFIG).join(
      ',',
    )}; weights ${STATIC_WEIGHT_VALUES.join(
      ',',
    )}; fills ${PREBUILD_STATIC_FILLS.join(
      ',',
    )}; grades ${PREBUILD_STATIC_GRADES.join(
      ',',
    )}; optical sizes ${PREBUILD_STATIC_OPTICAL_SIZES.join(',')} (${formatDuration(
      start,
    )})`,
  );
  await warmDefaultStaticSourceIndex();
}

async function generateSubsetFont({
  hash,
  type = DEFAULT_FONT_TYPE,
  family,
  origin = null,
  icons,
  axes,
  sourceFontPath,
  rootSourceFontPath = sourceFontPath,
  instanceAxes = axes,
}) {
  const totalStart = performance.now();
  const targetPath = path.join(FONT_CACHE_DIR, `${hash}.woff2`);
  if (await fileExists(targetPath)) return targetPath;

  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const instancedFontPath = `${targetPath}.instanced-${process.pid}-${Date.now()}.woff2`;
  const statStart = performance.now();
  const sourceStat =
    sourceFontPath === rootSourceFontPath
      ? await getSourceFontStat(rootSourceFontPath)
      : await fs.stat(sourceFontPath);
  const rootSourceStat = await getSourceFontStat(rootSourceFontPath);
  console.log(`timing ${hash}: source stat ${formatDuration(statStart)}`);

  let generator = 'subset-font';
  let command = null;
  let commandStdout = '';
  let commandStderr = '';
  let instancerCommand = null;
  let instancerStdout = '';
  let instancerStderr = '';
  let subsetError = null;
  let subsetSourcePath = sourceFontPath;

  try {
    const instanceStart = performance.now();
    const instanced = await instanceVariableFont({
      inputPath: sourceFontPath,
      outputPath: instancedFontPath,
      axes: instanceAxes,
    });
    console.log(
      `timing ${hash}: instance ${formatDuration(instanceStart)}${
        instanced.used ? '' : ' (skipped)'
      }`,
    );
    if (instanced.used) {
      subsetSourcePath = instanced.outputPath;
      instancerCommand = instanced.command;
      instancerStdout = instanced.stdout;
      instancerStderr = instanced.stderr;
      generator = 'fonteditor-core+subset-font';
    }

    const subsetStart = performance.now();
    const run = await subsetWithSubsetFont({
      hash,
      icons,
      tmpPath,
      sourceFontPath: subsetSourcePath,
      sourceFontBuffer:
        subsetSourcePath === rootSourceFontPath
          ? await getSourceFontBuffer(rootSourceFontPath)
          : null,
    });
    console.log(`timing ${hash}: subset ${formatDuration(subsetStart)}`);
    command = run.command;
    commandStdout = run.stdout;
    commandStderr = run.stderr;
  } catch (error) {
    subsetError = error;
    if (SUBSET_FALLBACK_MODE !== 'stub') {
      try {
        await fs.rm(tmpPath, { force: true });
      } catch {}
      try {
        await fs.rm(instancedFontPath, { force: true });
      } catch {}
      const details = error?.stderr || error?.message || 'pyftsubset failed';
      throw new Error(
        `Subset generation failed. Check subset-font library or set SUBSET_FALLBACK_MODE=stub. Details: ${details}`,
      );
    }

    generator = 'copy-full-font-stub-fallback';
    const fallbackStart = performance.now();
    await fs.copyFile(sourceFontPath, tmpPath);
    console.log(
      `timing ${hash}: fallback copy ${formatDuration(fallbackStart)}`,
    );
  }

  const renameStart = performance.now();
  await fs.rename(tmpPath, targetPath);
  console.log(`timing ${hash}: rename ${formatDuration(renameStart)}`);
  if (subsetSourcePath !== sourceFontPath) {
    try {
      await fs.rm(subsetSourcePath, { force: true });
    } catch {}
  } else {
    try {
      await fs.rm(instancedFontPath, { force: true });
    } catch {}
  }
  const metaStart = performance.now();
  const targetStat = await fs.stat(targetPath);

  const meta = {
    hash,
    type,
    family,
    origin,
    icons,
    axes,
    source: sourceFontPath,
    generator,
    version: SERVICE_VERSION,
    createdAt: new Date().toISOString(),
    sourceBytes: rootSourceStat.size,
    subsetSourceBytes: sourceStat.size,
    outputBytes: targetStat.size,
    reductionPercent: Number(
      (
        100 -
        (targetStat.size / Math.max(rootSourceStat.size, 1)) * 100
      ).toFixed(2),
    ),
    command,
    instancerCommand,
    instancerStdout,
    instancerStderr,
    commandStdout,
    commandStderr,
    lastAccessedAt: null,
    hitCount: 0,
    subsetError: subsetError
      ? {
          message: subsetError.message,
          stderr: subsetError.stderr || '',
          stdout: subsetError.stdout || '',
        }
      : null,
  };

  await writeMeta(hash, meta);
  await writeLatestMeta(meta);
  console.log(`timing ${hash}: meta ${formatDuration(metaStart)}`);
  console.log(`timing ${hash}: total ${formatDuration(totalStart)}`);
  return targetPath;
}

async function ensureSubsetCached(payload) {
  const {
    hash,
    type,
    family,
    origin = null,
    icons,
    axes,
    sourceFontPath,
  } = payload;
  const cached = path.join(FONT_CACHE_DIR, `${hash}.woff2`);
  if (await fileExists(cached)) {
    console.log(`subset font cache hit: ${hash} (${icons.length} icons)`);
    const metaPath = path.join(META_CACHE_DIR, `${hash}.json`);
    if (await fileExists(metaPath)) {
      try {
        const content = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(content);
        if (origin && meta.origin !== origin) {
          meta.origin = origin;
          await writeMeta(hash, meta);
        }
        await writeLatestMeta(meta);
      } catch {
        await writeLatestMeta({
          hash,
          type,
          family,
          origin,
          icons,
          axes,
          source: sourceFontPath,
          generator: 'cache-hit-no-meta',
          version: SERVICE_VERSION,
          createdAt: new Date().toISOString(),
        });
      }
    } else {
      await writeLatestMeta({
        hash,
        type,
        family,
        origin,
        icons,
        axes,
        source: sourceFontPath,
        generator: 'cache-hit-no-meta',
        version: SERVICE_VERSION,
        createdAt: new Date().toISOString(),
      });
    }
    return cached;
  }

  if (inflight.has(hash)) return inflight.get(hash);

  console.log(`subset font cache miss: ${hash} (${icons.length} icons)`);
  const job = generateSubsetFont(payload)
    .then((fontPath) => {
      console.log(`subset font cached: ${hash} -> ${fontPath}`);
      return fontPath;
    })
    .finally(() => inflight.delete(hash));
  inflight.set(hash, job);
  return job;
}

function buildPayload(query) {
  const type = normalizeFontType(query.type);
  const config = getFontTypeConfig(type);
  const icons = normalizeIconNames(String(query.icon_names || ''));
  const axes = applyDefaultAxes(normalizeAxes(query));
  const origin =
    query && Object.prototype.hasOwnProperty.call(query, '__origin')
      ? query.__origin || null
      : null;
  const family = config.family;
  const key = buildKey({ family, icons, axes });
  const hash = hashKey(key);
  return {
    type,
    family,
    origin,
    icons,
    axes,
    key,
    hash,
    sourceFontPath: config.sourcePath,
    rootSourceFontPath: config.sourcePath,
  };
}

function normalizeRequestParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params || {}).map(([key, value]) => {
      if (Array.isArray(value)) {
        return [key, value.join(',')];
      }

      return [key, value];
    }),
  );
}

function buildPayloadFromAxes({
  type = DEFAULT_FONT_TYPE,
  family,
  origin = null,
  icons,
  axes,
  sourceFontPath,
  rootSourceFontPath = sourceFontPath,
  instanceAxes,
  cacheKeySuffix = '',
}) {
  const key = buildCacheKey({ family, icons, axes, suffix: cacheKeySuffix });
  const hash = hashKey(key);
  return {
    type,
    family,
    origin,
    icons,
    axes,
    key,
    hash,
    sourceFontPath,
    rootSourceFontPath,
    instanceAxes,
  };
}

async function buildStaticWeightPayloads(payload) {
  const requestedWeight = payload.axes.wght;
  const requestedWeights =
    requestedWeight.mode === 'list'
      ? requestedWeight.values
      : [requestedWeight.value];
  const weights = requestedWeights.filter((weight) =>
    STATIC_WEIGHT_VALUES.includes(weight),
  );
  if (!weights.length) {
    throw new Error('No supported static weights requested');
  }

  const result = [];
  for (const weight of weights) {
    const axes = cloneAxesWithFixedWeight(payload.axes, weight);
    if (SOURCE_MODE === 'raw') {
      result.push(
        buildPayloadFromAxes({
          type: payload.type,
          family: payload.family,
          origin: payload.origin,
          icons: payload.icons,
          axes,
          sourceFontPath: payload.rootSourceFontPath,
          rootSourceFontPath: payload.rootSourceFontPath,
          instanceAxes: axes,
          cacheKeySuffix: `source-mode=raw`,
        }),
      );
      continue;
    }

    const staticSource = await ensureStaticWeightSource(
      weight,
      payload.axes,
      payload.type,
      payload.rootSourceFontPath,
    );
    result.push(
      buildPayloadFromAxes({
        type: payload.type,
        family: payload.family,
        origin: payload.origin,
        icons: payload.icons,
        axes,
        sourceFontPath: staticSource.path,
        rootSourceFontPath: payload.rootSourceFontPath,
        instanceAxes: subtractAxes(axes, staticSource.axes),
        cacheKeySuffix: `${STATIC_SOURCE_VERSION}|source=${staticSource.path}`,
      }),
    );
  }
  return result;
}

async function buildFontCssResult({ query, baseUrl }) {
  const accumulation = await resolveAccumulatedQuery(query || {});
  const payload = buildPayload(accumulation.query || {});
  const display = accumulation.query?.display;

  const persistOriginRegistry = async (result) => {
    if (!accumulation.accumulate || !accumulation.registryKey) return;
    const registryRecord = {
      key: accumulation.registryKey,
      origin: accumulation.origin,
      type: payload.type,
      family: payload.family,
      axes: payload.axes,
      icons: payload.icons,
      iconCount: payload.icons.length,
      currentHash: result.hash,
      fontHashes: result.fonts.map((font) => font.hash),
      mode: result.mode,
      updatedAt: new Date().toISOString(),
    };
    const writeJob = writeOriginRegistry(
      accumulation.registryKey,
      registryRecord,
    );
    originInflight.set(accumulation.registryKey, writeJob);
    await writeJob.finally(() => {
      if (originInflight.get(accumulation.registryKey) === writeJob) {
        originInflight.delete(accumulation.registryKey);
      }
    });
  };

  if (isStaticWeightRequest(payload.axes)) {
    const staticPayloads = await buildStaticWeightPayloads(payload);
    const generationStart = performance.now();
    await Promise.all(
      staticPayloads.map((staticPayload) => ensureSubsetCached(staticPayload)),
    );
    console.log(
      `static weight list cached: ${payload.hash} (${staticPayloads.length} weights, ${formatDuration(
        generationStart,
      )})`,
    );

    const fontFaces = staticPayloads.map((staticPayload) => ({
      hash: staticPayload.hash,
      weight: staticPayload.axes.wght.value,
    }));
    const css = cssResponse({
      display,
      axes: payload.axes,
      baseUrl,
      fontFaces,
    });
    const fonts = staticPayloads.map((staticPayload) => ({
      hash: staticPayload.hash,
      weight: staticPayload.axes.wght.value,
      source: staticPayload.sourceFontPath,
    }));
    const manifest = buildFontManifest({
      payload,
      mode: staticPayloads.length > 1 ? 'static-weight-list' : 'static-weight',
      fonts,
      css,
      baseUrl,
    });

    await writeLatestMeta({
      ...manifest,
      source: payload.rootSourceFontPath,
      generator: 'static-weight-list',
      version: SERVICE_VERSION,
      createdAt: new Date().toISOString(),
    });
    await persistOriginRegistry(manifest);

    return manifest;
  }

  await ensureSubsetCached(payload);
  const css = cssResponse({
    hash: payload.hash,
    display,
    axes: payload.axes,
    baseUrl,
  });
  const manifest = buildFontManifest({
    payload,
    mode: 'variable',
    fonts: [
      {
        hash: payload.hash,
        weight: cssFontWeight(payload.axes),
        source: payload.rootSourceFontPath,
      },
    ],
    css,
    baseUrl,
  });
  await persistOriginRegistry(manifest);
  return manifest;
}

// The landing page: what the service is, a live sample, the routes.
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  return res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'simai-font-service',
    version: SERVICE_VERSION,
    defaultType: DEFAULT_FONT_TYPE,
    fontTypes: await Promise.all(
      Object.entries(FONT_TYPE_CONFIG).map(async ([type, config]) => ({
        type,
        family: config.family,
        sourceFontPath: config.sourcePath,
        sourceFontExists: await fileExists(config.sourcePath),
      })),
    ),
    pyftsubsetBin: PYFTSUBSET_BIN,
    fonttoolsBin: FONTTOOLS_BIN,
    pythonBin: PYTHON_BIN,
    subsetFallbackMode: SUBSET_FALLBACK_MODE,
    prebuildStaticSources: PREBUILD_STATIC_SOURCES,
    prebuildStaticFills: PREBUILD_STATIC_FILLS,
    prebuildStaticGrades: PREBUILD_STATIC_GRADES,
    prebuildStaticOpticalSizes: PREBUILD_STATIC_OPTICAL_SIZES,
    sourceMode: SOURCE_MODE,
    inflight: inflight.size,
  });
});

async function handleFontCssRequest(req, res, params = {}) {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const origin = getRequestOrigin(req);
    const result = await buildFontCssResult({
      query: {
        ...normalizeRequestParams(params),
        __origin: origin,
      },
      baseUrl,
    });
    // result.icons = normalizeIconNames(String(req.query.icon_names || ''));
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    setFontResponseHeaders(res, result);
    res.send(result.css);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Bad request',
    });
  }
}

app.get('/ms/css', async (req, res) => {
  await handleFontCssRequest(req, res, req.query || {});
});

app.post('/ms/css', async (req, res) => {
  await handleFontCssRequest(req, res, req.body || {});
});

async function handleFontBuildRequest(req, res, params = {}) {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const origin = getRequestOrigin(req);
    const result = await buildFontCssResult({
      query: {
        ...normalizeRequestParams(params),
        __origin: origin,
      },
      baseUrl,
    });

    res.setHeader('Cache-Control', 'public, max-age=3600');
    setFontResponseHeaders(res, result);
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Bad request',
    });
  }
}

app.get('/ms/build', async (req, res) => {
  await handleFontBuildRequest(req, res, req.query || {});
});

app.post('/ms/build', async (req, res) => {
  await handleFontBuildRequest(req, res, req.body || {});
});

app.get('/ms/font/:hash.woff2', async (req, res) => {
  try {
    const hash = String(req.params.hash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) {
      return res.status(400).json({ ok: false, error: 'Invalid hash' });
    }

    const filePath = getFontCachePath(hash);
    if (!(await fileExists(filePath))) {
      return res.status(404).json({ ok: false, error: 'Font not found' });
    }

    await touchFontAccess(hash);
    res.setHeader('Content-Type', 'font/woff2');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filePath);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Server error',
    });
  }
});

app.get('/ms/meta/:hash', async (req, res) => {
  try {
    const hash = String(req.params.hash || '').toLowerCase();
    const metaPath = path.join(META_CACHE_DIR, `${hash}.json`);
    if (!(await fileExists(metaPath))) {
      return res.status(404).json({ ok: false, error: 'Meta not found' });
    }
    const content = await fs.readFile(metaPath, 'utf8');
    res.json(JSON.parse(content));
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Server error',
    });
  }
});

app.get('/ms/latest', async (_req, res) => {
  try {
    const latest = await readLatestMeta();
    if (!latest) {
      return res
        .status(404)
        .json({ ok: false, error: 'No generated fonts yet' });
    }
    res.json({ ok: true, latest });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Server error',
    });
  }
});

app.get('/ms/test', async (_req, res) => {
  try {
    const latest = await readLatestMeta();
    if (!latest) {
      return res
        .status(404)
        .send(
          '<h1>No generated fonts yet</h1><p>Call /ms/css?icon_names=home,palette,settings first.</p>',
        );
    }

    const icons = Array.isArray(latest.icons) ? latest.icons : [];
    const latestAxes =
      latest.axes && typeof latest.axes === 'object' ? latest.axes : {};
    const axisQuery = Object.entries(latestAxes)
      .map(([axis, spec]) => {
        const key = axis === 'FILL' ? 'fill' : axis === 'GRAD' ? 'grad' : axis;
        const value =
          spec?.mode === 'range'
            ? `${spec.min}..${spec.max}`
            : spec?.mode === 'list'
              ? spec.values.join(',')
              : (spec?.value ?? '');
        return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
      })
      .join('&');
    const cssHref =
      `/ms/css?icon_names=${encodeURIComponent(icons.join(','))}` +
      (axisQuery ? `&${axisQuery}` : '') +
      `&display=block`;
    const iconRows = icons
      .map(
        (name) => `
      <div class="card">
        <div class="label">${name}</div>
        <div class="row">
          <i class="sf-icon" style="--sf-icon--weight:400">${name}</i>
          <i class="sf-icon" style="--sf-icon--weight:700">${name}</i>
          <i class="sf-icon" style="--sf-icon--fill:1;--sf-icon--weight:400">${name}</i>
          <i class="sf-icon" style="--sf-icon--fill:1;--sf-icon--weight:700">${name}</i>
        </div>
      </div>`,
      )
      .join('\n');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SIMAI Font Test</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #0b1020; color: #e5e7eb; }
    .meta { margin-bottom: 16px; padding: 12px; background: #111827; border-radius: 8px; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
    .card { background: #111827; border: 1px solid #374151; border-radius: 8px; padding: 12px; }
    .label { font-size: 12px; opacity: .8; margin-bottom: 8px; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .sf-icon { font-size: 32px; color: #f3f4f6; }
    .probe { display: flex; gap: 12px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
    .chip { background: #1f2937; border-radius: 999px; padding: 6px 10px; font-size: 12px; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 6px; }
  </style>
  <link rel="stylesheet" href="${cssHref}" />
</head>
<body>
  <div class="meta">
    <div><strong>hash:</strong> ${latest.hash}</div>
    <div><strong>generator:</strong> ${latest.generator}</div>
    <div><strong>createdAt:</strong> ${latest.createdAt}</div>
    <div><strong>size:</strong> ${latest.outputBytes ?? '?'} bytes (source ${latest.sourceBytes ?? '?'}, reduction ${latest.reductionPercent ?? '?'}%)</div>
    <div><strong>icons:</strong> ${icons.join(', ')}</div>
    <div><strong>axes:</strong> <code>${JSON.stringify(latestAxes).replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code></div>
    <div><strong>command:</strong> <code>${(latest.command || 'n/a').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code></div>
    <div><strong>instancer:</strong> <code>${(latest.instancerCommand || 'n/a').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code></div>
    <div class="probe">
      <span class="chip">wght 100</span><i class="sf-icon" style="--sf-icon--weight:100">settings</i>
      <span class="chip">wght 700</span><i class="sf-icon" style="--sf-icon--weight:700">settings</i>
      <span class="chip">fill 0/1</span>
      <i class="sf-icon" style="--sf-icon--fill:0;--sf-icon--weight:400">home</i>
      <i class="sf-icon" style="--sf-icon--fill:1;--sf-icon--weight:400">home</i>
    </div>
  </div>
  <div class="grid">${iconRows}</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    res
      .status(500)
      .send(
        `<pre>${error instanceof Error ? error.stack : 'Server error'}</pre>`,
      );
  }
});
console.log(
  'STARTING SERVER... Checking source font availability and caching...',
);
await ensureDirs();
await warmSourceFontCache();
await warmDefaultStaticSourceIndex();
await warmStaticWeightSources();
scheduleCacheMaintenance();

app.listen(PORT, HOST, () => {
  console.log(`simai-font-service listening on http://${HOST}:${PORT}`);
  console.log(`DEFAULT_FONT_TYPE=${DEFAULT_FONT_TYPE}`);
  Object.entries(FONT_TYPE_CONFIG).forEach(([type, config]) => {
    console.log(`FONT_SOURCE_${type.toUpperCase()}=${config.sourcePath}`);
  });
  console.log(`PYFTSUBSET_BIN=${PYFTSUBSET_BIN}`);
  console.log(`FONTTOOLS_BIN=${FONTTOOLS_BIN}`);
  console.log(`SUBSET_FALLBACK_MODE=${SUBSET_FALLBACK_MODE}`);
  console.log(`SOURCE_MODE=${SOURCE_MODE}`);
  console.log(`CACHE_TTL_DAYS=${CACHE_TTL_DAYS}`);
  console.log(`CACHE_MAINTENANCE_INTERVAL_MS=${CACHE_MAINTENANCE_INTERVAL_MS}`);
  console.log(`PREBUILD_STATIC_SOURCES=${PREBUILD_STATIC_SOURCES ? '1' : '0'}`);
  console.log(`PREBUILD_STATIC_FILLS=${PREBUILD_STATIC_FILLS.join(',')}`);
  console.log(`PREBUILD_STATIC_GRADES=${PREBUILD_STATIC_GRADES.join(',')}`);
  console.log(
    `PREBUILD_STATIC_OPTICAL_SIZES=${PREBUILD_STATIC_OPTICAL_SIZES.join(',')}`,
  );
});
