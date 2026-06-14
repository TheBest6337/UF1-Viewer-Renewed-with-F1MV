# Building UF1 Viewer — Renewed

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm (comes with Node.js)
- Git

Clone the repository and install dependencies:

```bash
git clone https://github.com/TheBest6337/UF1-Viewer-with-F1MV.git
cd UF1-Viewer-with-F1MV
npm install
```

> **Note:** On macOS and Linux you may need to prefix commands with `sudo` if you encounter permission errors during install or build (e.g. `sudo npm install`, `sudo npm run dist`).

---

## Run locally (development)

```bash
npm start
```

---

## Build distributable packages

```bash
npm run dist
```

Output lands in the `out/` directory. The target format is determined by the platform you build on (see below).

### macOS — Intel (x86_64)

```bash
npm run dist -- --mac --x64
```

Produces a `.dmg` installer: `out/UF1-Viewer-Renewed-<version>-mac-x64.dmg`

**Requirement:** Must be built on macOS.

### macOS — Apple Silicon (ARM64)

```bash
npm run dist -- --mac --arm64
```

Produces a `.dmg` installer: `out/UF1-Viewer-Renewed-<version>-mac-arm64.dmg`

**Requirement:** Must be built on macOS.

### Windows — 64-bit (x64)

```bash
npm run dist -- --win --x64
```

Produces an NSIS one-click installer in `out/`.

**Requirement:** Can be built on Windows or cross-compiled from macOS/Linux (requires Wine for code-signing, but unsigned builds work without it).

### Windows — 32-bit (ia32)

```bash
npm run dist -- --win --ia32
```

### Linux — x86_64 (AppImage)

```bash
npm run dist -- --linux --x64
```

Produces an `.AppImage` in `out/`.

**Requirement:** Must be built on Linux (or inside a Linux container/VM).

---

## Build without packaging (directory output)

To inspect the unpacked app without creating an installer:

```bash
npm run pack
```

Output goes to `out/<platform>-unpacked/`.

---

## Notes

- **Cross-platform builds:** electron-builder can cross-compile in some cases, but native builds are always more reliable. Build on the target OS when possible.
- **macOS code signing:** Unsigned DMGs will trigger a Gatekeeper warning on macOS. Right-click → Open to bypass it, or sign with an Apple Developer certificate by setting the `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables before building.
- **Windows code signing:** Unsigned NSIS installers may be flagged by SmartScreen. This is expected for self-built binaries without a code-signing certificate.
