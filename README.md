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
| `GET\|POST /ms/css` | A stylesheet with `@font-face` for the requested icons (`icon_names`, `type` = outlined, rounded or sharp, plus fill, weight, grade and optical size). |
| `GET\|POST /ms/build` | Builds a subset and returns its manifest. |
| `GET /ms/font/:hash.woff2` | A built subset. |
| `GET /ms/meta/:hash` | The manifest of a built subset. |
| `GET /ms/latest` | The latest build. |
| `GET /ms/test` | A test page. |

Responses carry `X-SIMAI-Font-Hash`, `X-SIMAI-Font-Mode` and
`X-SIMAI-Font-Manifest`.

## Running it

It needs Node.js 22 or newer, Python 3.11 or newer and Yarn Classic 1.22.

```sh
npx yarn@1.22.22 install --frozen-lockfile
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
  `PREBUILD_STATIC_GRADES`, `PREBUILD_STATIC_OPTICAL_SIZES`;
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

Version 0.1.0. The code ran only on the production server and was in no
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
