import { checkSubprocess, runSubprocessCapture } from '../../../lib';

export type NodeSetupStatus = 'success' | 'npm_not_found' | 'install_failed';

export interface NodeSetupResult {
  status: NodeSetupStatus;
  error?: string;
}

export interface NodeSetupOptions {
  projectDir: string;
}

/**
 * Check if npm is available on the system.
 */
export async function checkNpmAvailable(): Promise<boolean> {
  return checkSubprocess('npm', ['--version']);
}

/**
 * Install dependencies using npm install.
 * Uses `npm install` (not `npm ci`) because fresh scaffolds don't ship a lockfile.
 */
export async function installNodeDependencies(projectDir: string): Promise<NodeSetupResult> {
  const result = await runSubprocessCapture('npm', ['install'], { cwd: projectDir });
  if (result.code === 0) {
    return { status: 'success' };
  }
  return { status: 'install_failed', error: result.stderr || result.stdout };
}

/**
 * Set up a Node.js project: run `npm install`.
 * Returns a result with status and optional error details.
 */
export async function setupNodeProject(options: NodeSetupOptions): Promise<NodeSetupResult> {
  if (process.env.AGENTCORE_SKIP_INSTALL) return { status: 'success' };

  const { projectDir } = options;

  const npmAvailable = await checkNpmAvailable();
  if (!npmAvailable) {
    return {
      status: 'npm_not_found',
      error: "'npm' not found. Install Node.js from https://nodejs.org/",
    };
  }

  return installNodeDependencies(projectDir);
}
