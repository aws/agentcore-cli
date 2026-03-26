/**
 * Testable detection logic for the old Bedrock AgentCore Starter Toolkit.
 *
 * Each function accepts an `execSyncFn` so callers can inject a mock.
 */

const INSTALLERS = [
  { cmd: 'pip list', label: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
  { cmd: 'pipx list', label: 'pipx', uninstallCmd: 'pipx uninstall bedrock-agentcore-starter-toolkit' },
  { cmd: 'uv tool list', label: 'uv', uninstallCmd: 'uv tool uninstall bedrock-agentcore-starter-toolkit' },
];

/**
 * Run a package-manager list command and check whether the old toolkit appears.
 * Returns `{ installer, uninstallCmd }` when found, or `null`.
 */
export function probeInstaller(cmd, label, uninstallCmd, execSyncFn) {
  try {
    const output = execSyncFn(cmd);
    if (/^bedrock-agentcore-starter-toolkit\s/m.test(output)) {
      return { installer: label, uninstallCmd };
    }
  } catch {
    // Command not found or non-zero exit — ignore.
  }
  return null;
}

/**
 * PATH-based fallback: locate an `agentcore` binary and check whether it's
 * the old Python CLI (which doesn't support --version).
 * Returns `{ installer, uninstallCmd }` when the old CLI is found, or `null`.
 */
export function probePath(execSyncFn, platform = process.platform) {
  const whichCmd = platform === 'win32' ? 'where agentcore' : 'command -v agentcore';
  let binaryPath;
  try {
    binaryPath = execSyncFn(whichCmd).trim();
  } catch {
    return null; // no agentcore binary on PATH
  }
  // Skip binaries installed via npm/node — a broken new CLI install would also
  // fail --version, and we don't want to block reinstallation.
  if (/node_modules|[/\\]\.?(?:npm|nvm|fnm)[/\\]/.test(binaryPath)) {
    return null;
  }
  try {
    execSyncFn('agentcore --version');
    return null; // --version succeeded — this is the new CLI
  } catch {
    // --version failed — likely the old Python CLI
    return {
      installer: 'PATH',
      uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit',
    };
  }
}

/**
 * Probe pip, pipx, and uv for the old toolkit, then fall back to PATH-based
 * detection. Returns an array of matches.
 */
export function detectOldToolkit(execSyncFn) {
  const results = [];
  for (const { cmd, label, uninstallCmd } of INSTALLERS) {
    const match = probeInstaller(cmd, label, uninstallCmd, execSyncFn);
    if (match) results.push(match);
  }
  // If package-manager queries found nothing, fall back to PATH-based check
  if (results.length === 0) {
    const pathMatch = probePath(execSyncFn);
    if (pathMatch) results.push(pathMatch);
  }
  return results;
}

/**
 * Format a user-facing warning message listing per-installer uninstall commands.
 */
export function formatWarningMessage(detected) {
  const yellow = '\x1b[33m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';
  const lines = [
    '',
    `${bold}${yellow}╔══════════════════════════════════════════════════════════════════╗${reset}`,
    `${bold}${yellow}║  WARNING: Old Bedrock AgentCore Starter Toolkit detected        ║${reset}`,
    `${bold}${yellow}╚══════════════════════════════════════════════════════════════════╝${reset}`,
    '',
    `${yellow}The old Starter Toolkit CLI uses the same "agentcore" command name.${reset}`,
    `${yellow}To avoid confusion, please uninstall it:${reset}`,
    '',
  ];

  for (const { installer, uninstallCmd } of detected) {
    lines.push(`${yellow}  ${uninstallCmd}  # installed via ${installer}${reset}`);
  }

  lines.push('');

  return lines.join('\n');
}
