/**
 * bundle.mjs — Single command to build CLI + CDK constructs into one tarball.
 *
 * Usage:
 *   node scripts/bundle.mjs
 *
 * Behavior:
 *   1. Locates @aws/agentcore-cdk via AGENTCORE_CDK_PATH, sibling directory,
 *      or clones the latest from GitHub.
 *   2. Installs and builds the CDK constructs.
 *   3. Installs and builds the CLI (which auto-bundles CDK constructs via copy-assets).
 *   4. Runs npm pack to produce the final tarball.
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

// Export for copy-assets.mjs to pick up
process.env.AGENTCORE_CDK_PATH = cdkPath;

// Step 2: Build CLI (copy-assets will bundle the CDK constructs)
log('Installing CLI dependencies...');
run('npm install', { cwd: cliRoot });

log('Building CLI...');
run('npm run build', { cwd: cliRoot });

// Step 3: Pack into tarball
log('Packing tarball...');
run('npm pack', { cwd: cliRoot });

// Find the tarball
const pkg = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'));
const tarballName = `aws-agentcore-${pkg.version}.tgz`;
const tarballPath = path.join(cliRoot, tarballName);

if (fs.existsSync(tarballPath)) {
  log(`Done! Tarball: ${tarballPath}`);
  log(`Install with: npm install ${tarballPath}`);
} else {
  log(`Done! Check ${cliRoot} for the .tgz file.`);
}
