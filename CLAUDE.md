# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Tektite** is a local-first Markdown knowledge base desktop application built with Electron. It reads directly from local folders with no database, no cloud sync, and no telemetry. Vaults are plain directories on disk; Git works for sync if desired.

## Commands

```bash
# Install dependencies (also runs postinstall: copies xterm libs to vendor/)
npm install

# Development run (fast, no packaging, shows as "Electron" on macOS)
npm run dev

# Launch packaged app (macOS: Tektite.app; Linux: direct Electron)
npm start

# Syntax check (no test suite exists)
node --check src/main.js
node --check src/preload.js
node --check src/renderer/renderer.js
node --check scripts/start.js

# Package for distribution
npm run package:mac    # arm64 + x64 macOS bundles
npm run package:linux  # Linux bundle
```

There is no linting configuration (no ESLint/Prettier). There is no test suite — `node --check` is the only automated validation.

## Architecture

Classic Electron three-layer architecture:

### Main Process (`src/main.js`, ~1864 lines)
All OS-level operations live here:
- Vault scanning and file I/O (read/write notes, manage assets)
- Git integration (pull, add, commit, push via system `git` binary)
- Terminal management via `node-pty` (pseudo-terminal, not just shell output)
- Window lifecycle, state persistence, session restoration
- IPC handler registration (all `ipcMain.handle(...)` calls)
- Recent vaults list and app menus

### Preload Script (`src/preload.js`, ~78 lines)
Context isolation bridge. Exposes a typed `window.api` object to the renderer using `ipcRenderer.invoke()`. Every renderer→main call is routed through here. Adding a new IPC channel requires updating both this file and `main.js`.

### Renderer Process (`src/renderer/renderer.js`, ~158 KB)
All UI logic in a single large file:
- State management for notes, tags, graph, editor, and preview panes
- File tree rendering, search, and tag filtering
- Markdown parsing and live preview
- Link resolution (standard Markdown links and `[[wikilinks]]`)
- Tag extraction and graph visualization
- Git sync UI and terminal pane UI

### Supporting Files
- `src/renderer/index.html` — Main window HTML shell (19 KB; includes pane structure)
- `src/renderer/styles.css` — All styling (29 KB)
- `src/about.html` / `src/splash.html` — Secondary windows
- `scripts/copy-vendor.js` — Postinstall: copies xterm CSS/JS into `src/vendor/`
- `scripts/start.js` — Entry point for `npm start`
- `.tektite/settings.json` — Default vault settings schema

## Key Patterns

**IPC Flow:** Renderer calls `window.api.<method>()` → preload forwards via `ipcRenderer.invoke('<channel>', ...)` → main process handler returns result. To add a feature touching the filesystem or OS, register a handler in `main.js` and expose it in `preload.js`.

**No database:** The vault is just a directory. `main.js` scans it on open and caches the file tree in memory. File writes go directly to disk.

**Workspace state persistence:** Stored in the Electron user-data directory (not in the vault), so state survives app restarts but doesn't travel with the vault.

**Git operations:** Use the system `git` binary with a locked-down `PATH`. All git calls are in `main.js`.

**Terminal:** Uses `node-pty` to spawn a real shell. The `scripts/copy-vendor.js` postinstall step sets execute permissions on the `node-pty` spawn-helper binary for both arm64 and x64.
