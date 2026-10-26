import { runSubprocess } from '../../../lib/utils/subprocess';
import { PACKAGE_VERSION, getDistroConfig } from '../../constants';

const distroConfig = getDistroConfig();

export async function fetchLatestVersion(): Promise<string> {
  const registryUrl = `${distroConfig.registryUrl}/${distroConfig.packageName}/latest`;
  const response = await fetch(registryUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch latest version: ${response.statusText}`);
  }
  const data = (await response.json()) as { version: string };
  return data.version;
}

export function compareVersions(current: string, latest: string): number {
  const parse = (v: string) => {
    const [core = '', ...prereleaseParts] = v.split('-');
    const nums = core.split('.').map(Number);
    const prerelease = prereleaseParts.join('-');
    return { nums, prerelease };
  };

  const curr = parse(current);
  const lat = parse(latest);

  // Compare major.minor.patch
  for (let i = 0; i < 3; i++) {
    const c = curr.nums[i] ?? 0;
    const l = lat.nums[i] ?? 0;
    if (l > c) return 1;
    if (l < c) return -1;
  }

  // Equal core versions — compare pre-release segments
  if (!curr.prerelease && !lat.prerelease) return 0;
  // A version without pre-release is greater than one with (1.0.0 > 1.0.0-preview)
  if (!curr.prerelease) return -1;
  if (!lat.prerelease) return 1;

  const currSegments = curr.prerelease.split('.');
  const latSegments = lat.prerelease.split('.');
  const len = Math.max(currSegments.length, latSegments.length);

  for (let i = 0; i < len; i++) {
    const cs = currSegments[i];
    const ls = latSegments[i];
    if (cs === undefined) return 1; // fewer segments = earlier
    if (ls === undefined) return -1;
    const cn = Number(cs);
    const ln = Number(ls);
    // Both numeric — compare numerically
    if (!isNaN(cn) && !isNaN(ln)) {
      if (ln > cn) return 1;
      if (ln < cn) return -1;
    } else {
      // Lexicographic comparison for non-numeric segments
      if (ls > cs) return 1;
      if (ls < cs) return -1;
    }
  }

  return 0;
}

export type UpdateStatus = 'up-to-date' | 'newer-local' | 'update-available' | 'updated' | 'update-failed';

export interface UpdateResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string;
}

export async function handleUpdate(checkOnly: boolean): Promise<UpdateResult> {
  const latestVersion = await fetchLatestVersion();
  const comparison = compareVersions(PACKAGE_VERSION, latestVersion);

  if (comparison === 0) {
    return { status: 'up-to-date', currentVersion: PACKAGE_VERSION, latestVersion };
  }

  if (comparison < 0) {
    return { status: 'newer-local', currentVersion: PACKAGE_VERSION, latestVersion };
  }

  if (checkOnly) {
    return { status: 'update-available', currentVersion: PACKAGE_VERSION, latestVersion };
  }

  try {
    const [installBinary, ...installArgs] = distroConfig.installCommand.trim().split(/\s+/);
    await runSubprocess(installBinary!, installArgs, { stdio: 'inherit' });
    return { status: 'updated', currentVersion: PACKAGE_VERSION, latestVersion };
  } catch {
    return { status: 'update-failed', currentVersion: PACKAGE_VERSION, latestVersion };
  }
}
