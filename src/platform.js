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
    systemRoot + "\\System32",
    systemRoot,
    systemRoot + "\\System32\\WindowsPowerShell\\v1.0"
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
  return systemRoot + "\\System32\\OpenSSH\\ssh.exe";
}

/**
 * Returns true when a Windows executable path lives under a trusted system
 * location (Program Files, Program Files (x86), or the Windows directory).
 * Used to validate git binaries resolved dynamically via "where git", so a
 * binary planted in a user- or vault-controlled directory is never trusted.
 *
 * @param {string} candidate Absolute Windows path to an executable.
 * @param {NodeJS.ProcessEnv} [env=process.env] Source environment.
 * @returns {boolean} True if the path is under a trusted root.
 */
function isTrustedWindowsExecutable(candidate, env = process.env) {
  const normalized = path.win32.normalize(String(candidate)).toLowerCase();
  const roots = [
    env.ProgramFiles || "C:\\Program Files",
    env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    env.SystemRoot || "C:\\Windows"
  ].map((root) => path.win32.normalize(root).toLowerCase());
  return roots.some((root) => normalized.startsWith(root + "\\"));
}

module.exports = {
  isWindows,
  gitExecutableCandidates,
  gitSafePath,
  gitEnvironment,
  defaultShell,
  fallbackShell,
  sshExecutable,
  isTrustedWindowsExecutable
};
