import { ONE_DAY_MS } from '../lib/time-constants.js';
import { compareVersions, fetchLatestVersion } from './commands/update/action.js';
import { PACKAGE_VERSION } from './constants.js';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

function getConfigDir(): string {
  return process.env.AGENTCORE_CONFIG_DIR ?? join(homedir(), '.agentcore');
}

const CHECK_INTERVAL_MS = ONE_DAY_MS;

interface CacheData {
  lastCheck: number;
  latestVersion: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  latestVersion: string;
}

async function readCache(): Promise<CacheData | null> {
  try {
    const data = await readFile(join(getConfigDir(), 'update-check.json'), 'utf-8');
    return JSON.parse(data) as CacheData;
  } catch {
    return null;
  }
}

async function writeCache(data: CacheData): Promise<void> {
  try {
    const dir = getConfigDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'update-check.json'), JSON.stringify(data), 'utf-8');
  } catch {
    // Silently ignore cache write failures
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  try {
    const cache = await readCache();
    const now = Date.now();

    if (cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
      const comparison = compareVersions(PACKAGE_VERSION, cache.latestVersion);
      return {
        updateAvailable: comparison > 0,
        latestVersion: cache.latestVersion,
      };
    }

    const latestVersion = await fetchLatestVersion();
    await writeCache({ lastCheck: now, latestVersion });

    const comparison = compareVersions(PACKAGE_VERSION, latestVersion);
    return {
      updateAvailable: comparison > 0,
      latestVersion,
    };
  } catch {
    return null;
  }
}

export function printUpdateNotification(result: UpdateCheckResult): void {
  const yellow = '\x1b[33m';
  const cyan = '\x1b[36m';
  const reset = '\x1b[0m';

  process.stderr.write(
    `\n${yellow}Update available:${reset} ${PACKAGE_VERSION} → ${cyan}${result.latestVersion}${reset}\n` +
      `Run ${cyan}\`npm install -g @aws/agentcore@latest\`${reset} to update.\n`
  );
}
