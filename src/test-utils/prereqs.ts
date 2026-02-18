import { execSync } from 'node:child_process';

/**
 * Check if a command is available on the system PATH.
 */
export function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if AWS credentials are configured and valid.
 */
export function hasAwsCredentials(): boolean {
  try {
    execSync('aws sts get-caller-identity', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-computed prerequisite checks. Evaluated once at module load time.
 */
export const prereqs = {
  npm: hasCommand('npm'),
  git: hasCommand('git'),
  uv: hasCommand('uv'),
};
