import { ENV_FILE } from './constants';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export default async function globalTeardown() {
  if (!existsSync(ENV_FILE)) return;

  const raw = readFileSync(ENV_FILE, 'utf-8');

  const serverPid = raw.match(/^SERVER_PID=(.+)$/m)?.[1];
  if (serverPid) {
    try {
      process.kill(Number(serverPid), 'SIGTERM');
      console.log(`\nStopped dev server (PID ${serverPid})`);
    } catch {
      // Process already exited
    }
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
  }

  const projectPath = raw.match(/^PROJECT_PATH=(.+)$/m)?.[1];
  const testDir = raw.match(/^TEST_DIR=(.+)$/m)?.[1];

  if (projectPath) {
    const logsDir = join(projectPath, 'agentcore', '.cli', 'logs');
    const outputDir = join(__dirname, 'test-results', 'dev-server-logs');
    if (existsSync(logsDir)) {
      mkdirSync(outputDir, { recursive: true });
      cpSync(logsDir, outputDir, { recursive: true });
    }
  }

  if (testDir && existsSync(testDir)) {
    console.log(`Cleaning up ${testDir}`);
    rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }

  unlinkSync(ENV_FILE);
}
