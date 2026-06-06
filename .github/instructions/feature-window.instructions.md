---
description: "Use when: creating a new overlay window, adding a feature module, building a new data display, or extending UF1 with a new timing/data visualization window. Covers the complete 3-file module pattern (index.html, index.js, style.css), main process registration, and main window launcher integration."
applyTo: "src/**/index.js,src/**/index.html,src/**/style.css"
---
# UF1 Feature Window Pattern

When creating a new feature window, follow this exact module structure. See existing modules like `compass/`, `currentlaps/`, and `trackinfo/` as reference implementations.

## The 3-File Module

Every feature window is a directory under `src/` with exactly three files:

```
featurename/
├── index.html     # Skeleton HTML, loads CSS and scripts
├── index.js       # Logic: config → API polling → DOM render
└── style.css      # Styles (optional; can be minimal for simple modules)
```

## `index.html` Skeleton

```html
<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Feature Name</title>
        <link rel="stylesheet" href="style.css" />
        <link rel="stylesheet" href="../fonts/fonts.css" />
        <link rel="stylesheet" href="../styles/window_info.css" />

        <script src="./index.js" defer></script>
        <!-- Include movemode.js if the window should be draggable with Escape key -->
        <script src="../scripts/movemode.js" defer></script>
    </head>
    <body id="background" class="drag">
        <!-- Your UI here -->
    </body>
</html>
```

- CSS files must be loaded with `<link>`, scripts with `<script defer>`
- `<body>` should have `id="background"` — this is the standard for drag region and transparency toggles
- The `drag` class on body makes the window draggable by default (via `-webkit-app-region: drag` in CSS)
- Include `../styles/window_info.css` if showing header text like "Current Push Laps"
- Include `../scripts/movemode.js` (defer) to enable Escape-key drag toggle

## `index.js` Conventions

### Standard module structure

```javascript
const debug = false;   // ALWAYS include — toggle for console.log output
const loopspeed = 80;  // If using setInterval, 80ms is standard

const f1mvApi = require("npm_f1mv_api");
const { ipcRenderer } = require("electron");

// Optional: import shared utilities
// const { isDriverOnPushLap } = require("../functions/driver.js");
// const { getColorFromStatusCodeOrName } = require("../functions/colors.js");
// const { parseLapOrSectorTime, formatMsToF1 } = require("../functions/times.js");

let host, port;

// Step 1: Load config and discover F1MV
async function getConfigurations() {
    const config = await ipcRenderer.invoke("get_store");
    host = config.config.network.host;      // Note: double .config nesting!
    port = (await f1mvApi.discoverF1MVInstances(host)).port;
}

// Step 2: Fetch data from F1MV API
async function apiRequests() {
    const apiConfig = { host, port };
    const liveTimingState = await f1mvApi.LiveTimingAPIGraphQL(apiConfig, [
        "DriverList",
        "TimingData",
        "SessionInfo",
        // Add only the fields you need
    ]);
    // Store results in module-level variables for the render loop
}

// Step 3: Render loop
function render() {
    // DOM updates go here
}

// Step 4: Entry point
async function run() {
    await getConfigurations();
    await apiRequests();
    render();
    setInterval(async () => {
        await apiRequests();
        render();
    }, loopspeed);
}

run();
```

### Key rules

- **`debug` variable at top**: Every module starts with `const debug = false`. Use `if (debug) console.log(...)` for all logging.
- **Config access uses double nesting**: `config.config.network.host` (the store object has `config` as a top-level key, then the actual config keys are under it)
- **Use `require` not `import`**: The project has `nodeIntegration: true`, `contextIsolation: false`. Direct `require` calls work everywhere.
- **IPCRenderer via `electron`**: Always `const { ipcRenderer } = require("electron")` — do NOT use `window.electron` or any other pattern
- **Poll via `setInterval`**: Standard interval is 80ms (`const loopspeed = 80`). Avoid heavy synchronous work in the loop.
- **One `run()` entry point**: Call `run()` at the bottom of the script. No `DOMContentLoaded` listeners needed since scripts are `defer`-loaded.

## Window Background & Drag Conventions

Frameless windows use CSS to control drag regions:

```css
.drag {
    -webkit-app-region: drag;
}
.no-drag {
    -webkit-app-region: no-drag;  /* Use on interactive elements like buttons */
}
```

The standard Escape-key toggle pattern (from `movemode.js`):
- When drag mode is active: background becomes visible, window is repositionable
- When drag mode is off: background is transparent, window is functional

## Main Process Registration

In `src/index.js`, add a new window definition to the `internal_settings.windows` defaults:

```javascript
featurename: {
    path: "featurename/index.html",
    width: 400,
    height: 300,
    frame: false,        // No title bar — almost always false for overlays
    hideMenuBar: true,
    transparent: true,   // For overlay-style windows
    hasShadow: false,
    alwaysOnTop: null,   // null = uses config.general.always_on_top override
    aspectRatio: null,   // Optional: enforce aspect ratio
    icon: "icons/windows/featurename.png",
}
```

Window creation in the main process IPC handler is generic — it already handles any window definition passed via `Object.values()`. No new IPC handler is needed unless the window requires special creation logic.

## Main Window Launcher Button

In `src/main/index.js`, add a launcher function:

```javascript
async function featureName() {
    const internalSettings = (await ipcRenderer.invoke("get_store")).internal_settings;
    await ipcRenderer.invoke("window", ...Object.values(internalSettings.windows.featurename));
}
```

In `src/main/index.html`, add the corresponding button in the windows section.

## Config Settings (if needed)

If the feature has user-configurable settings:

1. Add config defaults in `src/index.js` under `config`:
   ```javascript
   featurename: { option_name: "default_value" }
   ```

2. The main window's settings UI auto-maps HTML `<input id="option_name">` to `config.featurename.option_name` — the ID matching is automatic

3. Access in the module:
   ```javascript
   const featureConfig = config.config.featurename;
   ```

## Common Gotchas

- **Config data lives at `config.config.*`** in renderers (the store wraps everything under a `config` key)
- **Team icons use relative paths** like `../icons/teams/mercedes.png` — always from the module's directory
- **Do NOT use `import`/`export`** — the project is pure CommonJS `require`/`module.exports`
- **Do NOT add `"use strict"`** — modules don't use strict mode
- **Variables in `index.js` are module-level globals** — they persist between `setInterval` calls (intentional pattern for state caching)
- **Don't create subdirectories** inside a feature module — keep it to the 3 flat files
