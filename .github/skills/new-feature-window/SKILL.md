---
name: new-feature-window
description: "Scaffold a new UF1 feature window from scratch. Use when: adding a new overlay, creating a timing/data display module, building a new visualization window, or extending UF1 with any new BrowserWindow feature. Handles the complete setup: boilerplate files, main process registration, launcher button, and config defaults."
argument-hint: "[feature-name] [description of what it should show]"
---

# New Feature Window

Creates a complete UF1 feature window module following project conventions. See [feature-window instructions](../../instructions/feature-window.instructions.md) for the detailed conventions this skill follows.

## When to Use

- "Add a new window that shows X"
- "Create a status overlay for Y"
- "Build a module for displaying Z data from F1MV"
- "Scaffold a new timing/data feature"

## Step-by-Step Procedure

### 1. Gather requirements

Ask the user:
- **Feature name** (lowercase, no spaces, e.g. `drivervitals`)
- **Window title** (display name, e.g. "Driver Vitals")
- **What data it shows** (which F1MV API fields it needs)
- **Overlay or solid background?** (most are transparent overlays)
- **Does it need move mode?** (Escape-key drag toggle — most do)
- **Any configurable settings?** (user-facing toggles/options)

### 2. Create the module files

Create three files from the [templates](./assets/):

| File | Template |
|------|----------|
| `src/<featurename>/index.html` | [assets/index.html](./assets/index.html) |
| `src/<featurename>/index.js` | [assets/index.js](./assets/index.js) |
| `src/<featurename>/style.css` | [assets/style.css](./assets/style.css) |

In the templates, replace `{{FEATURE_NAME}}` with the kebab-case or flat name, and `{{WINDOW_TITLE}}` with the display title.

### 3. Register in main process

In `src/index.js`, add the window definition to `internal_settings.windows` inside the `defaults` object:

```javascript
featurename: {
    path: "featurename/index.html",
    width: 400,
    height: 300,
    frame: false,
    hideMenuBar: true,
    transparent: true,      // false for solid backgrounds
    hasShadow: false,
    alwaysOnTop: null,      // null inherits from config.general.always_on_top
    aspectRatio: null,
    icon: "icons/windows/featurename.png",
},
```

### 4. Add launcher button in main window

In `src/main/index.js`, add a launcher function following the standard pattern:

```javascript
async function featureName() {
    const internalSettings = (await ipcRenderer.invoke("get_store")).internal_settings;
    await ipcRenderer.invoke("window", ...Object.values(internalSettings.windows.featurename));
}
```

In `src/main/index.html`, add the corresponding button in the windows section (follow existing button patterns).

### 5. Add config defaults (if applicable)

If the feature has settings, add them in `src/index.js` under the `config` defaults:

```javascript
featurename: { setting_name: "default_value" }
```

The main window settings UI auto-generates form fields from `config.featurename.*` keys — HTML input IDs matching key names will bind automatically.

### 6. Wire up the window icon

Place a window icon at `src/icons/windows/featurename.png`. If none provided, use the UF1 logo as fallback.

## Quality Checklist

After scaffolding, verify:

- [ ] Module has exactly 3 files: `index.html`, `index.js`, `style.css`
- [ ] `index.js` starts with `const debug = false`
- [ ] Uses `require("npm_f1mv_api")` and `require("electron")` — never `import`
- [ ] Config access uses double nesting: `config.config.featurename`
- [ ] Render loop uses `setInterval` at 80ms (`const loopspeed = 80`)
- [ ] Window registered in `src/index.js` defaults
- [ ] Launcher function and button added to main window
- [ ] CSS imports fonts (`../fonts/fonts.css`) and shared styles as needed
