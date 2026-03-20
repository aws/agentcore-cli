import {
  detectOldToolkit,
  formatErrorMessage,
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
// formatErrorMessage
// ---------------------------------------------------------------------------
describe('formatErrorMessage', () => {
  it('shows correct uninstall command for a single installer', () => {
    const msg = formatErrorMessage([
      { installer: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
    ]);
    expect(msg).toContain('pip uninstall bedrock-agentcore-starter-toolkit');
    expect(msg).toContain('installed via pip');
  });

  it('shows all uninstall commands for multiple installers', () => {
    const msg = formatErrorMessage([
      { installer: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
      { installer: 'pipx', uninstallCmd: 'pipx uninstall bedrock-agentcore-starter-toolkit' },
    ]);
    expect(msg).toContain('pip uninstall bedrock-agentcore-starter-toolkit');
    expect(msg).toContain('pipx uninstall bedrock-agentcore-starter-toolkit');
  });

  it('contains bypass env var instruction', () => {
    const msg = formatErrorMessage([
      { installer: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
    ]);
    expect(msg).toContain('AGENTCORE_SKIP_CONFLICT_CHECK=1');
  });

  it('contains re-run instruction', () => {
    const msg = formatErrorMessage([
      { installer: 'pip', uninstallCmd: 'pip uninstall bedrock-agentcore-starter-toolkit' },
    ]);
    expect(msg).toContain('npm install -g @aws/agentcore');
  });
});

// ---------------------------------------------------------------------------
// Entry-point integration (subprocess)
// ---------------------------------------------------------------------------
describe('check-old-cli.mjs entry point', () => {
  const scriptPath = path.resolve(__dirname, '../../../../scripts/check-old-cli.mjs');

  it('exits 0 when AGENTCORE_SKIP_CONFLICT_CHECK=1', () => {
    // Should not throw (exit code 0)
    execSync(`node ${scriptPath}`, {
      env: { ...process.env, AGENTCORE_SKIP_CONFLICT_CHECK: '1' },
      stdio: 'pipe',
    });
  });

  it('exits 1 with error when old toolkit is detected', () => {
    // If the old toolkit happens to be installed, verify exit 1 + stderr message.
    // If not installed, verify exit 0 silently.
    try {
      execSync(`node ${scriptPath}`, {
        env: { ...process.env, AGENTCORE_SKIP_CONFLICT_CHECK: undefined },
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      // Exited 0 — old toolkit not present, that's fine
    } catch (err: any) {
      // Exited non-zero — old toolkit was detected
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('bedrock-agentcore-starter-toolkit');
      expect(err.stderr).toContain('AGENTCORE_SKIP_CONFLICT_CHECK');
    }
  });
});
