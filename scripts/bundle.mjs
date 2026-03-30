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
 *   AGENTCORE_CDK_PATH — absolute path to the agentcore-l3-cdk-constructs repo
 */
import { execSync } from 'node:child_process';
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

function run(cmd, opts = {}) {
  console.log(`  > ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
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
    run('git pull', { cwd: cloneDir });
  } else {
    run(`git clone --depth 1 ${CDK_REPO_URL} ${cloneDir}`);
  }

  return cloneDir;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log('Starting bundle process...');

// Step 1: Resolve and build CDK constructs
const cdkPath = resolveCdkPath();

log('Installing CDK constructs dependencies...');
run('npm install', { cwd: cdkPath });

log('Building CDK constructs...');
run('npm run build', { cwd: cdkPath });

// Step 2: Pack CDK constructs into a tarball
log('Packing CDK constructs...');
run('npm pack', { cwd: cdkPath });

// Find the CDK tarball (npm pack outputs the filename on the last line)
const cdkPkg = JSON.parse(fs.readFileSync(path.join(cdkPath, 'package.json'), 'utf8'));
const cdkTarballName = `aws-agentcore-cdk-${cdkPkg.version}.tgz`;
const cdkTarballSrc = path.join(cdkPath, cdkTarballName);

if (!fs.existsSync(cdkTarballSrc)) {
  console.error(`ERROR: Expected CDK tarball at ${cdkTarballSrc} but not found.`);
  process.exit(1);
}

// Step 3: Build CLI normally (no modifications to copy-assets)
log('Installing CLI dependencies...');
run('npm install', { cwd: cliRoot });

log('Building CLI...');
run('npm run build', { cwd: cliRoot });

// Step 4: Copy CDK tarball into dist/assets/ so CDKRenderer can detect it
const bundledTarballDest = path.join(cliRoot, 'dist', 'assets', 'bundled-agentcore-cdk.tgz');
fs.copyFileSync(cdkTarballSrc, bundledTarballDest);
log(`Placed CDK tarball at ${bundledTarballDest}`);

// Step 5: Pack CLI into final tarball (includes the bundled CDK tarball)
log('Packing CLI tarball...');
run('npm pack', { cwd: cliRoot });

const cliPkg = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'));
const cliTarballName = `aws-agentcore-${cliPkg.version}.tgz`;
const cliTarballPath = path.join(cliRoot, cliTarballName);

if (fs.existsSync(cliTarballPath)) {
  log(`Done! Tarball: ${cliTarballPath}`);
  log(`Install with: npm install ${cliTarballPath}`);
  log('When you run agentcore create, the bundled CDK constructs will be installed automatically.');
} else {
  log(`Done! Check ${cliRoot} for the .tgz file.`);
}
