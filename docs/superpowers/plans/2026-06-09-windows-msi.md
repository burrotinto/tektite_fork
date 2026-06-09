# Windows-MSI für Tektite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tektite als per-User-MSI für Windows (x64) ausliefern — mit funktionierendem Git-Sync und eingebettetem Terminal — über `electron-wix-msi` und einen `windows-latest`-CI-Job.

**Architecture:** Alle OS-Unterschiede (Git-Executable-Pfade, sicherer PATH, Git-Env, Default-Shell, ssh-Pfad) wandern in ein neues, unit-getestetes Modul `src/platform.js`; `main.js` ruft nur noch dessen Helfer auf und bleibt plattform-agnostisch. Die MSI entsteht aus dem `@electron/packager`-win32-Output, den ein neues Skript `scripts/build-msi.js` an `electron-wix-msi` weiterreicht. Ein neuer Workflow `.github/workflows/windows-build.yml` spiegelt `macos-build.yml`.

**Tech Stack:** Electron, `@electron/packager`, `electron-wix-msi` (+ WiX-Toolset auf CI), `node-pty`, Node 22 Built-in Test-Runner (`node --test`), GitHub Actions.

**Branch:** `feature/windows-msi` (bereits angelegt).

**Wichtiges Invariant:** Auf macOS/Linux muss sich nach allen Änderungen *nichts* verhalten ändern. `platform.js` liefert dort byte-identische Werte zum heutigen Code.

---

### Task 1: Plattform-Modul `src/platform.js` mit Unit-Tests

**Files:**
- Create: `src/platform.js`
- Test: `test/platform.test.js`

- [ ] **Step 1: Failing test schreiben**

Create `test/platform.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const platform = require("../src/platform");

test("isWindows erkennt win32", () => {
  assert.equal(platform.isWindows("win32"), true);
  assert.equal(platform.isWindows("darwin"), false);
  assert.equal(platform.isWindows("linux"), false);
});

test("gitExecutableCandidates: Unix-Pfade auf Nicht-Windows", () => {
  assert.deepEqual(platform.gitExecutableCandidates("linux"), [
    "/usr/bin/git",
    "/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git"
  ]);
});

test("gitExecutableCandidates: Windows-Pfade auf win32", () => {
  const candidates = platform.gitExecutableCandidates("win32");
  assert.ok(candidates.includes("C:\\Program Files\\Git\\cmd\\git.exe"));
  assert.ok(candidates.includes("C:\\Program Files\\Git\\bin\\git.exe"));
});

test("gitSafePath: Unix-String auf Nicht-Windows", () => {
  assert.equal(
    platform.gitSafePath("darwin"),
    "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
  );
});

test("gitSafePath: semikolon-getrennter Windows-PATH", () => {
  const p = platform.gitSafePath("win32", { SystemRoot: "C:\\Windows" });
  assert.ok(p.includes(";"));
  assert.ok(p.includes("C:\\Windows\\System32"));
  assert.ok(p.includes("C:\\Program Files\\Git\\cmd"));
});

test("gitEnvironment: HOME-basiert auf Unix", () => {
  const env = platform.gitEnvironment("linux", { HOME: "/home/x", SHELL: "/bin/zsh" });
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.PATH, "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
});

test("gitEnvironment: USERPROFILE-basiert auf Windows, ohne HOME", () => {
  const env = platform.gitEnvironment("win32", {
    USERPROFILE: "C:\\Users\\x",
    SystemRoot: "C:\\Windows"
  });
  assert.equal(env.USERPROFILE, "C:\\Users\\x");
  assert.equal(env.HOME, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("defaultShell: SHELL oder /bin/sh auf Unix", () => {
  assert.equal(platform.defaultShell("linux", { SHELL: "/bin/zsh" }), "/bin/zsh");
  assert.equal(platform.defaultShell("linux", {}), "/bin/sh");
});

test("defaultShell: powershell auf Windows", () => {
  assert.equal(platform.defaultShell("win32", {}), "powershell.exe");
});

test("fallbackShell: ComSpec auf Windows, /bin/sh auf Unix", () => {
  assert.equal(platform.fallbackShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(platform.fallbackShell("linux", {}), "/bin/sh");
});

test("sshExecutable: ssh auf Unix, OpenSSH-Pfad auf Windows", () => {
  assert.equal(platform.sshExecutable("linux"), "ssh");
  assert.ok(platform.sshExecutable("win32", { SystemRoot: "C:\\Windows" }).endsWith("ssh.exe"));
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag verifizieren**

Run: `node --test test/platform.test.js`
Expected: FAIL — `Cannot find module '../src/platform'`.

- [ ] **Step 3: `src/platform.js` implementieren**

Create `src/platform.js`:

```js
const path = require("node:path");

const UNIX_GIT_CANDIDATES = [
  "/usr/bin/git",
  "/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git"
];

const UNIX_SAFE_PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin";

const WINDOWS_GIT_CANDIDATES = [
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
  "C:\\Program Files (x86)\\Git\\cmd\\git.exe"
];

/**
 * Returns true when running on (or asked about) Windows.
 *
 * @param {string} [platform=process.platform] Platform identifier to test.
 * @returns {boolean} True for the win32 platform.
 */
function isWindows(platform = process.platform) {
  return platform === "win32";
}

/**
 * Returns the ordered list of trusted absolute paths at which a git executable
 * may be found for the given platform.
 *
 * @param {string} [platform=process.platform] Platform identifier.
 * @returns {string[]} Candidate git executable paths.
 */
function gitExecutableCandidates(platform = process.platform) {
  return isWindows(platform) ? [...WINDOWS_GIT_CANDIDATES] : [...UNIX_GIT_CANDIDATES];
}

/**
 * Returns a minimal, trusted PATH used when invoking git and ssh, so that the
 * resolved binaries cannot be shadowed by vault-controlled directories.
 *
 * @param {string} [platform=process.platform] Platform identifier.
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment to read SystemRoot from.
 * @returns {string} A platform-appropriate PATH string.
 */
function gitSafePath(platform = process.platform, env = process.env) {
  if (!isWindows(platform)) return UNIX_SAFE_PATH;
  const systemRoot = env.SystemRoot || "C:\\Windows";
  return [
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files\\Git\\bin",
    path.join(systemRoot, "System32"),
    systemRoot,
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
  ].join(";");
}

/**
 * Builds the environment passed to git child processes. Unix keeps the existing
 * locale/HOME/SSH variables; Windows uses USERPROFILE/HOMEDRIVE/HOMEPATH.
 *
 * @param {string} [platform=process.platform] Platform identifier.
 * @param {NodeJS.ProcessEnv} [env=process.env] Source environment.
 * @returns {Record<string, string>} The git child-process environment.
 */
function gitEnvironment(platform = process.platform, env = process.env) {
  if (isWindows(platform)) {
    return {
      USERPROFILE: env.USERPROFILE || "",
      HOMEDRIVE: env.HOMEDRIVE || "",
      HOMEPATH: env.HOMEPATH || "",
      GIT_TERMINAL_PROMPT: "0",
      PATH: gitSafePath(platform, env)
    };
  }
  return {
    HOME: env.HOME || "",
    LANG: env.LANG || "en_US.UTF-8",
    LC_ALL: env.LC_ALL || "",
    SSH_AUTH_SOCK: env.SSH_AUTH_SOCK || "",
    GIT_TERMINAL_PROMPT: "0",
    PATH: gitSafePath(platform, env)
  };
}

/**
 * Returns the preferred interactive shell for the embedded terminal.
 *
 * @param {string} [platform=process.platform] Platform identifier.
 * @param {NodeJS.ProcessEnv} [env=process.env] Source environment.
 * @returns {string} Shell executable name or path.
 */
function defaultShell(platform = process.platform, env = process.env) {
  if (isWindows(platform)) return "powershell.exe";
  return env.SHELL || "/bin/sh";
}

/**
 * Returns the fallback shell used when {@link defaultShell} cannot be spawned.
 *
 * @param {string} [platform=process.platform] Platform identifier.
 * @param {NodeJS.ProcessEnv} [env=process.env] Source environment.
 * @returns {string} Fallback shell executable name or path.
 */
function fallbackShell(platform = process.platform, env = process.env) {
  if (isWindows(platform)) return env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  return "/bin/sh";
}

/**
 * Returns the ssh executable to use for the SSH auth pre-check.
 *
 * @param {string} [platform=process.platform] Platform identifier.
 * @param {NodeJS.ProcessEnv} [env=process.env] Source environment.
 * @returns {string} ssh executable name (Unix) or absolute path (Windows).
 */
function sshExecutable(platform = process.platform, env = process.env) {
  if (!isWindows(platform)) return "ssh";
  const systemRoot = env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "OpenSSH", "ssh.exe");
}

module.exports = {
  isWindows,
  gitExecutableCandidates,
  gitSafePath,
  gitEnvironment,
  defaultShell,
  fallbackShell,
  sshExecutable
};
```

- [ ] **Step 4: Tests laufen lassen, Erfolg verifizieren**

Run: `node --test test/platform.test.js`
Expected: PASS — alle Tests grün, `# fail 0`.

- [ ] **Step 5: Syntax-Check**

Run: `node --check src/platform.js`
Expected: kein Output, Exit-Code 0.

- [ ] **Step 6: Commit**

```bash
git add src/platform.js test/platform.test.js
git commit -m "Add platform module with cross-platform git/shell helpers"
```

---

### Task 2: `test`-Script in package.json

**Files:**
- Modify: `package.json` (scripts-Block)

- [ ] **Step 1: Script ergänzen**

In `package.json`, im `"scripts"`-Objekt nach der `"dev"`-Zeile einfügen:

```json
    "test": "node --test",
```

Das `"scripts"`-Objekt sieht danach so aus (Reihenfolge der übrigen Einträge unverändert lassen):

```json
  "scripts": {
    "postinstall": "node scripts/copy-vendor.js",
    "start": "node scripts/start.js",
    "dev": "electron .",
    "test": "node --test",
    "package:mac": "electron-packager . Tektite --platform=darwin --icon=assets/icons/tektite-icon.icns --overwrite --no-asar",
    "package:linux": "electron-packager . Tektite --platform=linux --icon=assets/icons/tektite-icon.png --overwrite"
  },
```

- [ ] **Step 2: Test-Runner verifizieren**

Run: `npm test`
Expected: PASS — `node --test` findet `test/platform.test.js`, alle Tests grün.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Add npm test script using Node built-in test runner"
```

---

### Task 3: `platform.js` in `src/main.js` verdrahten

**Files:**
- Modify: `src/main.js` (mehrere Stellen — exakte Before/After unten)

Reihenfolge der Edits genau einhalten. Nach allen Edits: `node --check` + `npm test`.

- [ ] **Step 1: Modul importieren**

In `src/main.js` direkt nach der Zeile `const path = require("node:path");` (Zeile 5) einfügen:

Before:
```js
const path = require("node:path");
let pty; try { pty = require("node-pty"); } catch {}
```

After:
```js
const path = require("node:path");
const platform = require("./platform");
let pty; try { pty = require("node-pty"); } catch {}
```

- [ ] **Step 2: Hartkodierte Unix-Konstanten entfernen**

In `src/main.js` (aktuell Zeilen 22-28) den Block entfernen.

Before:
```js
const gitExecutableCandidates = [
  "/usr/bin/git",
  "/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git"
];
const gitSafePath = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin";
const splashMinimumMs = 3000;
```

After:
```js
const splashMinimumMs = 3000;
```

- [ ] **Step 3: `resolveGitExecutable` plattform-bewusst machen + Windows-PATH-Fallback**

In `src/main.js` die Funktion `resolveGitExecutable` ersetzen.

Before:
```js
async function resolveGitExecutable() {
  for (const candidate of gitExecutableCandidates) {
    if (await isSafeExecutable(candidate)) return candidate;
  }
  throw new Error("Git executable was not found in a trusted system location.");
}
```

After:
```js
async function resolveGitExecutable() {
  for (const candidate of platform.gitExecutableCandidates()) {
    if (await isSafeExecutable(candidate)) return candidate;
  }
  if (platform.isWindows()) {
    const fromPath = await gitFromWhere();
    if (fromPath && (await isSafeExecutable(fromPath))) return fromPath;
  }
  throw new Error("Git executable was not found in a trusted system location.");
}

function gitFromWhere() {
  return new Promise((resolve) => {
    const { execFile } = require("node:child_process");
    execFile("where", ["git"], (error, stdout) => {
      if (error) return resolve(null);
      const first = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0];
      resolve(first || null);
    });
  });
}
```

- [ ] **Step 4: `isSafeExecutable` für Windows anpassen**

In `src/main.js` die Funktion `isSafeExecutable` ersetzen.

Before:
```js
async function isSafeExecutable(candidate) {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    await fs.access(candidate, fs.constants.X_OK);

    const parent = await fs.stat(path.dirname(candidate));
    return (parent.mode & 0o002) === 0;
  } catch {
    return false;
  }
}
```

After:
```js
async function isSafeExecutable(candidate) {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;

    if (platform.isWindows()) {
      // On Windows the POSIX execute bit and the world-writable parent check do
      // not apply; candidates are already restricted to trusted locations.
      return true;
    }

    await fs.access(candidate, fs.constants.X_OK);
    const parent = await fs.stat(path.dirname(candidate));
    return (parent.mode & 0o002) === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: `gitEnvironment` delegieren**

In `src/main.js` die Funktion `gitEnvironment` ersetzen.

Before:
```js
function gitEnvironment() {
  return {
    HOME: process.env.HOME || "",
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "",
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || "",
    GIT_TERMINAL_PROMPT: "0",
    PATH: gitSafePath
  };
}
```

After:
```js
function gitEnvironment() {
  return platform.gitEnvironment();
}
```

- [ ] **Step 6: `checkSshAuth` — ssh-Pfad und PATH plattform-bewusst, Skip wenn ssh fehlt**

In `src/main.js`, innerhalb `checkSshAuth`, den ssh-`execFile`-Block ersetzen.

Before:
```js
  const { execFile } = require("node:child_process");
  await new Promise((resolve) => {
    execFile(
      "ssh",
      ["-T", `git@${host}`, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"],
      { env: { PATH: gitSafePath, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || "" } },
      (error, _stdout, stderr) => {
```

After:
```js
  const sshBin = platform.sshExecutable();
  if (platform.isWindows() && !fsSync.existsSync(sshBin)) return;

  const { execFile } = require("node:child_process");
  await new Promise((resolve) => {
    execFile(
      sshBin,
      ["-T", `git@${host}`, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"],
      { env: { PATH: platform.gitSafePath(), SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || "" } },
      (error, _stdout, stderr) => {
```

- [ ] **Step 7: `terminal:create` — Default-Shell + Fallback**

In `src/main.js` den Anfang des `terminal:create`-Handlers ersetzen.

Before:
```js
ipcMain.handle("terminal:create", (event, cwd, cols, rows) => {
  if (!pty) return null;
  const shell = process.env.SHELL || "/bin/sh";
  const safeCwd = cwd && fsSync.existsSync(cwd) ? cwd : app.getPath("home");
  const ptyProc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: safeCwd,
    env: { ...process.env, TERM: "xterm-256color" }
  });
```

After:
```js
ipcMain.handle("terminal:create", (event, cwd, cols, rows) => {
  if (!pty) return null;
  const safeCwd = cwd && fsSync.existsSync(cwd) ? cwd : app.getPath("home");
  const spawnOptions = {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: safeCwd,
    env: { ...process.env, TERM: "xterm-256color" }
  };
  let ptyProc;
  try {
    ptyProc = pty.spawn(platform.defaultShell(), [], spawnOptions);
  } catch {
    ptyProc = pty.spawn(platform.fallbackShell(), [], spawnOptions);
  }
```

- [ ] **Step 8: Syntax-Check + Tests**

Run:
```bash
node --check src/main.js
npm test
```
Expected: `node --check` ohne Output (Exit 0); `npm test` weiterhin alle Tests grün.

- [ ] **Step 9: Linux-Regression prüfen (App startet)**

Run: `npm run dev`
Expected: Tektite-Fenster öffnet sich auf Linux wie bisher; kein Fehler in der Konsole bzgl. `platform`/`git`/`terminal`. Fenster schließen.

- [ ] **Step 10: Commit**

```bash
git add src/main.js
git commit -m "Route git and terminal platform specifics through platform module"
```

---

### Task 4: Windows-Icon `tektite-icon.ico` erzeugen

**Files:**
- Create: `assets/icons/tektite-icon.ico`

> Hinweis: Eine `.ico` ist binär und kann nicht als Code-Block geschrieben werden — sie wird aus dem vorhandenen PNG generiert. Ausführung lokal in WSL.

- [ ] **Step 1: ImageMagick sicherstellen**

Run: `convert --version || sudo apt-get update && sudo apt-get install -y imagemagick`
Expected: Versions-Ausgabe von ImageMagick.

- [ ] **Step 2: `.ico` aus dem PNG generieren**

Run:
```bash
convert assets/icons/tektite-icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icons/tektite-icon.ico
```
Expected: kein Fehler; Datei `assets/icons/tektite-icon.ico` entsteht.

- [ ] **Step 3: Ergebnis verifizieren**

Run: `file assets/icons/tektite-icon.ico`
Expected: Ausgabe enthält `MS Windows icon resource` und mehrere Größen/Icons.

- [ ] **Step 4: Commit**

```bash
git add assets/icons/tektite-icon.ico
git commit -m "Add Windows .ico app icon"
```

---

### Task 5: MSI-Build-Skript + electron-wix-msi + Windows-Packaging-Scripts

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Create: `scripts/build-msi.js`

- [ ] **Step 1: electron-wix-msi als devDependency installieren**

Run: `npm install --save-dev electron-wix-msi@^5.1.3`
Expected: `package.json` (devDependencies) und `package-lock.json` aktualisiert; Installation ohne nativen Build-Fehler auf Linux.

- [ ] **Step 2: Windows-Packaging-Scripts ergänzen**

In `package.json`, im `"scripts"`-Objekt nach der `"package:linux"`-Zeile einfügen (Komma bei `package:linux` ergänzen):

```json
    "package:linux": "electron-packager . Tektite --platform=linux --icon=assets/icons/tektite-icon.png --overwrite",
    "package:win": "electron-packager . Tektite --platform=win32 --arch=x64 --icon=assets/icons/tektite-icon.ico --overwrite --no-asar",
    "package:win:msi": "npm run package:win && node scripts/build-msi.js"
```

- [ ] **Step 3: `scripts/build-msi.js` erstellen**

Create `scripts/build-msi.js`:

```js
const fs = require("node:fs");
const path = require("node:path");
const { MSICreator } = require("electron-wix-msi");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));

// Fester Upgrade-Code, damit künftige Versionen die installierte App in place
// aktualisieren statt parallel zu installieren. NICHT ändern.
const UPGRADE_CODE = "3f1a7c2e-9b4d-4e6a-8c1f-2d5b7e9a0c11";

async function main() {
  const appDirectory = path.join(root, "Tektite-win32-x64");
  if (!fs.existsSync(appDirectory)) {
    throw new Error(`Packaged app not found at ${appDirectory}. Run "npm run package:win" first.`);
  }

  const outputDirectory = path.join(root, "dist");
  fs.mkdirSync(outputDirectory, { recursive: true });

  const iconPath = path.join(root, "assets", "icons", "tektite-icon.ico");

  const creator = new MSICreator({
    appDirectory,
    outputDirectory,
    exe: "Tektite",
    name: "Tektite",
    manufacturer: "Mathias Conradt",
    description: pkg.description,
    version: pkg.version,
    appIconPath: iconPath,
    upgradeCode: UPGRADE_CODE,
    arch: "x64",
    ui: { chooseDirectory: true }
  });

  await creator.create();
  const { msiFile } = await creator.compile();

  const versioned = path.join(outputDirectory, `Tektite-${pkg.version}-x64.msi`);
  fs.renameSync(msiFile, versioned);
  console.log(`Created ${versioned}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 4: Syntax-Check**

Run: `node --check scripts/build-msi.js`
Expected: kein Output, Exit-Code 0.

> Hinweis: `npm run package:win:msi` lässt sich nur auf Windows mit installiertem WiX-Toolset vollständig ausführen (node-pty-Windows-Build + candle/light). Auf Linux endet die Verifikation beim Syntax-Check; der echte MSI-Build erfolgt in Task 6 via CI bzw. manuell auf dem Windows-Host.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/build-msi.js
git commit -m "Add electron-wix-msi build script and Windows packaging scripts"
```

---

### Task 6: CI-Workflow `windows-build.yml`

**Files:**
- Create: `.github/workflows/windows-build.yml`

- [ ] **Step 1: Workflow erstellen**

Create `.github/workflows/windows-build.yml`:

```yaml
name: Windows Build

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    name: Build Tektite for Windows
    runs-on: windows-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Fix private registry URLs in lockfile
        shell: bash
        run: sed -i 's|https://repox.jfrog.io/artifactory/api/npm/npm/|https://registry.npmjs.org/|g' package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Syntax check
        shell: bash
        run: |
          node --check src/main.js
          node --check src/preload.js
          node --check src/renderer/renderer.js
          node --check src/platform.js
          node --check scripts/start.js
          node --check scripts/build-msi.js

      - name: Unit tests
        run: npm test

      - name: Install WiX Toolset
        shell: pwsh
        run: choco install wixtoolset --no-progress -y

      - name: Build MSI
        run: npm run package:win:msi

      - name: Upload MSI artifact
        uses: actions/upload-artifact@v4
        with:
          name: Tektite-Windows
          path: dist/*.msi

      - name: Create tag and release on main push
        if: github.ref == 'refs/heads/main' && github.event_name == 'push' && github.actor != 'github-actions[bot]'
        shell: bash
        run: |
          version="$(node -p "require('./package.json').version")"
          tag="v${version}"
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          if git rev-parse "${tag}" >/dev/null 2>&1; then
            echo "Tag ${tag} already exists, skipping tag creation"
          else
            git tag "${tag}"
            git push origin "${tag}"
          fi
          echo "RELEASE_TAG=${tag}" >> "$GITHUB_ENV"

      - name: Publish GitHub release asset (main push)
        if: github.ref == 'refs/heads/main' && github.event_name == 'push' && github.actor != 'github-actions[bot]'
        uses: softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65
        with:
          tag_name: ${{ env.RELEASE_TAG }}
          name: Tektite ${{ env.RELEASE_TAG }}
          files: dist/*.msi

      - name: Publish GitHub release asset (tag push)
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65
        with:
          files: dist/*.msi
```

- [ ] **Step 2: YAML-Gültigkeit prüfen**

Run: `node -e "const fs=require('node:fs');const f='.github/workflows/windows-build.yml';fs.readFileSync(f,'utf8');console.log('readable:',f)"`
Expected: `readable: .github/workflows/windows-build.yml` (Datei lesbar; eigentliche YAML-Validierung erfolgt durch GitHub Actions beim Push).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/windows-build.yml
git commit -m "Add Windows MSI build workflow"
```

---

### Task 7: Dokumentation aktualisieren

**Files:**
- Modify: `README.md` (Packaging-Abschnitt)
- Modify: `CLAUDE.md` (Commands + Architektur)

- [ ] **Step 1: README — Windows-Packaging ergänzen**

In `README.md`, im Abschnitt `## Packaging`, den Code-Block ersetzen.

Before:
```sh
npm run package:mac
npm run package:linux
```

After:
```sh
npm run package:mac
npm run package:linux
npm run package:win:msi
```

Und direkt nach dem Code-Block diesen Absatz einfügen:

```markdown
`npm run package:win:msi` builds the Windows `.msi` installer via `electron-wix-msi`. It must run on Windows with the WiX Toolset installed and produces `dist/Tektite-<version>-x64.msi`.
```

- [ ] **Step 2: CLAUDE.md — Test-Command und Windows-Build ergänzen**

In `CLAUDE.md`, im `## Commands`-Abschnitt den `npm run package:linux`-Eintrag um die Windows-Variante und einen Test-Hinweis erweitern.

Before:
```sh
npm run package:mac
npm run package:linux
```

After:
```sh
npm run package:mac
npm run package:linux
npm run package:win:msi  # Windows MSI via electron-wix-msi; requires Windows + WiX Toolset
```

- [ ] **Step 3: CLAUDE.md — Test-Hinweis korrigieren**

In `CLAUDE.md` den Satz zum fehlenden Test-Setup anpassen.

Before:
```markdown
There is **no test suite and no linter**. The only automated check in CI is a syntax check:
```

After:
```markdown
There is **no linter**. Tests are minimal: `npm test` runs Node's built-in test runner (`node --test`) over `test/`, currently covering `src/platform.js` (pure cross-platform logic). The primary CI gate is still a syntax check:
```

- [ ] **Step 4: CLAUDE.md — platform.js in der Architektur erwähnen**

In `CLAUDE.md`, im Abschnitt zur Architektur, nach dem `src/renderer/renderer.js`-Bulletpoint einfügen:

```markdown
- **`src/platform.js`** — small module isolating all OS-specific values (git executable candidates, safe PATH, git env, default/fallback terminal shell, ssh path). `main.js` calls these helpers so its git-sync and terminal logic stay platform-agnostic. On macOS/Linux the returned values are identical to the previous hardcoded ones. This is the only unit-tested module.
```

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document Windows MSI build and platform module"
```

---

## Verifikation nach Abschluss (manuell, auf Windows-Host)

Nach Merge/CI-Lauf:

1. MSI-Artefakt `Tektite-<version>-x64.msi` aus dem CI-Run (oder Release) laden und installieren — Installation ohne Admin-Rechte, Start-Menü-Eintrag erscheint.
2. Tektite starten; Vault öffnen; Notiz erstellen/editieren/speichern; Preview, Graph, Tags prüfen.
3. Terminal-Pane öffnen → PowerShell-Prompt erscheint, Eingaben funktionieren.
4. Git-Sync auf einem git-backed Vault (HTTPS-Remote) ausführen → `git pull/add/commit/push`-Ausgabe erscheint, kein „Git not found".
5. Re-Install einer höheren Version → ersetzt die alte in place (Upgrade-Code greift).

## Spec-Abdeckung (Self-Review)

- Packaging-Pipeline (Spec §1) → Task 5
- Icon (§2) → Task 4
- platform.js (§3) → Task 1, verdrahtet in Task 3
- Git-Sync Windows (§4) → Task 3 (Steps 3–6)
- Terminal Windows (§5) → Task 3 (Step 7)
- CI windows-build.yml (§6) → Task 6
- Installationsverhalten (§7) → Task 5 (build-msi.js: upgradeCode, ui, per-user default)
- Tests/Verifikation (§8) → Task 1/2 (Unit), Task 6 (CI-Gate), Verifikations-Abschnitt oben (manuell)
- version-bump.yml unverändert (Spec §6) → bewusst keine Task nötig (`src/*`-Regel deckt `platform.js` ab)
```
