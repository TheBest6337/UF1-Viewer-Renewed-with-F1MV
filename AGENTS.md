# AGENTS.md — UF1 Viewer Renewed

> AI coding agents: read this before making changes.

## Project overview

Electron desktop app that extends [MultiViewer for F1](https://muvi.gg/) with overlay windows showing live race data. Uses `npm_f1mv_api` for live F1 timing data via GraphQL polling.

- **Entry:** `src/index.js` (main process — window manager + IPC broker)
- **Lang:** Pure JS, CommonJS `require`/`module.exports` (no TS, no `import`)
- **Electron:** v42, `nodeIntegration: true`, `contextIsolation: false`; `preload.js` is **empty**
- **Security model:** none — renderers have full Node.js access
- **CI (GitHub Actions):** push to `Working` branch + tagged `v*` releases — runs on macOS ARM + Ubuntu + Windows, Node 22, `npm ci` → `electron-builder`
- **Packaging:** `electron-builder.yml` — macOS (dmg, x64+arm64), Windows (nsis, x64+ia32), Linux (AppImage, x64)
- **No opencode.json** — project is not OpenCode-configured

## Architecture

### Multi-window model

Main process creates one `BrowserWindow` per feature via a generic IPC handler (`"window"`). Every feature is a directory under `src/`:

```
featurename/
├── index.html       # Skeleton, loads CSS + scripts with <script defer>
├── index.js         # Logic: config → API polling → DOM render
└── style.css        # Styles
```

Exceptions: `src/main/` (hub window, more complex with multiple sections), `src/weather/` (React + Webpack), `src/statuses/` (has a `slippery.png` asset), `src/main/tempstream/` (incomplete — 2 files, no JS).

### Feature module pattern

Every `index.js` follows this flow:

```
getConfigurations() → discoverF1MV() → apiRequests() → render()
                                                      ↺ setInterval(80ms)
```

Key conventions (detailed in `.github/instructions/feature-window.instructions.md`):
- `const debug = false` at top, `if (debug) console.log(...)` for all logging
- Config access uses **double nesting**: `config.config.network.host` (store wraps all under a `config` key)
- `const { ipcRenderer } = require("electron")` — never `window.electron`
- Poll at 80ms (`const loopspeed = 80`), avoid heavy sync work in render loop
- Module-level variables persist between `setInterval` calls (intentional state caching)

### IPC channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `"window"` | Renderer → Main | Create BrowserWindow from `internal_settings.windows.*` |
| `"get_store"` | Renderer → Main | Read full electron-store |
| `"write_store"` | Renderer → Main | Write `config.section.key` |
| `"reset_store"` | Renderer → Main | Reset all stored data |
| `"saveLayout"` | Renderer → Main | Save window positions + F1MV state |
| `"restoreLayout"` | Renderer → Main | Recreate saved layout |

### Weather module (special case)

- React + Nivo charts, compiled by **Webpack + Babel** (`src/weather/webpack.common.js`)
- Entry: `src/weather/src/index.js`, output: `src/weather/build/js/app.js`
- Dev rebuild: `npm run watch_weather`

### Shared utilities

| File | Exports |
|------|---------|
| `src/functions/driver.js` | `isDriverOnPushLap()`, `getDriverPosition()` |
| `src/functions/car.js` | `getCarData()`, `weirdCarBehaviour()` |
| `src/functions/colors.js` | `getColorFromStatusCodeOrName()`, `rgbToHex()` |
| `src/functions/times.js` | `parseLapOrSectorTime()`, `formatMsToF1()` |
| `src/scripts/movemode.js` | Escape-key drag toggle (included via `<script defer>`) |

## Developer commands

| Command | Purpose |
|---------|---------|
| `npm start` | Dev — runs `electron .`. `electron-reload` watches `src/` |
| `npm run watch_weather` | Rebuild weather module on changes |
| `npm run pack` | Build to `out/` without packaging (`electron-builder --dir`) |
| `npm run dist` | Full production build |
| `npm run lint` | No-op (`echo "No linting configured"`) |

## No tests or linting

The project has no test framework and no linter configured. Add with care.

## Gotchas

- **F1MV must be running locally** — the app depends on a running MultiViewer for F1 instance for all API calls
- **Config is nested under `config` key** in electron-store — always accessed as `config.config.section.key`
- **Settings UI auto-generates** form fields from `config.*` keys — HTML input `id` must match the config key name
- **Transparent overlay windows** use Escape key (via `movemode.js`) to toggle drag mode vs. functional mode
- **Team icons** use relative paths from the module directory: `../icons/teams/mercedes.png`
- **No subdirectories** in feature modules — keep to 3 flat files
- **`electron-reload`** auto-reloads on file changes during dev — don't fight it

## Related instruction files

- `.github/instructions/feature-window.instructions.md` — detailed feature module conventions with code templates
- `.github/skills/new-feature-window/SKILL.md` — step-by-step skill for scaffolding a new window
