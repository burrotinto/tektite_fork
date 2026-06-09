# Windows-MSI für Tektite — Design

Datum: 2026-06-09
Status: Approved (Brainstorming abgeschlossen, bereit für Implementierungsplan)

## Ziel

Tektite (Electron-Markdown-Wissensdatenbank) soll als ausführbare **MSI-Installationsdatei** unter Windows laufen — mit **vollem Funktionsumfang**, d. h. inklusive funktionierendem Git-Sync und eingebettetem Terminal. Heute unterstützt das Projekt nur macOS und Linux; mehrere Stellen treffen Unix-Annahmen, die unter Windows zur Laufzeit brechen.

## Entscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| Funktionsumfang | Voll — App, Editor, Graph, Tags **und** Git-Sync **und** Terminal |
| MSI-Tooling | `electron-wix-msi` (wickelt den `@electron/packager`-Output in eine MSI) |
| Build-Ort | GitHub Actions, `windows-latest`-Runner (analog zu `macos-build.yml`) |
| Struktur der Code-Fixes | Neues Modul `src/platform.js` bündelt alle OS-Unterschiede |
| Default-Terminal-Shell (Windows) | PowerShell, Fallback `ComSpec` (cmd.exe) |
| Architektur | x64 (arm64 vorerst out of scope) |
| Code-Signing | Out of scope — unsignierte MSI (konsistent mit unsignierter macOS-Distribution) |
| Windows-Paketmanager (winget/choco) | Out of scope (YAGNI) — Distribution via GitHub-Release |

## Hintergrund: Windows-Blocker im Ist-Zustand

Reine Verpackung:
- `@electron/packager` erzeugt nur einen App-Ordner, **keinen Installer**.
- MSI-Bau erfordert WiX-Toolset und läuft praktisch nur auf Windows.
- Es existiert kein `.ico` (nur `.icns` + `.png`).
- `node-pty` (Terminal) ist ein nativer Modul ohne Windows-Prebuild → muss auf Windows kompiliert werden (Cross-Build aus WSL/Linux funktioniert nicht).

Laufzeit-Annahmen (Unix-spezifisch) in `src/main.js`:
- `gitExecutableCandidates` = fest verdrahtete Unix-Pfade (`/usr/bin/git` …) → `resolveGitExecutable` wirft auf Windows „Git not found".
- `gitSafePath` = Unix-PATH; `gitEnvironment()` nutzt `HOME`, `LANG`, `LC_ALL`.
- `isSafeExecutable()` prüft world-writable-Bit des Elternverzeichnisses (Unix mode bits) — unter Windows bedeutungslos.
- `checkSshAuth()` ruft `ssh` mit Unix-PATH auf.
- `terminal:create` nutzt `process.env.SHELL || "/bin/sh"` — Windows hat kein `SHELL`.

## Architektur der Änderungen

### 1. Packaging-Pipeline

- Neues Skript `scripts/build-msi.js`.
- Neue npm-Scripts:
  - `package:win` → `electron-packager . Tektite --platform=win32 --arch=x64 --icon=assets/icons/tektite-icon.ico --overwrite` (erzeugt `Tektite-win32-x64/`).
  - `package:win:msi` → führt `build-msi.js` aus.
- `build-msi.js` reicht den packager-Output-Ordner an `electron-wix-msi` (`MSICreator`) weiter und erzeugt `Tektite-<version>-x64.msi`.
- MSI-Konfiguration:
  - `appDirectory`: packager-Output, `outputDirectory`: z. B. `dist/`.
  - `name`: "Tektite", `exe`: "Tektite", `manufacturer`: "Mathias Conradt".
  - `version`: aus `package.json`.
  - `icon`: `assets/icons/tektite-icon.ico`.
  - Fester `upgradeCode` (GUID), damit künftige Versionen *in place* aktualisieren.
  - `ui: { chooseDirectory: true }`, Per-User-Install (kein Admin/UAC).
  - Shortcuts: Start-Menü-Verknüpfung (Default). Desktop-Verknüpfung: Default nein.

### 2. Icon

- `assets/icons/tektite-icon.ico` (multi-resolution: 16/32/48/256 px) aus dem vorhandenen `assets/icons/tektite.iconset`/PNG generieren und committen.
- Verwendung: packager (Fenster-/Exe-Icon) und MSI (Installer + Verknüpfung).

### 3. Plattform-Modul `src/platform.js`

Bündelt alle OS-spezifischen Werte/Logik an einer Stelle; `main.js` ruft nur diese Helfer auf. **Auf macOS/Linux müssen die Rückgaben byte-identisch zum heutigen Verhalten sein (regressionssicher).**

Exporte:
- `gitExecutableCandidates()` — Unix: heutige Liste; Windows: Ergebnis von `where git` + bekannte Pfade (`C:\Program Files\Git\cmd\git.exe`, `C:\Program Files\Git\bin\git.exe`).
- `gitSafePath()` — Unix: `"/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"`; Windows: sinnvoller PATH inkl. Git, `System32`, WindowsPowerShell.
- `gitEnvironment()` — Unix: heutiges Env (`HOME`, `LANG`, `LC_ALL`, `SSH_AUTH_SOCK`, `GIT_TERMINAL_PROMPT=0`, `PATH`); Windows: `USERPROFILE`/`HOMEDRIVE`+`HOMEPATH`, `GIT_TERMINAL_PROMPT=0`, `PATH`.
- `isSafeExecutable(candidate)` — Unix: heutiger mode-bit-Check; Windows: Existenz + Lage in vertrauenswürdigem `Program Files`/`System32`.
- `defaultShell()` — Unix: `process.env.SHELL || "/bin/sh"`; Windows: `powershell.exe`, Fallback `process.env.ComSpec`.
- `sshExecutable()` — best-effort; Unix: `"ssh"`; Windows: OpenSSH-Pfad (`C:\Windows\System32\OpenSSH\ssh.exe`) oder `where ssh`, sonst `null`.

`main.js`-Refactor: Modul-Level-Konstanten `gitExecutableCandidates`/`gitSafePath` und die Internals von `isSafeExecutable`/`gitEnvironment`/`resolveGitExecutable`/`checkSshAuth`/`terminal:create` rufen die Plattform-Helfer auf.

### 4. Git-Sync unter Windows

- `resolveGitExecutable()` nutzt `platform.gitExecutableCandidates()` (inkl. PATH-Lookup).
- `runGit()` Env aus `platform.gitEnvironment()`.
- `checkSshAuth()`: `ssh` via `platform.sshExecutable()`; wenn `null`, Pre-Check **sauber überspringen** (Sync versucht es trotzdem). HTTPS-Remotes sind ohnehin per Early-Return unberührt.

### 5. Terminal unter Windows

- `terminal:create` nutzt `platform.defaultShell()`.
- `node-pty` verwendet auf Win10+ automatisch ConPTY.

### 6. CI: `.github/workflows/windows-build.yml`

Spiegelt `macos-build.yml`:
- Trigger: `push` auf `main` + Tags `v*`, `pull_request` auf `main`, `workflow_dispatch`.
- `runs-on: windows-latest`.
- Schritte:
  1. checkout (`fetch-depth: 0`)
  2. setup-node 22
  3. Registry-URL-Fix (gleicher `sed`, aber `shell: bash`)
  4. `npm ci`
  5. Syntax-Check: `node --check` auf `src/main.js`, `src/preload.js`, `src/renderer/renderer.js`, `src/platform.js`, `scripts/start.js`, `scripts/build-msi.js`
  6. WiX-Toolset installieren (z. B. `choco install wixtoolset`)
  7. `npm run package:win:msi`
  8. MSI als Artefakt hochladen
  9. bei Tag-Push: `.msi` an das GitHub-Release anhängen (wie macOS-Workflow)
- `version-bump.yml`: **keine Änderung** — `src/platform.js` fällt unter die bestehende `src/*`-Regel.

### 7. Installationsverhalten (MSI)

- Per-User-Install (kein Admin/UAC).
- Start-Menü-Verknüpfung (Default); Desktop-Verknüpfung Default aus.
- Zielordner wählbar.
- Unsigniert → SmartScreen-Hinweis „unbekannter Herausgeber" (konsistent mit unsignierter macOS-Distribution).
- Fester `upgradeCode` → In-Place-Upgrades.

## Fehlerbehandlung

- `resolveGitExecutable()` wirft weiterhin eine klare Meldung, wenn auf keiner Plattform ein vertrauenswürdiges Git gefunden wird.
- `checkSshAuth()` degradiert auf Windows ohne `ssh` still (kein harter Fehler), damit HTTPS-Sync weiter funktioniert.
- `terminal:create` gibt wie heute `null` zurück, wenn `node-pty` nicht geladen werden konnte.
- `build-msi.js` bricht mit Exit-Code ≠ 0 ab, wenn packager oder MSICreator fehlschlagen → CI schlägt sichtbar fehl.

## Tests / Verifikation

- Kein Test-Framework im Projekt (siehe `CLAUDE.md`). Automatisches Gate = `node --check` (CI), erweitert um `platform.js` und `build-msi.js`.
- Manuelle Verifikation auf Windows-Host (Florian, via WSL2):
  1. MSI-Artefakt aus CI laden, installieren, App startet.
  2. Vault öffnen; Notiz erstellen/editieren/speichern; Preview, Graph, Tags prüfen.
  3. Terminal-Pane öffnen → PowerShell-Prompt erscheint, Eingabe funktioniert.
  4. Git-Sync auf einem git-backed Vault ausführen (HTTPS-Remote).
- Regression: `npm run dev` startet auf Linux unverändert; `platform.js` liefert auf macOS/Linux identische Werte.

## Risiken / offene Punkte

- **WiX-Toolset** auf `windows-latest` braucht ggf. expliziten Install-Step; Versionskompatibilität zu `electron-wix-msi` (WiX 3.x) beachten.
- **node-pty-Build** auf `windows-latest` benötigt VS Build Tools (im Runner-Image vorhanden) — wahrscheinlichster CI-Stolperstein.
- Unsignierte MSI → SmartScreen-Warnung.
- arm64-Windows nicht abgedeckt (vorerst bewusst out of scope).

## Out of Scope

- Code-Signing / Zertifikate.
- winget-/chocolatey-Manifest.
- arm64-Windows-Build.
- Auto-Update-Mechanismus.
