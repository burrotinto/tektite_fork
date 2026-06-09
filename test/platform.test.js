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
