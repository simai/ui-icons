# SIMAI Framework icon service

The service behind https://icons.simai.io. It cuts Material Symbols fonts
down to the icons a page uses, so that a SIMAI Framework page loads a few
kilobytes of icons instead of megabytes.

The Framework's client side is in
[simai/ui-source](https://github.com/simai/ui-source)
(`src/core/js/iconSubsetRuntime.js`), and the build adapter is in
[simai/ui-builder](https://github.com/simai/ui-builder)
(`libs/iconSubsetServiceAdapter.js`).

## Routes

| Route | What it returns |
|---|---|
| `GET /health` | The service state and its configuration. |
| `GET\|POST /ms/css` | A stylesheet with `@font-face` for the requested icons (`icon_names`, `type` = outlined, rounded or sharp, plus `fill`, `weight`, `grad` and `opsz`, see [Axes](#axes)). |
| `GET\|POST /ms/build` | Builds a subset and returns its manifest. |
| `GET /ms/font/:hash.woff2` | A built subset. |
| `GET /ms/meta/:hash` | The manifest of a built subset. |
| `GET /ms/latest` | The latest build. |
| `GET /ms/test` | A test page. |

Responses carry `X-SIMAI-Font-Hash`, `X-SIMAI-Font-Mode` and
`X-SIMAI-Font-Manifest`.

## Axes

A request names the axes by the font's tags in lower case: `weight` (or
`wght`), `fill`, `grad`, `opsz`. A value is one number (`opsz=20`), a list
(`grad=-25,0`) or a range (`opsz=20..48`); a value or a range past the
Material Symbols design space (GRAD -25..200, opsz 20..48) is clamped to it.

- Weight picks the static faces (one font per weight).
- A fixed fill, grade or optical size cuts a static instance at that point.
- A range of fill, grade or optical size stays a variable axis in the subset,
  limited to the range: one font draws every point in it, and each icon picks
  its own with `font-variation-settings`. Since 0.2.0 grade and optical size
  are kept as FILL always was; before, a range of either was dropped and the
  font was cut at GRAD 0 and opsz 24.
- The SIMAI Framework asks for `grad=-25..0` (its light and dark themes) and
  `opsz=20..48` (every icon size) on every page, widened to an author's grade.
  A static source for each range is cut once (an instancer run of 20-35 s per
  weight and fill on a laptop) and kept in `cache/sources`;
  `PREBUILD_FRAMEWORK_RANGES` prepares the Framework's after the service
  starts listening.
- `grade`, `optical_size`, `optical-size` and `opticalsize` are read as
  aliases of `grad` and `opsz` until 2027-01-01 (the Framework sent those
  names, which the service never read); the service's own name wins when a
  request carries both. Each alias read is logged once per process. The old
  Framework sent an old name only for an author's own value (`grade=200` for
  one icon) and sets every icon's point with `font-variation-settings`, so an
  alias value is clamped to the design space and widened to the page range
  (`grade=200` reads as `grad=-25..200`, `optical_size=40` as `opsz=20..48`):
  read as one point it would cut the whole page's font at that icon's grade.

Measured locally on 2026-11-19 (subset bytes, weights 400 and 500 together):

| Icon set | Before (GRAD 0, opsz 24) | grad -25..0, opsz 20..48 | grad -25..200, opsz 20..48 |
|---|---|---|---|
| docs page, 36 names, fill 0..1 | 12 144 | 28 668 | 37 432 |
| admin menu, 25 names | 8 360 | 17 256 | 21 580 |

The full Outlined font is 3 915 912 bytes.

## Running it

It needs Node.js 22 or newer, Python 3.11 or newer and Yarn Classic 1.22.

```sh
npx yarn@1.22.22 install --frozen-lockfile
# npm test: the axis tests and a service started on a free port
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
PATH="$PWD/.venv/bin:$PATH" npm start
```

- The service spawns `pyftsubset` and the fontTools instancer from
  `requirements.txt`; set `PYFTSUBSET_BIN`, `FONTTOOLS_BIN` or
  `PYTHON_BIN` if they are not on `PATH`.
- With `PREBUILD_STATIC_SOURCES=1` it prepares static instances of every
  style, weight and fill before it starts listening: about 6 minutes on
  the first start. They are kept in `cache/`, so later starts are fast.
- Production deploys with [simai-env](https://github.com/simai/simai-env)
  (1.16 or newer) from `.simai/app.json`:
  - the node profile runs `node src/server.js` as a systemd service under
    the site account, behind nginx;
  - systemd provides PORT and HOST from the simai-managed `.env`, seeded
    once from `.env.example`;
  - `requirements.txt` goes into a `.venv` in the release, with `.venv/bin`
    on the service `PATH`;
  - `cache/` is shared across releases;
  - a release goes live only after `/health` answers. The health timeout
    is 1800 s, because the first prebuild on one vCPU is slow.
- The service resolves `cache/` and the font paths against its working
  directory, so it must start in the release root.
- Until icons.simai.io is cut over to the simai-env server, the old server
  runs `npm run start:prod` (`.env.production`) under pm2.

Settings, all read from the environment (`.env.example` holds production's
values):

- `PORT`, `HOST`, `TRUST_PROXY`;
- `SOURCE_MODE`, `SUBSET_FALLBACK_MODE`;
- `PREBUILD_STATIC_SOURCES`, `PREBUILD_STATIC_FILLS`,
  `PREBUILD_STATIC_GRADES`, `PREBUILD_STATIC_OPTICAL_SIZES` (values and
  ranges: `0,-25..0`, `24,20..48`);
- `PREBUILD_FRAMEWORK_RANGES` (default on; `0` skips),
  `PREBUILD_FRAMEWORK_RANGE_WEIGHTS` (default `400,500`): the static sources
  of the Framework's ranges, every type, fill 0 and mixed, built one at a time
  after the service listens;
- `FONT_SOURCE_PATH_OUTLINED`, `FONT_SOURCE_PATH_ROUNDED`,
  `FONT_SOURCE_PATH_SHARP`;
- `CACHE_TTL_DAYS`, `CACHE_MAINTENANCE_INTERVAL_MS`, `MAX_ICON_COUNT`,
  `MAX_QUERY_LENGTH`;
- `PYFTSUBSET_BIN`, `FONTTOOLS_BIN`, `PYTHON_BIN`;
- `SUBSET_WORKERS` (default: CPU cores minus one, at most 4; `0` builds
  in the main thread), `PREBUILD_ICON_NAMES` (`0` skips the vocabulary
  warm-up), `SUBSET_GLYPHS` (`0` builds every list as subset-font's
  closure subset, as before 2026-11-10, still in the workers).

## How a subset is built

- A new list is built by a subset worker (`src/subset-pool.js`,
  `worker_threads`), never on the request thread: lists asked for at the
  same time build side by side, and cached lists answer while they do.
- Each name is shaped once against the source to find its ligature glyph,
  at every corner of the source's design space (Material Symbols swaps some
  glyphs by FILL). The subset keeps those glyphs and the letters, nothing
  else (`src/subset-core.js`). A list with a name that does not shape to one
  glyph falls back to subset-font's closure subset (every ligature the
  letters can spell). The generator in a subset's meta says which:
  `subset-core:glyphs` or `subset-core:closure`.
- At start every worker decodes the default static sources and shapes the
  SIMAI Framework's known icon names (`src/vocabulary/framework-icons.json`).

Measured locally on 2026-11-10 (R074): 8 new lists of 40 names asked for
together came back in 0.08-0.17 s each with 4 workers (0.25 s with one
worker, 0.34 s in the main thread); before, all eight came back together
at 15.6 s, and a cached list asked meanwhile waited 15.5 s. A 40-name
subset is about 5 KB instead of about 245 KB; every name of the vocabulary
draws pixel-identical to the source font.

## Status

Version 0.2.0 (grad and opsz ranges kept, old names as aliases).
Version 0.1.0: the code ran only on the production server and was in no
repository; this repository was created from it on 2026-10-19.
`src/server.js` is the running version, with only its four comments
translated to English.

Checked on 2026-10-19: for the same request, a local run gives the same
subset hash and mode as icons.simai.io. The woff2 bytes still differ
slightly (2244 vs 2240), with the same fontTools and Brotli but a
different Python (3.14 locally, 3.11 in production). Use Python 3.11 for
byte-identical output.

## Licence

The service code is under the Apache License 2.0, see [LICENSE](LICENSE).
The fonts in `src/fonts/` are Material Symbols by Google, also under the
Apache License 2.0; see [NOTICE](NOTICE).
