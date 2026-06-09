# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tektite is a deliberately minimal, local-first Markdown knowledge base desktop app built on Electron (macOS + Linux). A "vault" is just a folder on disk — no login, cloud, telemetry, database, or plugin system. Sync is plain `git`.

## Commands

```sh
npm install            # also runs scripts/copy-vendor.js (postinstall) to stage xterm + node-pty
npm start              # macOS: packages a local Tektite.app first so Dock/menu read "Tektite"; Linux: plain electron .
npm run dev            # faster: electron . directly (on macOS the host process still shows as Electron)
npm test               # Node built-in test runner (node --test) over test/
npm run package:mac    # electron-packager, --no-asar
npm run package:linux
npm run package:win:msi  # Windows MSI via electron-wix-msi; requires Windows + WiX Toolset
```

There is **no linter**. Tests are minimal: `npm test` runs Node's built-in test runner (`node --test`) over `test/`, currently covering `src/platform.js` (pure cross-platform logic). The primary CI gate is still a syntax check:

```sh
node --check src/main.js
node --check src/preload.js
node --check src/renderer/renderer.js
node --check src/platform.js
node --check scripts/start.js
```

Run these after edits — they are the closest thing to a build gate. SonarCloud runs on PRs for quality gating.

## Architecture

Classic Electron three-layer split. There are only three real source files plus two build scripts; everything else is HTML/CSS/assets/vendored libs.

- **`src/main.js`** (~1860 lines) — main process. Owns all filesystem and git access, window/menu lifecycle, the native menu bar (`buildMenu`), session/workspace persistence, and the embedded terminal (node-pty). Every privileged operation is an `ipcMain.handle(...)` channel.
- **`src/preload.js`** — the entire IPC contract. Exposes a single `window.tektite` object via `contextBridge` (contextIsolation on, nodeIntegration off). To add a renderer↔main capability you must touch **all three**: add `ipcMain.handle` in `main.js`, expose it in `preload.js`, call `window.tektite.*` in `renderer.js`.
- **`src/renderer/renderer.js`** (~4350 lines) — the entire UI. A single global `state` object (top of the file) is the single source of truth; functions mutate it then call the relevant `render*`/`apply*` function. No framework, no reactivity — re-render is manual.
- **`src/platform.js`** — small module isolating all OS-specific values (git executable candidates, safe PATH, git env, default/fallback terminal shell, ssh path). `main.js` calls these helpers so its git-sync and terminal logic stay platform-agnostic. On macOS/Linux the returned values are identical to the previous hardcoded ones. This is the only unit-tested module.

### Things that are intentionally hand-rolled (no libraries)

- **Markdown rendering** is a custom line-based parser: `markdownToHtml` → `processMarkdownLine` → `flushMarkdown*` block flushers, with `inlineMarkdown` for spans. It also resolves `[[wikilinks]]` against the note index. Do not reach for a markdown library — extend the existing parser.
- **The graph** is a custom force-directed layout (`layoutGraphNodes`, `applyGraphRepulsion`, `applyGraphEdgeAttraction`, `applyGraphCollision`) rendered to SVG (`renderGraphSvg`). Edges come from `parseLinksFromNotes`/`extractTargets`.
- **Tags** are scraped from note bodies (`extractTags`/`collectVaultTags`) and drive file-tree filtering.

### Persistence model

- Per-vault, in-vault: `.tektite/settings.json` (templates path, autolink, TOC options) and `.tektite/templates/` — see `DEFAULT_TEMPLATES_PATH` in `main.js`.
- App-global, in Electron `userData`: `recent-vaults.json` and `workspace-state.json` (open tabs, last vault, sessions for window restore). See `recentVaultsPath()` / `workspaceStatePath()`.
- Editor autosaves on a debounce timer; the renderer also polls every `EXTERNAL_NOTE_POLL_MS` to detect on-disk changes made outside the app.

### Security boundary

All vault file paths from the renderer pass through `resolveVaultPath` → `assertInsideVault` in `main.js`, which rejects any path that escapes the vault root. Keep new filesystem IPC handlers behind this check — never resolve a renderer-supplied path without it.

### Git sync

`git:sync` is a fixed pipeline: `pull --ff-only` → `status --porcelain` → (if dirty) `add -A` + `commit` → `push`, streaming output to the renderer via `git:sync-output`. Git runs with a pinned safe PATH and an explicit executable search list (`gitExecutableCandidates`) so it works inside packaged apps; SSH auth is pre-checked (`checkSshAuth`).

## Release flow (don't bump versions by hand)

Pushing to `dev` triggers `.github/workflows/version-bump.yml`, which auto-bumps the patch version and updates `package.json`, `package-lock.json`, `Casks/tektite.rb`, and `src/about.html` **only when files under `src/`, `assets/`, `scripts/`, `Casks/`, or the manifest/lockfile/LICENSE changed**. The macOS build workflow then publishes tagged releases. So: edit code, let CI handle the version bump.
