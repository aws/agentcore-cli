/**
 * bundle.mjs — Single command to build CLI + CDK constructs into one tarball.
 *
 * This is a testing-only workflow. It does NOT modify the default build or
 * deployment flow. The normal `npm run build` + `npm pack` pipeline is unchanged.
 *
 * What this script does differently: after building both packages normally, it
 * packs the CDK constructs into a tarball and places it in the CLI's dist/assets/.
 * At `agentcore create` time, CDKRenderer detects this tarball and installs it
 * after the normal `npm install`, overriding the registry version.
 *
 * Usage:
 *   node scripts/bundle.mjs
 *   npm run bundle
 *
 * Environment variables:
 *   AGENTCORE_CDK_PATH              — path to the agentcore-l3-cdk-constructs repo.
 *                                     Falls back to ../agentcore-l3-cdk-constructs, then clones from GitHub.
 *   AGENTCORE_INSPECTOR_PATH         — path to the agent-inspector repo.
 *                                     Falls back to ../agent-inspector. If found, builds and bundles
 *                                     the local version instead of the npm-installed one.
 *   AGENTCORE_TARBALL_OUTPUT        — output path (without .tgz) for the tarball. Relative to cwd.
 *   AGENTCORE_TARBALL_VERSION_SUFFIX — version prerelease suffix (e.g. "abc12-def34").
 *                                     Defaults to a timestamp if not set.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, '..');

const CDK_REPO_URL = 'https://github.com/aws/agentcore-l3-cdk-constructs.git';

function log(msg) {
  console.log(`\n[bundle] ${msg}`);
}

function run(cmd, args = [], opts = {}) {
  const display = [cmd, ...args].join(' ');
  console.log(`  > ${display}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

/**
 * Resolve the CDK constructs repo path. Priority:
 * 1. AGENTCORE_CDK_PATH env var
 * 2. Sibling directory ../agentcore-l3-cdk-constructs
 * 3. Clone from GitHub into a temp directory under the CLI repo
 */
function resolveCdkPath() {
  // 1. Env var
  if (process.env.AGENTCORE_CDK_PATH) {
    const p = path.resolve(process.env.AGENTCORE_CDK_PATH);
    if (fs.existsSync(path.join(p, 'package.json'))) {
      log(`Using CDK constructs from AGENTCORE_CDK_PATH: ${p}`);
      return p;
    }
    console.warn(`  WARNING: AGENTCORE_CDK_PATH=${p} does not contain package.json, ignoring.`);
  }

  // 2. Sibling directory
  const sibling = path.resolve(cliRoot, '..', 'agentcore-l3-cdk-constructs');
  if (fs.existsSync(path.join(sibling, 'package.json'))) {
    log(`Using CDK constructs from sibling directory: ${sibling}`);
    return sibling;
  }

  // 3. Clone latest from GitHub
  const cloneDir = path.join(cliRoot, '.cdk-constructs-clone');
  log(`CDK constructs repo not found locally. Cloning latest from GitHub...`);

  if (fs.existsSync(cloneDir)) {
    log('Pulling latest changes...');
    run('git', ['pull', 'origin', 'main'], { cwd: cloneDir });
  } else {
    run('git', ['clone', '--depth', '1', CDK_REPO_URL, cloneDir]);
  }

  return cloneDir;
}

/**
 * Resolve a local agent-inspector repo path. Priority:
 * 1. AGENTCORE_INSPECTOR_PATH env var
 * 2. Sibling directory ../agent-inspector
 * 3. null (use npm-installed version)
 */
function resolveInspectorPath() {
  if (process.env.AGENTCORE_INSPECTOR_PATH) {
    const p = path.resolve(process.env.AGENTCORE_INSPECTOR_PATH);
    if (fs.existsSync(path.join(p, 'package.json'))) {
      log(`Using agent-inspector from AGENTCORE_INSPECTOR_PATH: ${p}`);
      return p;
    }
    console.warn(`  WARNING: AGENTCORE_INSPECTOR_PATH=${p} does not contain package.json, ignoring.`);
  }

  const sibling = path.resolve(cliRoot, '..', 'agent-inspector');
  if (fs.existsSync(path.join(sibling, 'package.json'))) {
    log(`Using agent-inspector from sibling directory: ${sibling}`);
    return sibling;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log('Starting bundle process...');

const now = new Date();
const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const versionSuffix = process.env.AGENTCORE_TARBALL_VERSION_SUFFIX || timestamp;
if (!/^[\w.-]+$/.test(versionSuffix)) {
  console.error(`ERROR: Invalid version suffix: ${versionSuffix}`);
  process.exit(1);
}
log(`Bundle version suffix: ${versionSuffix}`);

// Helper to bump a package version with a unique e2e timestamp tag.
// Saves the original version so it can be restored after packing.
function bumpVersion(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const originalVersion = pkg.version;
  const baseVersion = originalVersion.split('-')[0];
  const prerelease = originalVersion.includes('-') ? originalVersion.split('-').slice(1).join('-') : '';
  const tag = prerelease ? `${prerelease}-${versionSuffix}` : versionSuffix;
  pkg.version = `${baseVersion}-${tag}`;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  log(`Bumped ${pkg.name} version: ${originalVersion} -> ${pkg.version}`);
  return { pkgJsonPath, originalVersion, bumpedVersion: pkg.version };
}

function restoreVersion({ pkgJsonPath, originalVersion }) {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  pkg.version = originalVersion;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * If AGENTCORE_TARBALL_OUTPUT is set, return a resolved path using it as base.
 * Always appends .tgz.
 */
function resolveTarballPath(tarballPath) {
  const envPath = process.env.AGENTCORE_TARBALL_OUTPUT;
  if (!envPath) return tarballPath;
  const base = envPath.replace(/\.tgz$/, '');
  return path.resolve(`${base}.tgz`);
}

// Step 1: Resolve and build CDK constructs
const cdkPath = resolveCdkPath();

log('Installing CDK constructs dependencies...');
run('npm', ['install'], { cwd: cdkPath });

log('Building CDK constructs...');
run('npm', ['run', 'build'], { cwd: cdkPath });

// Step 2: Bump CDK version and pack into a tarball
const cdkVersionInfo = bumpVersion(cdkPath);
try {
  log('Packing CDK constructs...');
  run('npm', ['pack'], { cwd: cdkPath });
} finally {
  restoreVersion(cdkVersionInfo);
}

const cdkTarballName = `aws-agentcore-cdk-${cdkVersionInfo.bumpedVersion}.tgz`;
const cdkTarballSrc = path.join(cdkPath, cdkTarballName);

if (!fs.existsSync(cdkTarballSrc)) {
  console.error(`ERROR: Expected CDK tarball at ${cdkTarballSrc} but not found.`);
  process.exit(1);
}

// Step 3: Build CLI normally (no modifications to copy-assets)
log('Installing CLI dependencies...');
run('npm', ['install'], { cwd: cliRoot });

log('Building CLI...');
run('npm', ['run', 'build'], { cwd: cliRoot });

// Step 3.5: If local agent-inspector is available, build and overwrite dist/agent-inspector/
const inspectorPath = resolveInspectorPath();
if (inspectorPath) {
  log('Installing agent-inspector dependencies...');
  run('npm', ['install'], { cwd: inspectorPath });

  log('Building agent-inspector...');
  run('npm', ['run', 'build'], { cwd: inspectorPath });

  const inspectorDistAssets = path.join(inspectorPath, 'dist-assets');
  if (!fs.existsSync(inspectorDistAssets)) {
    console.error(`ERROR: agent-inspector build did not produce dist-assets/ at ${inspectorDistAssets}`);
    process.exit(1);
  }

  const inspectorDest = path.join(cliRoot, 'dist', 'agent-inspector');
  if (fs.existsSync(inspectorDest)) {
    fs.rmSync(inspectorDest, { recursive: true });
  }
  fs.cpSync(inspectorDistAssets, inspectorDest, { recursive: true });
  log(`Replaced dist/agent-inspector/ with local build from ${inspectorPath}`);
}

// Step 4: Copy CDK tarball into dist/assets/ so CDKRenderer can detect it
const bundledTarballDest = path.join(cliRoot, 'dist', 'assets', 'bundled-agentcore-cdk.tgz');
fs.copyFileSync(cdkTarballSrc, bundledTarballDest);
log(`Placed CDK tarball at ${bundledTarballDest}`);

// Step 5: Bump CLI version and pack into final tarball (includes the bundled CDK tarball)
const cliVersionInfo = bumpVersion(cliRoot);
try {
  log('Packing CLI tarball...');
  run('npm', ['pack'], { cwd: cliRoot });
} finally {
  restoreVersion(cliVersionInfo);
}

const cliTarballName = `aws-agentcore-${cliVersionInfo.bumpedVersion}.tgz`;
const cliTarballPath = path.join(cliRoot, cliTarballName);

if (!fs.existsSync(cliTarballPath)) {
  console.error(`ERROR: Expected tarball at ${cliTarballPath} but not found.`);
  process.exit(1);
}

const finalTarballPath = resolveTarballPath(cliTarballPath);
if (finalTarballPath !== cliTarballPath) {
  fs.mkdirSync(path.dirname(finalTarballPath), { recursive: true });
  fs.renameSync(cliTarballPath, finalTarballPath);
  log(`Renamed tarball to: ${finalTarballPath}`);
}

// Final output
log(`Done! Tarball:   ${finalTarballPath}`);
log(`Install with:    npm install -g ${finalTarballPath}`);
log('When you run agentcore create, the bundled CDK constructs will be installed automatically.');
