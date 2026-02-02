import { runSubprocessCapture } from '../../../lib';
import { writeFile } from 'fs/promises';
import { join } from 'path';

const AGENTCORE_GITIGNORE = `# Secrets (local environment files are never committed)
.env.local

# CDK Build Artifacts
cdk/cdk.out/
cdk/node_modules/

# CLI Internals
.cli/*

# Ephemeral Staging
.cache/*

# Exception: Commit the State
!.cli/deployed-state.json
`;

/**
 * Write the .gitignore file for an agentcore project.
 */
export async function writeGitignore(configBaseDir: string): Promise<void> {
  await writeFile(join(configBaseDir, '.gitignore'), AGENTCORE_GITIGNORE, 'utf-8');
}

/**
 * Write an empty .env.local file for storing secrets.
 */
export async function writeEnvFile(configBaseDir: string): Promise<void> {
  await writeFile(join(configBaseDir, '.env.local'), '', 'utf-8');
}

export interface InitGitRepoResult {
  status: 'success' | 'skipped' | 'error';
  message?: string;
}

/**
 * Initialize a git repository at the project root.
 * Skips if already in a git repo or if git is not available.
 */
export async function initGitRepo(projectRoot: string): Promise<InitGitRepoResult> {
  // All git commands use shell: false to avoid Windows cmd argument parsing issues
  const gitOptions = { cwd: projectRoot, stdio: 'pipe' as const, shell: false };

  // Check if git is available
  const gitCheck = await runSubprocessCapture('git', ['--version'], gitOptions);
  if (gitCheck.code !== 0) {
    return { status: 'skipped', message: 'git not available' };
  }

  // Check if already in a git repo
  const gitStatus = await runSubprocessCapture('git', ['rev-parse', '--is-inside-work-tree'], gitOptions);
  if (gitStatus.code === 0) {
    return { status: 'skipped', message: 'already in a git repository' };
  }

  // Initialize git repo
  const initResult = await runSubprocessCapture('git', ['init'], gitOptions);
  if (initResult.code !== 0) {
    return { status: 'error', message: initResult.stderr || 'git init failed' };
  }

  // Stage all files
  const addResult = await runSubprocessCapture('git', ['add', '.'], gitOptions);
  if (addResult.code !== 0) {
    return { status: 'error', message: addResult.stderr || 'git add failed' };
  }

  // prettier-ignore
  const commitResult = await runSubprocessCapture('git', ['commit', '-m', "Initial commit"], gitOptions);
  if (commitResult.code !== 0) {
    return { status: 'error', message: commitResult.stderr || 'git commit failed' };
  }

  return { status: 'success' };
}
