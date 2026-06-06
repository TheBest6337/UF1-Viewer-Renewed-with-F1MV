# AGENTS.md — Ultimate Formula 1 Viewer (UF1)

> AI coding agents: read this before making changes.

## Project overview

UF1 is an **Electron 22** desktop app that extends [MultiViewer for F1](https://muvi.gg/) with additional overlay windows showing live race data (lap times, track status, weather, tire stats, etc.). It uses the MultiViewer API (`npm_f1mv_api`) to fetch live F1 timing data.

- **Entry point:** `src/index.js` (Electron main process)
- **Language:** Pure JavaScript (no TypeScript)
- **Build:** `npm start` (dev), `npm run dist` (production)
- **CI:** GitHub Actions on push to `Working` branch; auto-publishes tagged releases — see [.github/workflows/main.yml](.github/workflows/main.yml)

See [readme.md](readme.md) for user-facing documentation.

## Architecture

### Multi-window model

The main process (`src/index.js`) is a **window manager & IPC broker**. Every feature is a separate `BrowserWindow` created via an IPC `"window"` handler. Renderer processes have **`nodeIntegration: true` and `contextIsolation: false`** — they can use `require` directly and call `ipcRenderer.invoke`.

### Feature module pattern

Every feature window follows the same structure:

```
featurename/
├── index.html     # Skeleton HTML, loads scripts
├── index.js       # Logic: config → API polling → DOM render
└── style.css      # Styles
```

**Standard `index.js` flow:**

1. Load config via `ipcRenderer.invoke("get_store")`
2. Discover F1MV instance via `f1mvApi.discoverF1MVInstances(host)`
3. Poll F1MV API with `f1mvApi.LiveTimingAPIGraphQL(config, fields)` in a `setInterval` (typically 80–100 ms)
4. Render data into the DOM

### IPC channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `"window"` | Renderer → Main | Create a new BrowserWindow |
| `"get_store"` | Renderer → Main | Read electron-store config |
| `"write_store"` | Renderer → Main | Write a key to electron-store |
| `"reset_store"` | Renderer → Main | Reset all stored data |
| `"saveLayout"` | Renderer → Main | Save window positions + F1MV state |
| `"restoreLayout"` | Renderer → Main | Recreate saved layout |

### Key dependencies

| Package | Usage |
|---------|-------|
| `npm_f1mv_api` | MultiViewer API client (discovery, live timing GraphQL, player control) |
| `electron-store` | Persistent config (settings, layouts, team icons) |
| `discord-rpc` | Discord Rich Presence integration |
| `govee-lan-control` | Govee LED light integration (flagdisplay) |
| `@nivo/line`, `@nivo/bullet` + `react`/`react-dom` | Charts in the weather module |

## Conventions

### Window creation

- Windows are frameless, often transparent overlays (`frame: false, transparent: true`)
- Configs live in `internal_settings.windows` in electron-store (see default values in `src/index.js`)
- Use `ipcRenderer.invoke("window", ...Object.values(internalSettings.windows.featureName))` to open

### Config access

- Read: `const config = await ipcRenderer.invoke("get_store")` — returns the full store
- Write: `await ipcRenderer.invoke("write_store", "config.section.key", value)`

### Shared utilities

- `src/functions/driver.js` — `isDriverOnPushLap()`, `getDriverPosition()`
- `src/functions/car.js` — `getCarData()`, `weirdCarBehaviour()`
- `src/functions/colors.js` — `getColorFromStatusCodeOrName()`, `rgbToHex()`
- `src/functions/times.js` — `parseLapOrSectorTime()`, `formatMsToF1()`
- `src/scripts/movemode.js` — Escape-key toggle for window dragging (shared across modules)

### Weather module (special case)

The weather module uses **Webpack + Babel + React** (Nivo charts). Its entry is `src/weather/src/index.js`, output goes to `src/weather/build/js/app.js`. Run `npm run watch_weather` during development to rebuild on change.

## Gotchas

- **No security boundary:** `contextIsolation: false` / `nodeIntegration: true` means renderer code has full Node.js access. Be careful with untrusted content.
- **No linting or tests:** The project has neither configured. Add them carefully if needed.
- **Polling-based UI:** Windows use `setInterval` for rendering. Avoid heavy synchronous work in render loops — it will freeze the UI.
- **F1MV must be running:** The app depends on a local MultiViewer for F1 instance. API calls will fail without it.
- **Config shape matters:** The main window's settings UI auto-generates form fields from `config.*` keys. Adding new config sections must match the expected nesting.
