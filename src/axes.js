// Axis parameters of a request: names, values, ranges.
//
// The service's parameter names are the font's axis tags in lower case
// (wght or weight, fill, grad, opsz). The SIMAI Framework asked for grade and
// optical size as `grade` and `optical_size`, names the service never read:
// an author's grade and every optical size reached it as nothing, and the font
// came back at GRAD 0 and opsz 24 (ui-control evidence 2026-11-19-admin-menu-fw).
// The old names are read as aliases of grad and opsz until 2027-01-01; the
// service's own name wins when a request carries both. A Framework that sends
// an old name sends it only for an author's own value (grade=200 for one icon)
// and sets every icon's point with font-variation-settings, so an alias value
// is widened to the page range the current Framework asks for (grad -25..0,
// opsz 20..48): read as a fixed point it would cut the whole page's font at
// that one icon's grade.

export const AXIS_NAME_MAP = {
  wght: 'wght',
  weight: 'wght',
  fill: 'FILL',
  grad: 'GRAD',
  opsz: 'opsz',
  rond: 'ROND',
};

// Old names, read until 2027-01-01 (ALIAS_SUNSET), then dropped.
export const ALIAS_SUNSET = '2027-01-01';
export const AXIS_ALIASES = {
  grade: 'GRAD',
  optical_size: 'opsz',
  'optical-size': 'opsz',
  opticalsize: 'opsz',
};

// The ranges the SIMAI Framework asks for on every page.
export const PAGE_RANGES = {
  GRAD: [-25, 0],
  opsz: [20, 48],
};

// An old name's value, clamped to the design space (the old Framework sent an
// author's attribute as written: grade=500 draws as 200), widened to the page
// range.
function widenToPageRange(axis, raw) {
  const range = PAGE_RANGES[axis];
  const bounds = AXIS_BOUNDS[axis];
  if (!range || !bounds) return null;
  const points = String(raw)
    .split(/,|\.\./)
    .map((item) => Number(item.trim()))
    .filter((num) => Number.isFinite(num))
    .map((num) => Math.max(bounds[0], Math.min(bounds[1], num)));
  if (!points.length) return null;
  return {
    mode: 'range',
    min: Math.min(range[0], ...points),
    max: Math.max(range[1], ...points),
    raw,
  };
}

// The Material Symbols design space: a value or range past it is clamped.
export const AXIS_BOUNDS = {
  wght: [100, 700],
  FILL: [0, 1],
  GRAD: [-25, 200],
  opsz: [20, 48],
};

const notedAliases = new Set();
// One log line per alias and process: who still sends an old name.
export function noteAxisAlias(name, axis, log = console) {
  if (notedAliases.has(name)) return;
  notedAliases.add(name);
  log.log?.(
    `axis alias read: ${name} -> ${axis.toLowerCase()} (old name, read until ${ALIAS_SUNSET})`,
  );
}

// A prebuild list (PREBUILD_STATIC_GRADES, PREBUILD_STATIC_OPTICAL_SIZES):
// values and ranges, "0,-25..0" or "24,20..48", each parsed as a request's
// value would be. Answers axis specs, values first, unique.
export function parseStaticAxisList(raw, axisName) {
  const seen = new Set();
  const specs = [];
  String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      let spec = null;
      try {
        spec = parseAxisValue(item, axisName);
      } catch {
        spec = null;
      }
      if (!spec || (spec.mode !== 'fixed' && spec.mode !== 'range')) return;
      const key = spec.mode === 'range' ? `${spec.min}..${spec.max}` : String(spec.value);
      if (seen.has(key)) return;
      seen.add(key);
      specs.push({ ...spec, raw: item });
    });
  return specs;
}

export function parseAxisValue(raw, axisName) {
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  const lowerValue = value.toLowerCase();

  const clampValue = (axisName, num) => {
    const bounds = AXIS_BOUNDS[axisName];
    return bounds ? Math.max(bounds[0], Math.min(bounds[1], num)) : num;
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
    const low = Number(rangeMatch[1]);
    const high = Number(rangeMatch[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      throw new Error(`Invalid axis range for ${axisName}: ${value}`);
    }
    const min = clampValue(axisName, Math.min(low, high));
    const max = clampValue(axisName, Math.max(low, high));
    if (min > max) return null;
    // A range of one value is that value.
    if (min === max) {
      return { mode: 'fixed', value: min, raw: value };
    }
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

export function normalizeAxes(query = {}) {
  const axes = {};
  const fromAlias = {};

  Object.entries(query).forEach(([key, raw]) => {
    if (raw == null || raw === '') return;
    const lowerKey = String(key).toLowerCase();
    const alias = AXIS_ALIASES[lowerKey];
    const normalizedKey = AXIS_NAME_MAP[lowerKey] || alias;
    if (!normalizedKey) return;
    // The service's own name wins over an old alias, in either order.
    if (alias && axes[normalizedKey] && !fromAlias[normalizedKey]) return;
    const parsed = alias
      ? widenToPageRange(normalizedKey, String(raw))
      : parseAxisValue(raw, normalizedKey);
    if (parsed) {
      axes[normalizedKey] = parsed;
      fromAlias[normalizedKey] = Boolean(alias);
      if (alias) noteAxisAlias(lowerKey, normalizedKey);
    }
  });

  return axes;
}
