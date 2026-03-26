import {
  detectOldToolkit,
  formatWarningMessage,
  probeInstaller,
  probePath,
} from '../../../../scripts/check-old-cli.lib.mjs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// probeInstaller
// ---------------------------------------------------------------------------
describe('probeInstaller', () => {
  it('returns match when output contains the old toolkit', () => {
    const exec = () => 'bedrock-agentcore-starter-toolkit  0.1.0\nsome-other-pkg  1.0.0';
    const result = probeInstaller('pip list', 'pip', 'pip uninstall bedrock-agentcore-starter-toolkit', exec);
    expect(result).toEqual({
      installer: 'pip',
      uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit',
    });
  });

  it('returns null when the old toolkit is not in output', () => {
    const exec = () => 'some-other-pkg  1.0.0';
    const result = probeInstaller('pip list', 'pip', 'pip uninstall bedrock-agentcore-starter-toolkit', exec);
    expect(result).toBeNull();
  });

  it('does not match a package whose name is a superstring of the toolkit', () => {
    const exec = () => 'bedrock-agentcore-starter-toolkit-extra  1.0.0';
    const result = probeInstaller('pip list', 'pip', 'pip uninstall bedrock-agentcore-starter-toolkit', exec);
    expect(result).toBeNull();
  });

  it('returns null when the command throws', () => {
    const exec = () => {
      throw new Error('command not found');
    };
    const result = probeInstaller('pip list', 'pip', 'pip uninstall bedrock-agentcore-starter-toolkit', exec);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// probePath
// ---------------------------------------------------------------------------
describe('probePath', () => {
  it('returns match when agentcore exists but --version fails (old Python CLI)', () => {
    const exec = (cmd: string) => {
      if (cmd === 'command -v agentcore') return '/usr/local/bin/agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    const result = probePath(exec);
    expect(result).toEqual({
      installer: 'PATH',
      uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit',
    });
  });

  it('returns null when agentcore exists and --version succeeds (new CLI)', () => {
    const exec = (cmd: string) => {
      if (cmd === 'command -v agentcore') return '/usr/local/bin/agentcore';
      if (cmd === 'agentcore --version') return '1.0.0';
      return '';
    };
    expect(probePath(exec)).toBeNull();
  });

  it('returns null when no agentcore binary is on PATH', () => {
    const exec = () => {
      throw new Error('command not found');
    };
    expect(probePath(exec)).toBeNull();
  });

  it('uses "where agentcore" on Windows', () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'where agentcore') return 'C:\\Python\\Scripts\\agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    const result = probePath(exec, 'win32');
    expect(calls[0]).toBe('where agentcore');
    expect(result).toEqual({
      installer: 'PATH',
      uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit',
    });
  });

  it('returns null when binary is inside node_modules (broken new CLI)', () => {
    const exec = (cmd: string) => {
      if (cmd === 'command -v agentcore') return '/usr/local/lib/node_modules/@aws/agentcore/bin/agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    expect(probePath(exec)).toBeNull();
  });

  it('returns null when binary is inside .nvm directory (npm-managed via nvm)', () => {
    const exec = (cmd: string) => {
      if (cmd === 'command -v agentcore') return '/Users/rft/.nvm/versions/node/v25.1.0/bin/agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    expect(probePath(exec)).toBeNull();
  });

  it('returns null when binary is inside .fnm directory (npm-managed via fnm)', () => {
    const exec = (cmd: string) => {
      if (cmd === 'command -v agentcore') return '/Users/dev/.fnm/node-versions/v20.0.0/installation/bin/agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    expect(probePath(exec)).toBeNull();
  });

  it('returns null when Windows binary is inside npm directory', () => {
    const exec = (cmd: string) => {
      if (cmd === 'where agentcore') return 'C:\\Users\\dev\\AppData\\Roaming\\npm\\agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    expect(probePath(exec, 'win32')).toBeNull();
  });

  it('returns null when Windows binary is inside .nvm directory', () => {
    const exec = (cmd: string) => {
      if (cmd === 'where agentcore') return 'C:\\Users\\dev\\.nvm\\versions\\node\\v20\\bin\\agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    expect(probePath(exec, 'win32')).toBeNull();
  });

  it('returns null when Windows binary is inside .fnm directory', () => {
    const exec = (cmd: string) => {
      if (cmd === 'where agentcore') return 'C:\\Users\\dev\\.fnm\\node-versions\\v20\\bin\\agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    expect(probePath(exec, 'win32')).toBeNull();
  });

  it('uses "command -v agentcore" on non-Windows', () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'command -v agentcore') return '/usr/local/bin/agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    probePath(exec, 'linux');
    expect(calls[0]).toBe('command -v agentcore');
  });
});

// ---------------------------------------------------------------------------
// detectOldToolkit
// ---------------------------------------------------------------------------
describe('detectOldToolkit', () => {
  it('returns empty array when no installer has the old toolkit', () => {
    const exec = () => 'some-pkg  1.0.0';
    expect(detectOldToolkit(exec)).toEqual([]);
  });

  it('returns single match for pip only', () => {
    const exec = (cmd: string) => {
      if (cmd === 'pip list') return 'bedrock-agentcore-starter-toolkit  0.1.0';
      return 'clean-output';
    };
    const result = detectOldToolkit(exec);
    expect(result).toHaveLength(1);
    expect(result[0]!.installer).toBe('pip');
  });

  it('returns single match for pipx only', () => {
    const exec = (cmd: string) => {
      if (cmd === 'pipx list') return 'bedrock-agentcore-starter-toolkit  0.1.0';
      return 'clean-output';
    };
    const result = detectOldToolkit(exec);
    expect(result).toHaveLength(1);
    expect(result[0]!.installer).toBe('pipx');
  });

  it('returns single match for uv only', () => {
    const exec = (cmd: string) => {
      if (cmd === 'uv tool list') return 'bedrock-agentcore-starter-toolkit  0.1.0';
      return 'clean-output';
    };
    const result = detectOldToolkit(exec);
    expect(result).toHaveLength(1);
    expect(result[0]!.installer).toBe('uv');
  });

  it('returns multiple matches when installed via pip and pipx', () => {
    const exec = () => 'bedrock-agentcore-starter-toolkit  0.1.0';
    const result = detectOldToolkit(exec);
    expect(result).toHaveLength(3);
  });

  it('handles mixed results: one found, one missing command, one clean', () => {
    const exec = (cmd: string) => {
      if (cmd === 'pip list') return 'bedrock-agentcore-starter-toolkit  0.1.0';
      if (cmd === 'pipx list') throw new Error('command not found');
      return 'clean-output';
    };
    const result = detectOldToolkit(exec);
    expect(result).toHaveLength(1);
    expect(result[0]!.installer).toBe('pip');
  });

  it('falls back to PATH detection when no package manager finds the toolkit', () => {
    const exec = (cmd: string) => {
      // All package-manager list commands return clean output
      if (cmd.includes('list')) return 'clean-output';
      // PATH check: binary exists but --version fails
      if (cmd === 'command -v agentcore') return '/usr/local/bin/agentcore';
      if (cmd === 'agentcore --version') throw new Error('exit code 1');
      return '';
    };
    const result = detectOldToolkit(exec);
    expect(result).toHaveLength(1);
    expect(result[0]!.installer).toBe('PATH');
  });

  it('skips PATH fallback when a package manager already found the toolkit', () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'pip list') return 'bedrock-agentcore-starter-toolkit  0.1.0';
      return 'clean-output';
    };
    const result = detectOldToolkit(exec);
    expect(result).toHaveLength(1);
    expect(result[0]!.installer).toBe('pip');
    expect(calls).not.toContain('command -v agentcore');
  });
});

// ---------------------------------------------------------------------------
// formatWarningMessage
// ---------------------------------------------------------------------------
describe('formatWarningMessage', () => {
  it('shows correct uninstall command for a single installer', () => {
    const msg = formatWarningMessage([
      { installer: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
    ]);
    expect(msg).toContain('pip uninstall bedrock-agentcore-starter-toolkit');
    expect(msg).toContain('installed via pip');
  });

  it('shows all uninstall commands for multiple installers', () => {
    const msg = formatWarningMessage([
      { installer: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
      { installer: 'pipx', uninstallCmd: 'pipx uninstall bedrock-agentcore-starter-toolkit' },
    ]);
    expect(msg).toContain('pip uninstall bedrock-agentcore-starter-toolkit');
    expect(msg).toContain('pipx uninstall bedrock-agentcore-starter-toolkit');
  });

  it('contains WARNING in the banner', () => {
    const msg = formatWarningMessage([
      { installer: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
    ]);
    expect(msg).toContain('WARNING');
  });
});

// ---------------------------------------------------------------------------
// Entry-point integration (subprocess)
// ---------------------------------------------------------------------------
describe('check-old-cli.mjs entry point', () => {
  const scriptPath = path.resolve(__dirname, '../../../../scripts/check-old-cli.mjs');

  it('exits 0 when AGENTCORE_SKIP_CONFLICT_CHECK=1', () => {
    execSync(`node ${scriptPath}`, {
      env: { ...process.env, AGENTCORE_SKIP_CONFLICT_CHECK: '1' },
      stdio: 'pipe',
    });
  });

  it('exits 0 even when old toolkit is detected (warning only)', () => {
    // The postinstall hook should never exit non-zero.
    // On a clean machine this just runs and exits 0.
    // We verify the script doesn't throw by running it directly.
    execSync(`node ${scriptPath}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  });
});
