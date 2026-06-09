const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const platform = require("./platform");
let pty; try { pty = require("node-pty"); } catch {}
const ptySessions = new Map();

let mainWindow;
let aboutWindow;
let splashWindow;
let splashShownAt = 0;
let recentVaults = [];
const windowPaneStates = new Map();
let isQuitting = false;
const windowVaults = new Map();
let cachedStore = { lastVault: null, workspaces: {}, sessions: [] };
const tektiteWindows = new Set();
const appIconPath = path.join(__dirname, "..", "assets", "app", "tektive-icon.webp");
const fallbackAppIconPath = path.join(__dirname, "..", "assets", "icons", "tektite-icon.png");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);
const splashMinimumMs = 3000;
const recentVaultLimit = 10;

app.name = "Tektite";
app.setName("Tektite");

function log() { /* verbose logging disabled */ }

function createWindow(options = {}) {
  const shouldShowImmediately = options.show !== false;
  const appIcon = loadAppIcon();
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: "Tektite",
    icon: appIcon,
    show: shouldShowImmediately,
    backgroundColor: "#f7f4ed",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = window;
  tektiteWindows.add(window);
  buildMenu();

  window.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: {
      restoreLastVault: (options.vaultPath || options.restoreLastVault === false) ? "0" : "1",
      ...(options.vaultPath ? { vault: options.vaultPath } : {})
    }
  });
  window.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      const elapsed = Date.now() - splashShownAt;
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        splashWindow = null;
        if (!window.isDestroyed()) {
          window.show();
          if (options.focusOnShow) window.focus();
        }
      }, Math.max(0, splashMinimumMs - elapsed));
    } else if (!shouldShowImmediately && !window.isDestroyed()) {
      window.show();
      if (options.focusOnShow) window.focus();
    }
  });

  window.on("focus", () => {
    mainWindow = window;
    buildMenu();
  });

  window.on("closed", () => {
    tektiteWindows.delete(window);
    if (mainWindow === window) mainWindow = [...tektiteWindows][0] || null;
    buildMenu();
    if (!isQuitting) {
      windowVaults.delete(window);
      saveOpenSessions();
    }
  });

  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }

  return window;
}

function createSplashWindow() {
  splashShownAt = Date.now();
  splashWindow = new BrowserWindow({
    width: 520,
    height: 520,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    title: "Tektite",
    icon: loadAppIcon(),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"), {
    query: { version: app.getVersion() }
  });
  splashWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function showAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }

  aboutWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "About Tektite",
    parent: activeTektiteWindow() || undefined,
    modal: false,
    icon: loadAppIcon(),
    backgroundColor: "#111318",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.loadFile(path.join(__dirname, "about.html"), {
    query: { version: app.getVersion() }
  });
  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });
}

function activeTektiteWindow() {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && tektiteWindows.has(focusedWindow)) return focusedWindow;
  return mainWindow || [...tektiteWindows][0] || null;
}

function sendToActiveWindow(channel, ...args) {
  activeTektiteWindow()?.webContents.send(channel, ...args);
}

function sendToWindowOrCreate(channel, ...args) {
  const window = activeTektiteWindow();
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, ...args);
    return;
  }

  const newWindow = createWindow({ restoreLastVault: false });
  newWindow.webContents.once("did-finish-load", () => {
    if (!newWindow.isDestroyed()) newWindow.webContents.send(channel, ...args);
  });
}

async function openRecentVaultFromMenu(vaultPath) {
  const validation = await validateVaultRoot(vaultPath);
  if (!validation.ok) return;
  sendToWindowOrCreate("menu:open-recent-vault", vaultPath);
}

function loadAppIcon() {
  const icon = nativeImage.createFromPath(appIconPath);
  if (!icon.isEmpty()) return icon;
  return nativeImage.createFromPath(fallbackAppIconPath);
}

async function loadRecentVaults() {
  try {
    const raw = await fs.readFile(recentVaultsPath(), "utf8");
    const parsed = JSON.parse(raw);
    recentVaults = Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === "string").slice(0, recentVaultLimit)
      : [];
  } catch {
    recentVaults = [];
  }
}

async function rememberRecentVault(rootPath) {
  const normalized = path.resolve(rootPath);
  recentVaults = [
    normalized,
    ...recentVaults.filter((vaultPath) => path.resolve(vaultPath) !== normalized)
  ].slice(0, recentVaultLimit);

  await fs.mkdir(path.dirname(recentVaultsPath()), { recursive: true });
  await fs.writeFile(recentVaultsPath(), JSON.stringify(recentVaults, null, 2), "utf8");
  buildMenu();
}

function recentVaultsPath() {
  return path.join(app.getPath("userData"), "recent-vaults.json");
}

async function validateVaultRoot(rootPath, sender) {
  let stat;
  try {
    stat = await fs.stat(rootPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return showVaultUnavailableDialog(sender, rootPath);
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    return showVaultUnavailableDialog(sender, rootPath);
  }

  return { ok: true };
}

async function showVaultUnavailableDialog(sender, rootPath) {
  const owner = sender ? BrowserWindow.fromWebContents(sender) : activeTektiteWindow();
  const message = "The vault folder doesn't exist anymore.";
  await dialog.showMessageBox(owner || undefined, {
    type: "warning",
    title: "Vault Folder Not Found",
    message,
    detail: `Tektite tried to open:\n${rootPath}`,
    buttons: ["OK"],
    defaultId: 0,
    noLink: true
  });

  return {
    ok: false,
    code: "VAULT_NOT_FOUND",
    message,
    path: rootPath
  };
}

function workspaceStatePath() {
  return path.join(app.getPath("userData"), "workspace-state.json");
}

async function loadWorkspaceStore() {
  try {
    const raw = await fs.readFile(workspaceStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    cachedStore = {
      lastVault: typeof parsed.lastVault === "string" ? parsed.lastVault : null,
      workspaces: parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {},
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch {
    cachedStore = { lastVault: null, workspaces: {}, sessions: [] };
  }
  return { ...cachedStore, workspaces: { ...cachedStore.workspaces } };
}

async function saveWorkspaceStore(store) {
  cachedStore = store;
  const p = workspaceStatePath();
  const tmp = `${p}.${process.hrtime.bigint()}.tmp`;
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, p);
}

async function saveOpenSessions() {
  if (isQuitting) return;
  const sessions = [...tektiteWindows]
    .filter((w) => !w.isDestroyed())
    .map((w) => windowVaults.get(w) || null);
  log("saveOpenSessions", sessions);
  const store = await loadWorkspaceStore();
  store.sessions = sessions;
  await saveWorkspaceStore(store);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const s = windowPaneStates.get(activeTektiteWindow());
  const recentVaultItems = recentVaults.length > 0
    ? recentVaults.map((vaultPath) => ({
        label: path.basename(vaultPath) || vaultPath,
        sublabel: vaultPath,
        click: () => openRecentVaultFromMenu(vaultPath)
      }))
    : [{ label: "No Recent Vaults", enabled: false }];
  const template = [
    ...(isMac
      ? [
          {
            label: "Tektite",
            submenu: [
              { label: "About Tektite", click: showAboutWindow },
              { type: "separator" },
              { label: "Settings…", accelerator: "Cmd+,", click: () => sendToActiveWindow("menu:open-settings") },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" }
            ]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => createWindow({ restoreLastVault: false })
        },
        { type: "separator" },
        {
          label: "Open Vault...",
          accelerator: "CmdOrCtrl+O",
          click: () => sendToWindowOrCreate("menu:open-vault")
        },
        {
          label: "Recent Vaults...",
          submenu: recentVaultItems
        },
        { type: "separator" },
        {
          label: "New Node",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => sendToActiveWindow("menu:new-note")
        },
        {
          label: "New Folder",
          accelerator: "CmdOrCtrl+Shift+F",
          click: () => sendToActiveWindow("menu:new-folder")
        },
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => sendToActiveWindow("menu:close-tab")
        },
        {
          label: "Close All Tabs",
          click: () => sendToActiveWindow("menu:close-all-tabs")
        },
        {
          label: "Close Window",
          accelerator: "Shift+CmdOrCtrl+W",
          click: () => activeTektiteWindow()?.close()
        },
        { type: "separator" },
        {
          label: "Print...",
          accelerator: "CmdOrCtrl+P",
          click: () => sendToActiveWindow("menu:print-preview")
        },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => sendToActiveWindow("menu:open-settings")
        },
        ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }])
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        {
          label: "Refresh Vault",
          accelerator: "CmdOrCtrl+R",
          click: () => sendToActiveWindow("menu:refresh-vault")
        },
        { type: "separator" },
        {
          label: "Toggle Dark/Light Mode",
          click: () => sendToActiveWindow("menu:toggle-theme")
        },
        { type: "separator" },
        {
          label: "Show File Suffixes",
          type: "checkbox",
          checked: s?.showFileExtensions === true,
          click: () => sendToActiveWindow("menu:toggle-file-suffixes")
        },
        {
          label: "Show Editor Pane",
          type: "checkbox",
          checked: s?.showEditorPane !== false,
          click: () => sendToActiveWindow("menu:toggle-editor-pane")
        },
        {
          label: "Show Preview Pane",
          type: "checkbox",
          checked: s?.showPreviewPane !== false,
          click: () => sendToActiveWindow("menu:toggle-preview-pane")
        },
        {
          label: "Show Tags Pane",
          type: "checkbox",
          checked: s?.showTagsPane !== false,
          click: () => sendToActiveWindow("menu:toggle-tags-pane")
        },
        {
          label: "Show Graph Pane",
          type: "checkbox",
          checked: s?.showGraphPane !== false,
          click: () => sendToActiveWindow("menu:toggle-graph-pane")
        },
        {
          label: "Show Terminal",
          type: "checkbox",
          checked: s?.showTerminalPane === true,
          click: () => sendToActiveWindow("menu:toggle-terminal-pane")
        },
        {
          label: "Show Line Numbers",
          type: "checkbox",
          checked: s?.showLineNumbers === true,
          click: () => sendToActiveWindow("menu:toggle-line-numbers")
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: windowMenuItems(isMac)
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Open Documentation",
          click: () => shell.openExternal("https://github.com/mathiasconradt/tektite/blob/main/docs/user-guide.md")
        },
        ...(isMac ? [] : [{ type: "separator" }, { label: "About Tektite", click: showAboutWindow }])
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function windowMenuItems(isMac) {
  const windows = [...tektiteWindows].filter((window) => !window.isDestroyed());
  const focusedWindow = activeTektiteWindow();
  const windowItems = windows.map((window) => ({
    type: "checkbox",
    label: windowMenuLabel(window),
    checked: window === focusedWindow,
    click: () => focusTektiteWindow(window)
  }));

  return [
    { role: "minimize" },
    isMac
      ? { role: "zoom" }
      : {
          label: "Maximize",
          click: () => toggleMaximize(activeTektiteWindow())
        },
    ...(isMac ? [{ type: "separator" }, { role: "front" }] : []),
    { type: "separator" },
    ...(windowItems.length > 0 ? windowItems : [{ label: "No Windows", enabled: false }])
  ];
}

function windowMenuLabel(window) {
  const vaultName = window.vaultName || window.getTitle() || "Tektite";
  return vaultName;
}

function focusTektiteWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function toggleMaximize(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
}

function vaultArgFromArgv(argv) {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) continue;
    const resolved = path.resolve(arg);
    try {
      if (fsSync.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Path doesn't exist or isn't accessible — return the resolved path
      // so the caller can show the unavailable dialog
      return { path: resolved, invalid: true };
    }
  }
  return null;
}

async function handleVaultArg(vaultPath) {
  if (!vaultPath || typeof vaultPath !== "string") return;
  const normalized = vaultPath;
  // Check if already open in any window
  for (const [win, wv] of windowVaults) {
    if (!win.isDestroyed() && wv === normalized) {
      focusTektiteWindow(win);
      return;
    }
  }
  // Not open — create new window with this vault
  createWindow({ vaultPath: normalized });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (gotSingleInstanceLock) {
  app.on("second-instance", (_event, argv) => {
    const result = vaultArgFromArgv(argv);
    if (result?.invalid) {
      showVaultUnavailableDialog(null, result.path);
    } else if (result) {
      handleVaultArg(result);
    } else {
      const win = activeTektiteWindow();
      if (win) focusTektiteWindow(win);
    }
  });
} else {
  app.quit();
}

app.on("before-quit", () => {
  isQuitting = true;
  try {
    const sessions = [...tektiteWindows]
      .filter((w) => !w.isDestroyed())
      .map((w) => windowVaults.get(w) || null);
    cachedStore.sessions = sessions;
    const p = workspaceStatePath();
    const tmp = `${p}.tmp`;
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.writeFileSync(tmp, JSON.stringify(cachedStore, null, 2), "utf8");
    fsSync.renameSync(tmp, p);
    log("before-quit sessions saved", sessions);
  } catch (e) {
    log("before-quit sessions save failed", e.message);
  }
});

async function restoreSessions() {
  const store = await loadWorkspaceStore();
  const sessions = Array.isArray(store.sessions) && store.sessions.length > 0
    ? store.sessions.filter((v) => v === null || (typeof v === "string" && v))
    : null;
  const restoredVaults = new Set();
  if (sessions) {
    for (const vaultPath of sessions) {
      if (vaultPath) {
        restoredVaults.add(path.resolve(vaultPath));
        createWindow({ show: false, vaultPath });
      } else {
        createWindow({ show: false, restoreLastVault: false });
      }
    }
  } else {
    createWindow({ show: false });
  }
  return restoredVaults;
}

function handleArgVaultAfterRestore(normalizedArgVault, invalidArgVault, restoredVaults) {
  if (invalidArgVault) {
    setTimeout(() => showVaultUnavailableDialog(null, invalidArgVault), splashMinimumMs + 200);
    return;
  }
  if (!normalizedArgVault) return;
  if (restoredVaults.has(normalizedArgVault)) {
    setTimeout(() => {
      for (const [win, wv] of windowVaults) {
        if (!win.isDestroyed() && wv === normalizedArgVault) { focusTektiteWindow(win); break; }
      }
    }, 3200);
  } else {
    createWindow({ show: false, vaultPath: normalizedArgVault, focusOnShow: true });
  }
}

app.on("ready", async () => {
  app.setName("Tektite");
  await loadRecentVaults();
  buildMenu();
  createSplashWindow();

  const argVaultResult = vaultArgFromArgv(process.argv);
  const normalizedArgVault = argVaultResult && !argVaultResult.invalid ? argVaultResult : null;
  const invalidArgVault = argVaultResult?.invalid ? argVaultResult.path : null;

  const restoredVaults = await restoreSessions();
  handleArgVaultAfterRestore(normalizedArgVault, invalidArgVault, restoredVaults);

  app.on("activate", () => {
    if (tektiteWindows.size === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("vault:choose", async () => {
  log("vault:choose start");
  const result = await dialog.showOpenDialog(activeTektiteWindow() || undefined, {
    title: "Open Tektite Vault",
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    log("vault:choose canceled");
    return null;
  }
  log("vault:choose selected", result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle("vault:scan", async (_event, rootPath) => {
  log("vault:scan start", rootPath);
  assertInsideVault(rootPath, rootPath);
  const validation = await validateVaultRoot(rootPath, _event.sender);
  if (!validation.ok) return validation;

  const tree = await readDirectory(rootPath, rootPath);
  const notes = flattenNotes(tree);
  const hasGitRepo = await hasGitRepository(rootPath);
  const gitProvider = hasGitRepo ? await gitProviderFor(rootPath) : null;
  await rememberRecentVault(rootPath);
  log("vault:scan complete", { rootPath, notes: notes.length });
  return { ok: true, rootPath, tree, notes, hasGitRepo, gitProvider };
});

ipcMain.handle("preview:print", async (event, payload = {}) => {
  const parent = BrowserWindow.fromWebContents(event.sender) || activeTektiteWindow() || undefined;
  const printWindow = new BrowserWindow({
    width: 900,
    height: 1100,
    show: false,
    parent,
    title: "Print Preview",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const html = printPreviewDocument(payload);
  try {
    await new Promise((resolve, reject) => {
      printWindow.webContents.once("did-finish-load", resolve);
      printWindow.webContents.once("did-fail-load", (_event, _errorCode, errorDescription) => {
        reject(new Error(errorDescription || "Could not prepare print preview."));
      });
      printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    });

    return await printWebContents(printWindow);
  } finally {
    if (!printWindow.isDestroyed()) printWindow.close();
  }
});

ipcMain.handle("workspace:load", async (_event, rootPath = "") => {
  const store = await loadWorkspaceStore();
  const normalizedRoot = typeof rootPath === "string" && rootPath ? path.resolve(rootPath) : "";
  return {
    lastVault: store.lastVault || recentVaults[0] || null,
    workspace: normalizedRoot ? store.workspaces[normalizedRoot] || null : null
  };
});

ipcMain.handle("workspace:save", async (event, rootPath, workspace) => {
  if (typeof rootPath !== "string" || !rootPath) return false;
  const normalizedRoot = path.resolve(rootPath);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && tektiteWindows.has(win)) windowVaults.set(win, normalizedRoot);
  const store = await loadWorkspaceStore();
  store.lastVault = normalizedRoot;
  store.workspaces[normalizedRoot] = workspace && typeof workspace === "object" ? workspace : {};
  if (!isQuitting) {
    store.sessions = [...tektiteWindows].filter((w) => !w.isDestroyed()).map((w) => windowVaults.get(w) || null);
  }
  await saveWorkspaceStore(store);
  return true;
});

ipcMain.handle("window:pane-state", (event, paneState) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    windowPaneStates.set(win, paneState);
    buildMenu();
  }
});

ipcMain.handle("window:register", () => {
  return true;
});

ipcMain.handle("window:set-vault-name", (event, vaultName) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tektiteWindows.has(window)) return false;

  const label = typeof vaultName === "string" && vaultName.trim() ? vaultName.trim() : "";
  window.vaultName = label;
  window.setTitle(label ? `Tektite - ${label}` : "Tektite");
  buildMenu();
  return true;
});

ipcMain.handle("git:sync", async (event, rootPath) => {
  log("git:sync", rootPath);
  const send = (payload) => event.sender.send("git:sync-output", payload);
  const fail = (output) => {
    send({ type: "done", ok: false });
    return { ok: false, output };
  };

  assertInsideVault(rootPath, rootPath);
  if (!(await hasGitRepository(rootPath))) {
    send({ type: "chunk", text: "This vault does not contain a .git directory.\n" });
    return fail("This vault does not contain a .git directory.");
  }

  await checkSshAuth(rootPath, send);

  const outputs = [];
  let pull;
  try {
    pull = await runGit(rootPath, ["pull", "--ff-only"], send);
  } catch (error) {
    send({ type: "chunk", text: `${error.message}\n` });
    return fail(error.message);
  }
  const pullOutput = formatGitCommandOutput("git pull --ff-only", pull);
  outputs.push(pullOutput);
  if (pull.code !== 0) {
    return fail(pullOutput);
  }

  const status = await runGit(rootPath, ["status", "--porcelain"], send, { emptyOutput: "Working tree clean." });
  outputs.push(formatGitCommandOutput("git status --porcelain", status, status.stdout.trim() ? "" : "Working tree clean."));
  if (status.code !== 0) {
    return fail(outputs.join("\n\n"));
  }

  if (status.stdout.trim()) {
    const add = await runGit(rootPath, ["add", "-A"], send);
    outputs.push(formatGitCommandOutput("git add -A", add));
    if (add.code !== 0) {
      return fail(outputs.join("\n\n"));
    }

    const commit = await runGit(rootPath, ["commit", "-m", "Update Tektite vault"], send);
    outputs.push(formatGitCommandOutput("git commit -m \"Update Tektite vault\"", commit));
    if (commit.code !== 0) {
      return fail(outputs.join("\n\n"));
    }
  }

  const push = await runGit(rootPath, ["push"], send);
  const pushOutput = formatGitCommandOutput("git push", push);
  outputs.push(pushOutput);
  send({ type: "done", ok: push.code === 0 });
  return { ok: push.code === 0, output: outputs.join("\n\n") };
});

ipcMain.handle("note:read", async (_event, rootPath, relativePath) => {
  log("note:read", relativePath);
  const filePath = resolveVaultPath(rootPath, relativePath);
  return fs.readFile(filePath, "utf8");
});

ipcMain.handle("notes:modified-times", async (_event, rootPath, relativePaths = []) => {
  const paths = Array.isArray(relativePaths) ? relativePaths : [];
  return Promise.all(paths.map(async (relativePath) => {
    const filePath = resolveVaultPath(rootPath, relativePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          path: relativePath,
          modifiedAt: null
        };
      }
      throw error;
    }
    return {
      path: relativePath,
      modifiedAt: stat.mtimeMs
    };
  }));
});

ipcMain.handle("note:write", async (_event, rootPath, relativePath, content) => {
  log("note:write", relativePath, `${content.length} chars`);
  const filePath = resolveVaultPath(rootPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  const stat = await fs.stat(filePath);
  return {
    path: relativePath,
    title: noteTitle(relativePath),
    modifiedAt: stat.mtimeMs
  };
});

ipcMain.handle("note:create", async (_event, rootPath, requestedName, folder = "", templatePath = "") => {
  log("note:create", { requestedName, folder, templatePath });
  const safeName = sanitizeNoteName(requestedName || "Untitled");
  const baseFolder = normalizeRelative(folder);
  let candidate = path.posix.join(baseFolder, `${safeName}.md`);
  let index = 2;

  while (await exists(path.join(rootPath, candidate))) {
    candidate = path.posix.join(baseFolder, `${safeName} ${index}.md`);
    index += 1;
  }

  const filePath = resolveVaultPath(rootPath, candidate);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let content = `# ${path.basename(candidate, ".md")}\n\n`;
  if (templatePath) {
    const tplFile = resolveVaultPath(rootPath, templatePath);
    content = await fs.readFile(tplFile, "utf8");
  }

  await fs.writeFile(filePath, content, "utf8");
  return candidate;
});

const DEFAULT_TEMPLATES_PATH = ".tektite/templates";

ipcMain.handle("templates:list", async (_event, rootPath, templatesPath = "") => {
  const relPath = (templatesPath || DEFAULT_TEMPLATES_PATH).replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  log("templates:list", rootPath, relPath);
  const templatesDir = path.join(rootPath, relPath);
  assertInsideVault(rootPath, templatesDir);
  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => ({ name: path.basename(e.name, ".md"), path: `${relPath}/${e.name}` }));
  } catch {
    return [];
  }
});

ipcMain.handle("settings:load", async (_event, rootPath) => {
  log("settings:load", rootPath);
  try {
    const settingsFile = path.join(rootPath, ".tektite", "settings.json");
    assertInsideVault(rootPath, settingsFile);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      templatesPath: typeof parsed.templatesPath === "string" ? parsed.templatesPath : "",
      autoLinkUrls: Boolean(parsed.autoLinkUrls),
      tocListStyle: parsed.tocListStyle === "ordered" ? "ordered" : "unordered",
      tocIncludeSubfolders: Boolean(parsed.tocIncludeSubfolders),
      treeFontSize: typeof parsed.treeFontSize === "number" ? parsed.treeFontSize : null,
      editorFontSize: typeof parsed.editorFontSize === "number" ? parsed.editorFontSize : null
    };
  } catch {
    return { templatesPath: "", autoLinkUrls: false, tocListStyle: "unordered", tocIncludeSubfolders: false };
  }
});

ipcMain.handle("settings:save", async (_event, rootPath, settings) => {
  log("settings:save", rootPath, settings);
  const settingsFile = path.join(rootPath, ".tektite", "settings.json");
  assertInsideVault(rootPath, settingsFile);
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
  return true;
});

ipcMain.handle("folder:create", async (_event, rootPath, requestedName, parentFolder = "") => {
  log("folder:create", { requestedName, parentFolder });
  const safeName = sanitizeEntryName(requestedName || "Untitled folder", "Untitled folder");
  const baseFolder = normalizeRelative(parentFolder);
  let candidate = path.posix.join(baseFolder, safeName);
  let index = 2;

  while (await exists(path.join(rootPath, candidate))) {
    candidate = path.posix.join(baseFolder, `${safeName} ${index}`);
    index += 1;
  }

  const folderPath = resolveVaultPath(rootPath, candidate);
  await fs.mkdir(folderPath, { recursive: false });
  return candidate;
});

ipcMain.handle("entry:delete", async (_event, rootPath, relativePath, type) => {
  log("entry:delete", { relativePath, type });
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new Error("Cannot delete the vault root.");

  const entryPath = resolveVaultPath(rootPath, normalized);
  const stat = await fs.stat(entryPath);
  if (type === "folder" && !stat.isDirectory()) throw new Error("Selected entry is not a folder.");
  if ((type === "note" || type === "asset") && !stat.isFile()) throw new Error("Selected entry is not a file.");

  if (stat.isDirectory()) {
    await fs.rm(entryPath, { recursive: true, force: false });
  } else {
    await fs.unlink(entryPath);
  }

  return true;
});

ipcMain.handle("entry:rename", async (_event, rootPath, relativePath, type, requestedName) => {
  log("entry:rename", { relativePath, type, requestedName });
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new Error("Cannot rename the vault root.");

  const fromPath = resolveVaultPath(rootPath, normalized);
  const stat = await fs.stat(fromPath);
  if (type === "folder" && !stat.isDirectory()) throw new Error("Selected entry is not a folder.");
  if ((type === "note" || type === "asset") && !stat.isFile()) throw new Error("Selected entry is not a file.");

  const currentName = path.basename(normalized);
  const nextName = renamedEntryName(currentName, requestedName, type);
  if (!nextName || nextName === currentName) return normalized;

  const candidate = path.posix.join(parentPosix(normalized), nextName);
  const toPath = resolveVaultPath(rootPath, candidate);
  if (await exists(toPath)) throw new Error(`"${nextName}" already exists.`);

  await fs.rename(fromPath, toPath);
  if (type === "asset" && imageExtensions.has(path.extname(candidate).toLowerCase())) {
    await updateMovedAssetReferences(rootPath, normalized, candidate);
  } else if (type === "note") {
    await updateMovedNoteReferences(rootPath, normalized, candidate);
  } else if (type === "folder") {
    await updateMovedFolderReferences(rootPath, normalized, candidate);
  }
  return candidate;
});

ipcMain.handle("entry:move", async (_event, rootPath, relativePath, type, targetFolder = "") => {
  log("entry:move", { relativePath, type, targetFolder });
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new Error("Cannot move the vault root.");

  const fromPath = resolveVaultPath(rootPath, normalized);
  const stat = await fs.stat(fromPath);
  if (type === "folder" && !stat.isDirectory()) throw new Error("Selected entry is not a folder.");
  if ((type === "note" || type === "asset") && !stat.isFile()) throw new Error("Selected entry is not a file.");

  const destinationFolder = normalizeRelative(targetFolder);
  if (type === "folder" && destinationFolder && (destinationFolder === normalized || destinationFolder.startsWith(`${normalized}/`))) {
    throw new Error("Cannot move a folder inside itself.");
  }

  const baseName = path.basename(normalized);
  let candidate = path.posix.join(destinationFolder, baseName);
  let index = 2;
  const parsed = path.parse(baseName);

  while (await exists(path.join(rootPath, candidate))) {
    const nextName = stat.isDirectory()
      ? `${baseName} ${index}`
      : `${parsed.name} ${index}${parsed.ext}`;
    candidate = path.posix.join(destinationFolder, nextName);
    index += 1;
  }

  const toPath = resolveVaultPath(rootPath, candidate);
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await fs.rename(fromPath, toPath);
  if (type === "asset" && imageExtensions.has(path.extname(candidate).toLowerCase())) {
    await updateMovedAssetReferences(rootPath, normalized, candidate);
  } else if (type === "note") {
    await updateMovedNoteReferences(rootPath, normalized, candidate);
  } else if (type === "folder") {
    await updateMovedFolderReferences(rootPath, normalized, candidate);
  }
  return candidate;
});

ipcMain.handle("asset:import-image", async (_event, rootPath, sourcePath, targetFolder = "") => {
  log("asset:import-image", { sourcePath, targetFolder });
  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Dropped item is not a file.");

  const extension = path.extname(sourcePath).toLowerCase();
  if (!imageExtensions.has(extension)) throw new Error("Dropped file is not a supported image.");

  const baseFolder = normalizeRelative(targetFolder);
  const sourceName = sanitizeEntryName(path.basename(sourcePath, extension), "image");
  let candidate = path.posix.join(baseFolder, `${sourceName}${extension}`);
  let index = 2;

  while (await exists(path.join(rootPath, candidate))) {
    candidate = path.posix.join(baseFolder, `${sourceName} ${index}${extension}`);
    index += 1;
  }

  const destinationPath = resolveVaultPath(rootPath, candidate);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return {
    path: candidate,
    name: path.basename(candidate),
    label: path.basename(candidate, path.extname(candidate))
  };
});

ipcMain.handle("asset:import-file-or-directory", async (_event, rootPath, sourcePath, targetFolder = "") => {
  log("asset:import-file-or-directory", { sourcePath, targetFolder });

  const sourceStat = await fs.stat(sourcePath);
  const isDirectory = sourceStat.isDirectory();
  const isFile = sourceStat.isFile();

  if (!isFile && !isDirectory) {
    throw new Error("Dropped item is neither a file nor a directory.");
  }

  const baseFolder = normalizeRelative(targetFolder);
  let candidate = "";

  if (isFile) {
    const extension = path.extname(sourcePath).toLowerCase();
    const baseName = sanitizeEntryName(path.basename(sourcePath, extension), "file");
    candidate = path.posix.join(baseFolder, `${baseName}${extension}`);

    let index = 2;
    while (await exists(path.join(rootPath, candidate))) {
      candidate = path.posix.join(baseFolder, `${baseName} ${index}${extension}`);
      index += 1;
    }
  } else {
    const sourceName = sanitizeEntryName(path.basename(sourcePath), "folder");
    candidate = path.posix.join(baseFolder, sourceName);

    let index = 2;
    while (await exists(path.join(rootPath, candidate))) {
      candidate = path.posix.join(baseFolder, `${sourceName} ${index}`);
      index += 1;
    }
  }

  const destinationPath = resolveVaultPath(rootPath, candidate);
  
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.cp(sourcePath, destinationPath, { recursive: true });

  return {
    path: candidate,
    name: path.basename(candidate),
    label: isFile ? path.basename(candidate, path.extname(candidate)) : path.basename(candidate)
  };
});

ipcMain.handle("asset:save-clipboard-image", async (_event, rootPath, targetFolder = "", image = {}) => {
  log("asset:save-clipboard-image", { targetFolder, name: image.name, mimeType: image.mimeType });
  const dataUrl = typeof image.dataUrl === "string" ? image.dataUrl : "";
  const match = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error("Clipboard image data is invalid.");

  const mimeType = match[1].toLowerCase();
  const extension = clipboardImageExtension(mimeType, image.name);
  if (!imageExtensions.has(extension)) throw new Error("Clipboard image type is not supported.");

  const baseFolder = normalizeRelative(targetFolder);
  const candidate = await clipboardImageCandidate(rootPath, baseFolder, image.name, extension);
  const destinationPath = resolveVaultPath(rootPath, candidate);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, Buffer.from(match[2], "base64"));
  return {
    path: candidate,
    name: path.basename(candidate),
    label: path.basename(candidate, path.extname(candidate))
  };
});

ipcMain.handle("asset:read-data-url", async (_event, rootPath, relativePath) => {
  log("asset:read-data-url", relativePath);
  const filePath = resolveVaultPath(rootPath, relativePath);
  const extension = path.extname(filePath).toLowerCase();
  if (!imageExtensions.has(extension)) throw new Error("Selected file is not a supported image.");

  const data = await fs.readFile(filePath);
  return `data:${imageMimeType(extension)};base64,${data.toString("base64")}`;
});

async function readDirectory(rootPath, currentPath) {
  log("readDirectory", toPosix(path.relative(rootPath, currentPath)) || ".");
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const children = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const absolute = path.join(currentPath, entry.name);
    const relative = toPosix(path.relative(rootPath, absolute));

    if (entry.isDirectory()) {
      children.push(await readDirectory(rootPath, absolute));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const stat = await fs.stat(absolute);
      children.push({
        type: "note",
        name: entry.name,
        title: noteTitle(relative),
        path: relative,
        modifiedAt: stat.mtimeMs
      });
    } else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
      const stat = await fs.stat(absolute);
      children.push({
        type: "asset",
        kind: "image",
        name: entry.name,
        title: path.basename(entry.name, path.extname(entry.name)),
        path: relative,
        modifiedAt: stat.mtimeMs
      });
    }
  }

  children.sort((a, b) => {
    const order = { folder: 0, note: 1, asset: 2 };
    if (a.type !== b.type) return order[a.type] - order[b.type];
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return {
    type: "folder",
    name: path.basename(currentPath),
    path: toPosix(path.relative(rootPath, currentPath)),
    children
  };
}

function flattenNotes(node) {
  if (node.type === "note") return [node];
  if (!Array.isArray(node.children)) return [];

  const notes = [];
  for (const child of node.children) {
    notes.push(...flattenNotes(child));
  }
  return notes;
}

async function updateMovedAssetReferences(rootPath, oldAssetPath, newAssetPath) {
  const tree = await readDirectory(rootPath, rootPath);
  const notes = flattenNotes(tree);

  for (const note of notes) {
    const notePath = resolveVaultPath(rootPath, note.path);
    const original = await fs.readFile(notePath, "utf8");
    const updated = rewriteAssetLinks(original, note.path, oldAssetPath, newAssetPath);
    if (updated !== original) {
      await fs.writeFile(notePath, updated, "utf8");
    }
  }
}

async function updateMovedNoteReferences(rootPath, oldNotePath, newNotePath) {
  const tree = await readDirectory(rootPath, rootPath);
  const notes = flattenNotes(tree);

  for (const note of notes) {
    const notePath = resolveVaultPath(rootPath, note.path);
    const original = await fs.readFile(notePath, "utf8");
    let updated = rewriteAssetLinks(original, note.path, oldNotePath, newNotePath);
    updated = rewriteWikiNoteLinks(updated, note.path, oldNotePath, newNotePath);
    if (updated !== original) {
      await fs.writeFile(notePath, updated, "utf8");
    }
  }
}

async function updateMovedFolderReferences(rootPath, oldFolderPath, newFolderPath) {
  const tree = await readDirectory(rootPath, rootPath);
  const notes = flattenNotes(tree);

  for (const note of notes) {
    const notePath = resolveVaultPath(rootPath, note.path);
    const original = await fs.readFile(notePath, "utf8");
    let updated = rewriteFolderMarkdownLinks(original, note.path, oldFolderPath, newFolderPath);
    updated = rewriteFolderWikiLinks(updated, note.path, oldFolderPath, newFolderPath);
    if (updated !== original) {
      await fs.writeFile(notePath, updated, "utf8");
    }
  }
}

function rewriteAssetLinks(markdown, notePath, oldAssetPath, newAssetPath) {
  return markdown.replace(/(!?\[[^\]]*\]\()([^)]+)(\))/g, (match, prefix, href, suffix) => {
    const decodedHref = decodeMarkdownLink(href);
    if (/^[a-z]+:\/\//i.test(decodedHref)) return match;

    const resolved = resolveMarkdownReference(notePath, decodedHref);
    if (resolved !== oldAssetPath) return match;

    const nextHref = encodeMarkdownLink(relativeMarkdownPath(notePath, newAssetPath));
    return `${prefix}${nextHref}${suffix}`;
  });
}

function rewriteFolderMarkdownLinks(markdown, notePath, oldFolderPath, newFolderPath) {
  return markdown.replace(/(!?\[[^\]]*\]\()([^)]+)(\))/g, (match, prefix, href, suffix) => {
    const decodedHref = decodeMarkdownLink(href);
    if (/^[a-z]+:\/\//i.test(decodedHref)) return match;

    const resolved = resolveMarkdownReference(notePath, decodedHref);
    const moved = movedPathInsideFolder(resolved, oldFolderPath, newFolderPath);
    if (!moved) return match;

    const nextHref = encodeMarkdownLink(relativeMarkdownPath(notePath, moved));
    return `${prefix}${nextHref}${suffix}`;
  });
}

function rewriteWikiNoteLinks(markdown, notePath, oldNotePath, newNotePath) {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (match, target) => {
    const pipeIndex = target.indexOf("|");
    const targetPart = pipeIndex >= 0 ? target.slice(0, pipeIndex) : target;
    const aliasPart = pipeIndex >= 0 ? target.slice(pipeIndex) : "";
    const headingIndex = targetPart.indexOf("#");
    const pathPart = headingIndex >= 0 ? targetPart.slice(0, headingIndex) : targetPart;
    const headingPart = headingIndex >= 0 ? targetPart.slice(headingIndex) : "";

    if (resolveWikiReference(notePath, pathPart) !== oldNotePath) return match;

    const nextTarget = wikiTargetFor(notePath, pathPart, newNotePath);
    return `[[${nextTarget}${headingPart}${aliasPart}]]`;
  });
}

function rewriteFolderWikiLinks(markdown, notePath, oldFolderPath, newFolderPath) {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (match, target) => {
    const pipeIndex = target.indexOf("|");
    const targetPart = pipeIndex >= 0 ? target.slice(0, pipeIndex) : target;
    const aliasPart = pipeIndex >= 0 ? target.slice(pipeIndex) : "";
    const headingIndex = targetPart.indexOf("#");
    const pathPart = headingIndex >= 0 ? targetPart.slice(0, headingIndex) : targetPart;
    const headingPart = headingIndex >= 0 ? targetPart.slice(headingIndex) : "";
    const resolved = resolveWikiReference(notePath, pathPart);
    const moved = movedPathInsideFolder(resolved, oldFolderPath, newFolderPath);
    if (!moved) return match;

    const nextTarget = wikiTargetFor(notePath, pathPart, moved);
    return `[[${nextTarget}${headingPart}${aliasPart}]]`;
  });
}

function movedPathInsideFolder(resolvedPath, oldFolderPath, newFolderPath) {
  if (!resolvedPath || resolvedPath === oldFolderPath) return "";
  if (!resolvedPath.startsWith(`${oldFolderPath}/`)) return "";
  return `${newFolderPath}${resolvedPath.slice(oldFolderPath.length)}`;
}

function resolveWikiReference(notePath, target) {
  const clean = decodeMarkdownLink(target).trim().replace(/^\/+/, "");
  if (!clean) return "";
  const candidates = path.extname(clean) ? [clean] : [`${clean}.md`, clean];
  for (const candidate of candidates) {
    const resolved = resolveMarkdownReference(notePath, candidate);
    if (resolved) return resolved;
  }
  return "";
}

function wikiTargetFor(notePath, oldTarget, newNotePath) {
  const relative = relativeMarkdownPath(notePath, newNotePath).replace(/\.md$/i, "");
  if (oldTarget.includes("/") || oldTarget.startsWith(".") || oldTarget.startsWith("/")) {
    return relative.replace(/^\.\//, "");
  }
  return path.basename(newNotePath, path.extname(newNotePath));
}

function resolveMarkdownReference(notePath, href) {
  const clean = href.trim().replace(/^<|>$/g, "").replace(/#.*$/, "");
  const noteFolder = parentPosix(notePath);
  const joined = clean.startsWith("/")
    ? clean.replace(/^\/+/, "")
    : path.posix.join(noteFolder, clean);
  return normalizePosix(joined);
}

function relativeMarkdownPath(notePath, assetPath) {
  const noteFolder = parentPosix(notePath);
  const relative = path.posix.relative(noteFolder || ".", assetPath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function printPreviewDocument(payload = {}) {
  const title = payload.title || "Tektite";
  const notePath = payload.path || "";
  const content = payload.html || "<p>Nothing to print.</p>";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline';">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color: #1f2523;
      background: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      margin: 0;
      background: #ffffff;
    }
    main {
      max-width: 760px;
      margin: 0 auto;
      padding: 42px 48px 56px;
      font-size: 16px;
      line-height: 1.68;
    }
    .print-title {
      margin: 0 0 4px;
      font-size: 28px;
      line-height: 1.2;
    }
    .print-path {
      margin: 0 0 28px;
      color: #69746f;
      font-size: 12px;
    }
    h1, h2, h3 {
      line-height: 1.2;
    }
    h1 { font-size: 30px; }
    h2 {
      margin-top: 30px;
      font-size: 24px;
    }
    h3 {
      margin-top: 24px;
      font-size: 19px;
    }
    p, ul, ol, blockquote, pre, table {
      margin: 0 0 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95em;
    }
    th, td {
      border: 1px solid #d9ddd8;
      padding: 7px 12px;
      text-align: left;
    }
    th {
      background: #f3f5f2;
      font-weight: 680;
    }
    code {
      border-radius: 4px;
      background: #f3f5f2;
      padding: 2px 5px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
    }
    pre {
      overflow: auto;
      border: 1px solid #d9ddd8;
      border-radius: 8px;
      background: #1f2523;
      color: #f6f2e8;
      padding: 14px 16px;
    }
    pre code {
      background: transparent;
      padding: 0;
      color: inherit;
    }
    blockquote {
      border-left: 4px solid #2f7d5d;
      margin-left: 0;
      padding: 8px 0 8px 16px;
      color: #53615b;
      background: #f6f8f5;
    }
    a {
      color: #2c6fca;
      text-decoration: none;
    }
    img {
      display: block;
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 0 0 16px;
    }
    @media print {
      main {
        max-width: none;
        padding: 0;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1 class="print-title">${escapeHtml(title)}</h1>
    ${notePath ? `<p class="print-path">${escapeHtml(notePath)}</p>` : ""}
    <article>${content}</article>
  </main>
</body>
</html>`;
}

function printWebContents(printWindow) {
  return new Promise((resolve) => {
    printWindow.webContents.print({ printBackground: true }, (success, failureReason) => {
      resolve({
        ok: success,
        error: success ? "" : failureReason || "Print canceled."
      });
    });
  });
}

function decodeMarkdownLink(value) {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function encodeMarkdownLink(value) {
  return encodeURI(value).replaceAll("%5B", "[").replaceAll("%5D", "]");
}

function parentPosix(value) {
  const parts = value.split("/");
  parts.pop();
  return parts.join("/");
}

function resolveVaultPath(rootPath, relativePath) {
  const normalizedRoot = path.resolve(rootPath);
  const resolved = path.resolve(normalizedRoot, relativePath);
  assertInsideVault(normalizedRoot, resolved);
  return resolved;
}

function assertInsideVault(rootPath, candidatePath) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path is outside the vault.");
  }
}

function noteTitle(relativePath) {
  return path.basename(relativePath, path.extname(relativePath));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function sanitizeNoteName(value) {
  return sanitizeEntryName(value, "Untitled").replace(/\.md$/i, "") || "Untitled";
}

function renamedEntryName(currentName, requestedName, type) {
  if (type === "folder") return sanitizeEntryName(requestedName || currentName, currentName);

  const currentExtension = path.extname(currentName);
  const fallback = path.basename(currentName, currentExtension);
  const requested = sanitizeEntryName(requestedName || fallback, fallback);
  const requestedExtension = path.extname(requested);

  if (type === "note") {
    return `${requested.replace(/\.md$/i, "") || fallback}.md`;
  }

  if (requestedExtension && imageExtensions.has(requestedExtension.toLowerCase())) {
    return requested;
  }

  return `${requested.replace(/\.[^.]+$/, "") || fallback}${currentExtension}`;
}

function imageMimeType(extension) {
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

function clipboardImageExtension(mimeType, requestedName = "") {
  const requestedExtension = path.extname(requestedName).toLowerCase();
  if (imageExtensions.has(requestedExtension)) return requestedExtension;
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return ".png";
  }
}

async function clipboardImageCandidate(rootPath, baseFolder, requestedName, extension) {
  if (hasOriginalClipboardName(requestedName)) {
    const parsed = path.parse(requestedName);
    const sourceName = sanitizeEntryName(parsed.name, "image");
    return uniqueOriginalAssetPath(rootPath, baseFolder, sourceName, extension);
  }

  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return uniqueGeneratedAssetPath(rootPath, baseFolder, `image-${yyyy}${mm}${dd}`, extension);
}

function hasOriginalClipboardName(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/^image\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value.trim());
}

async function uniqueOriginalAssetPath(rootPath, baseFolder, baseName, extension) {
  let candidate = path.posix.join(baseFolder, `${baseName}${extension}`);
  let index = 2;
  while (await exists(path.join(rootPath, candidate))) {
    candidate = path.posix.join(baseFolder, `${baseName} ${index}${extension}`);
    index += 1;
  }
  return candidate;
}

async function uniqueGeneratedAssetPath(rootPath, baseFolder, baseName, extension) {
  let index = 1;
  let candidate = path.posix.join(baseFolder, `${baseName}-${index}${extension}`);
  while (await exists(path.join(rootPath, candidate))) {
    index += 1;
    candidate = path.posix.join(baseFolder, `${baseName}-${index}${extension}`);
  }
  return candidate;
}

function sanitizeEntryName(value, fallback) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim() || fallback;
}

function normalizeRelative(value) {
  return normalizePosix(toPosix(value || "").replace(/^\/+/, ""));
}

function normalizePosix(value) {
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasGitRepository(rootPath) {
  try {
    assertInsideVault(rootPath, path.join(rootPath, ".git"));
    await fs.access(path.join(rootPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function gitProviderFor(rootPath) {
  try {
    const configPath = path.join(rootPath, ".git", "config");
    assertInsideVault(rootPath, configPath);
    const config = await fs.readFile(configPath, "utf8");
    return /\bgithub\.com[:/]/i.test(config) || /\bgithub\.com\b/i.test(config) ? "github" : "git";
  } catch {
    return "git";
  }
}

function gitFailureReason({ timedOut, signal, exitCode }) {
  if (timedOut) return "timeout";
  return signal || exitCode;
}

async function checkSshAuth(rootPath, send) {
  const remoteResult = await runGit(rootPath, ["remote", "get-url", "origin"]);
  if (remoteResult.code !== 0) return;

  const remoteUrl = remoteResult.stdout.trim();
  if (!remoteUrl || remoteUrl.startsWith("http://") || remoteUrl.startsWith("https://")) return;

  // SSH URL: git@github.com:user/repo.git or ssh://git@github.com/user/repo.git
  const hostMatch = remoteUrl.match(/[@/]([a-zA-Z0-9._-]+)[:/]/);
  if (!hostMatch) return;
  const host = hostMatch[1];

  const sshBin = platform.sshExecutable();
  if (platform.isWindows() && !fsSync.existsSync(sshBin)) return;

  const { execFile } = require("node:child_process");
  await new Promise((resolve) => {
    execFile(
      sshBin,
      ["-T", `git@${host}`, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"],
      { env: { PATH: platform.gitSafePath(), SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || "" } },
      (error, _stdout, stderr) => {
        // exit code 1 with "successfully authenticated" is normal for GitHub/GitLab
        const output = (stderr || "").toLowerCase();
        const authenticated = !error || output.includes("successfully authenticated") || output.includes("welcome to");
        if (!authenticated) {
          send({
            type: "chunk",
            text: `Warning: SSH authentication to ${host} failed. Git sync will likely fail.\n${stderr ? stderr.trim() + "\n" : ""}`
          });
        }
        resolve();
      }
    );
  });
}

async function runGit(rootPath, args, send = () => {}, options = {}) {
  const gitExecutable = await resolveGitExecutable();
  return new Promise((resolve) => {
    const command = `git ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
    send({ type: "command", text: `$ ${command}\n` });

    const child = spawn(gitExecutable, args, {
      cwd: rootPath,
      env: gitEnvironment()
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120000);

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      send({ type: "chunk", text });
    });
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      send({ type: "chunk", text });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      const message = `${error.message}\n`;
      send({ type: "chunk", text: message });
      resolve({
        code: 1,
        signal: null,
        stdout,
        stderr,
        error: error.message
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const exitCode = timedOut ? 1 : code || 0;
      const failureReason = gitFailureReason({ timedOut, signal, exitCode });
      const status = exitCode === 0 ? "OK" : `FAILED (${failureReason})`;
      if (!stdout.trim() && options.emptyOutput) send({ type: "chunk", text: `${options.emptyOutput}\n` });
      send({ type: "status", text: `${status}\n\n` });
      resolve({
        code: exitCode,
        signal: timedOut ? "timeout" : signal,
        stdout,
        stderr,
        error: timedOut ? "Command timed out." : ""
      });
    });
  });
}

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

function gitEnvironment() {
  return platform.gitEnvironment();
}

function formatGitCommandOutput(command, result, emptyOutput = "") {
  const status = result.code === 0 ? "OK" : `FAILED (${result.signal || result.code})`;
  const parts = [`$ ${command}`, status];
  if (result.stdout.trim()) parts.push("", result.stdout.trim());
  else if (emptyOutput) parts.push("", emptyOutput);
  if (result.stderr.trim()) parts.push("", result.stderr.trim());
  if (result.error && result.code !== 0 && !result.stderr.trim()) parts.push("", result.error);
  return parts.join("\n");
}

// ── Terminal (node-pty) ──────────────────────────────────────────────────────

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
  const { pid } = ptyProc;
  ptySessions.set(pid, ptyProc);
  ptyProc.onData((data) => { event.sender.send(`terminal:data:${pid}`, data); });
  ptyProc.onExit(() => {
    event.sender.send("terminal:kill");
    ptySessions.delete(pid);
  });
  return pid;
});

ipcMain.handle("terminal:write", (_e, pid, data) => { ptySessions.get(pid)?.write(data); });
ipcMain.handle("terminal:resize", (_e, pid, cols, rows) => { ptySessions.get(pid)?.resize(cols, rows); });
ipcMain.handle("terminal:destroy", (_e, pid) => {
  const p = ptySessions.get(pid);
  if (p) { try { p.kill(); } catch {} ptySessions.delete(pid); }
});
