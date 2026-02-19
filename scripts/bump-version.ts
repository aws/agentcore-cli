#!/usr/bin/env npx tsx

/**
 * Version bump script for AgentCore CLI
 *
 * Usage:
 *   npx tsx scripts/bump-version.ts <bump_type> [options]
 *
 * Arguments:
 *   bump_type: major | minor | patch | prerelease | preview | preview-major
 *
 * Options:
 *   --changelog <text>     Custom changelog entry
 *   --prerelease-tag <tag> Prerelease identifier (default: beta)
 *   --dry-run              Show what would be done without making changes
 *
 * Preview bumps (internal format):
 *   - 0.3.0 -> 0.3.0-preview.1.0
 *   - 0.3.0-preview.1.0 -> 0.3.0-preview.1.1 (preview)
 *   - 0.3.0-preview.1.0 -> 0.3.0-preview.2.0 (preview-major)
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// ===========================
// Types
// ===========================

type BumpType = 'major' | 'minor' | 'patch' | 'prerelease' | 'preview' | 'preview-major';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  prereleaseNum?: number;
  // For preview format: X.Y.Z-previewN.M
  previewMajor?: number;
  previewMinor?: number;
}

interface PackageJson {
  version: string;
  [key: string]: unknown;
}

interface PackageLockJson {
  version: string;
  packages?: {
    ''?: { version: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ===========================
// Version Parsing & Bumping
// ===========================

function parseVersion(version: string): ParsedVersion {
  // First try to match preview format: X.Y.Z-preview.N.M (e.g., 0.3.0-preview.1.0)
  const previewMatch = /^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)\.(\d+)$/.exec(version);
  if (previewMatch) {
    return {
      major: parseInt(previewMatch[1]!, 10),
      minor: parseInt(previewMatch[2]!, 10),
      patch: parseInt(previewMatch[3]!, 10),
      previewMajor: parseInt(previewMatch[4]!, 10),
      previewMinor: parseInt(previewMatch[5]!, 10),
    };
  }

  // Match standard versions like: 1.2.3, 1.2.3-beta.1, 1.2.3-rc.0
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)\.(\d+))?$/.exec(version);

  if (!match) {
    throw new Error(`Invalid version format: ${version}`);
  }

  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
    prerelease: match[4],
    prereleaseNum: match[5] ? parseInt(match[5], 10) : undefined,
  };
}

function formatVersion(parsed: ParsedVersion): string {
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;

  // Handle preview format: X.Y.Z-preview.N.M
  if (parsed.previewMajor !== undefined && parsed.previewMinor !== undefined) {
    return `${base}-preview.${parsed.previewMajor}.${parsed.previewMinor}`;
  }

  // Handle standard prerelease format: X.Y.Z-tag.N
  if (parsed.prerelease !== undefined && parsed.prereleaseNum !== undefined) {
    return `${base}-${parsed.prerelease}.${parsed.prereleaseNum}`;
  }

  return base;
}

function bumpVersion(current: string, bumpType: BumpType, prereleaseTag = 'beta'): string {
  const parsed = parseVersion(current);

  switch (bumpType) {
    case 'major':
      return formatVersion({
        major: parsed.major + 1,
        minor: 0,
        patch: 0,
      });

    case 'minor':
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor + 1,
        patch: 0,
      });

    case 'patch':
      // If currently a prerelease or preview, just remove the suffix
      if (parsed.prerelease || parsed.previewMajor !== undefined) {
        return formatVersion({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
        });
      }
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
      });

    case 'prerelease':
      // If already a prerelease with same tag, increment the number
      if (parsed.prerelease === prereleaseTag && parsed.prereleaseNum !== undefined) {
        return formatVersion({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          prerelease: prereleaseTag,
          prereleaseNum: parsed.prereleaseNum + 1,
        });
      }
      // Otherwise, bump patch and start new prerelease
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.prerelease ? parsed.patch : parsed.patch + 1,
        prerelease: prereleaseTag,
        prereleaseNum: 0,
      });

    case 'preview':
      // Handle preview format: X.Y.Z-previewN.M
      // If already a preview, increment the minor preview number
      if (parsed.previewMajor !== undefined && parsed.previewMinor !== undefined) {
        return formatVersion({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          previewMajor: parsed.previewMajor,
          previewMinor: parsed.previewMinor + 1,
        });
      }
      // Otherwise, start at preview.1.0
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        previewMajor: 1,
        previewMinor: 0,
      });

    case 'preview-major':
      // Increment the major preview number and reset minor to 0
      if (parsed.previewMajor !== undefined && parsed.previewMinor !== undefined) {
        return formatVersion({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          previewMajor: parsed.previewMajor + 1,
          previewMinor: 0,
        });
      }
      // Otherwise, start at preview.1.0
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        previewMajor: 1,
        previewMinor: 0,
      });

    default: {
      const exhaustiveCheck: never = bumpType;
      throw new Error(`Unknown bump type: ${exhaustiveCheck as string}`);
    }
  }
}

// ===========================
// File Operations
// ===========================

function getCurrentVersion(): string {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as PackageJson;
  return packageJson.version;
}

function updatePackageJson(newVersion: string): void {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as PackageJson;
  packageJson.version = newVersion;
  writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
  console.log('✓ Updated package.json');
}

function updatePackageLockJson(newVersion: string): void {
  if (!existsSync('package-lock.json')) {
    return;
  }

  const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf-8')) as PackageLockJson;
  packageLock.version = newVersion;

  // Also update the root package in packages
  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = newVersion;
  }

  writeFileSync('package-lock.json', JSON.stringify(packageLock, null, 2) + '\n');
  console.log('✓ Updated package-lock.json');
}

// ===========================
// Git Log & Changelog
// ===========================

function getGitLog(sinceTag?: string): string {
  try {
    let cmd = 'git log --pretty=format:"- %s (%h)"';

    if (sinceTag) {
      cmd += ` ${sinceTag}..HEAD`;
    } else {
      // Try to get the last tag
      try {
        const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf-8' }).trim();
        cmd += ` ${lastTag}..HEAD`;
      } catch {
        // No tags exist, get last 20 commits
        cmd += ' -n 20';
      }
    }

    return execSync(cmd, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

interface CategorizedChanges {
  features: string[];
  fixes: string[];
  docs: string[];
  other: string[];
}

function categorizeCommits(gitLog: string): CategorizedChanges {
  const result: CategorizedChanges = {
    features: [],
    fixes: [],
    docs: [],
    other: [],
  };

  for (const line of gitLog.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed?.startsWith('-')) continue;

    const msg = trimmed.slice(2).trim();

    if (msg.startsWith('feat:') || msg.startsWith('feature:')) {
      result.features.push(msg);
    } else if (msg.startsWith('fix:') || msg.startsWith('bugfix:')) {
      result.fixes.push(msg);
    } else if (msg.startsWith('docs:') || msg.startsWith('doc:')) {
      result.docs.push(msg);
    } else {
      result.other.push(msg);
    }
  }

  return result;
}

function formatChangelog(changes: CategorizedChanges): string {
  const sections: string[] = [];

  if (changes.features.length > 0) {
    sections.push('### Added\n' + changes.features.map(m => `- ${m}`).join('\n'));
  }

  if (changes.fixes.length > 0) {
    sections.push('### Fixed\n' + changes.fixes.map(m => `- ${m}`).join('\n'));
  }

  if (changes.docs.length > 0) {
    sections.push('### Documentation\n' + changes.docs.map(m => `- ${m}`).join('\n'));
  }

  if (changes.other.length > 0) {
    sections.push('### Other Changes\n' + changes.other.map(m => `- ${m}`).join('\n'));
  }

  return sections.join('\n\n');
}

function updateChangelog(newVersion: string, customChanges?: string): void {
  const changelogPath = 'CHANGELOG.md';
  const date = new Date().toISOString().split('T')[0];

  // Build the new entry
  let entryContent = '';
  if (customChanges) {
    entryContent = `### Changes\n\n${customChanges}`;
  } else {
    console.log('\n⚠️  No changelog provided. Auto-generating from commits.');
    console.log('💡 Tip: Use --changelog to provide meaningful release notes');

    const gitLog = getGitLog();
    if (gitLog) {
      const categorized = categorizeCommits(gitLog);
      const formatted = formatChangelog(categorized);
      entryContent = formatted || `### Changes\n\n${gitLog}`;
    }
  }

  const entry = `## [${newVersion}] - ${date}\n\n${entryContent}`;

  let content: string;
  if (existsSync(changelogPath)) {
    content = readFileSync(changelogPath, 'utf-8');

    // Find where to insert (after # Changelog header line)
    const lines = content.split('\n');
    const headerIndex = lines.findIndex(line => line.startsWith('# Changelog'));

    if (headerIndex !== -1) {
      // Find the next ## or end of preamble (first non-empty line after a blank line)
      let insertAt = headerIndex + 1;

      // Skip blank lines and description text until we hit an existing ## or end
      while (insertAt < lines.length && !lines[insertAt]?.startsWith('## ')) {
        insertAt++;
      }

      // Insert the new entry
      lines.splice(insertAt, 0, '', entry, '');
      content = lines.join('\n');
    } else {
      // No header found, prepend everything
      content = `# Changelog\n\n${entry}\n\n${content}`;
    }
  } else {
    content = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n${entry}\n`;
  }

  // Clean up multiple consecutive blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  // Ensure single trailing newline
  content = content.trimEnd() + '\n';

  writeFileSync(changelogPath, content);
  console.log('✓ Updated CHANGELOG.md');
}

// ===========================
// CLI
// ===========================

function parseArgs(): { bumpType: BumpType; changelog?: string; prereleaseTag: string; dryRun: boolean } {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage: npx tsx scripts/bump-version.ts <bump_type> [options]

Arguments:
  bump_type: major | minor | patch | prerelease | preview | preview-major

Options:
  --changelog <text>        Custom changelog entry
  --prerelease-tag <tag>    Prerelease identifier (default: beta)
  --dry-run                 Show what would be done without making changes
  --help, -h                Show this help message

Preview bumps:
  - 0.3.0 -> 0.3.0-preview.1.0
  - 0.3.0-preview.1.0 -> 0.3.0-preview.1.1  (preview)
  - 0.3.0-preview.1.0 -> 0.3.0-preview.2.0  (preview-major)
`);
    process.exit(0);
  }

  const bumpType = args[0] as BumpType;
  if (!['major', 'minor', 'patch', 'prerelease', 'preview', 'preview-major'].includes(bumpType)) {
    console.error(
      `Error: Invalid bump type '${bumpType}'. Must be one of: major, minor, patch, prerelease, preview, preview-major`
    );
    process.exit(1);
  }

  let changelog: string | undefined;
  let prereleaseTag = 'beta';
  let dryRun = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--changelog' && args[i + 1]) {
      changelog = args[++i];
    } else if (args[i] === '--prerelease-tag' && args[i + 1]) {
      prereleaseTag = args[++i]!;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { bumpType, changelog, prereleaseTag, dryRun };
}

function main(): void {
  const { bumpType, changelog, prereleaseTag, dryRun } = parseArgs();

  try {
    const currentVersion = getCurrentVersion();
    const newVersion = bumpVersion(currentVersion, bumpType, prereleaseTag);

    console.log(`Current version: ${currentVersion}`);
    console.log(`New version: ${newVersion}`);

    if (dryRun) {
      console.log('\nDry run - no changes made');
      return;
    }

    updatePackageJson(newVersion);
    updatePackageLockJson(newVersion);
    updateChangelog(newVersion, changelog);

    console.log(`\n✓ Version bumped from ${currentVersion} to ${newVersion}`);
    console.log('\nNext steps:');
    console.log('1. Review changes: git diff');
    console.log(`2. Commit: git add -A && git commit -m 'chore: bump version to ${newVersion}'`);
    console.log('3. Create PR or push to trigger release workflow');
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
