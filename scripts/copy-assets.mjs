import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, '..', 'src', 'assets');
const destDir = path.join(__dirname, '..', 'dist', 'assets');

/**
 * Recursively copy directory contents, excluding specified files at root level only
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @param {string[]} excludeAtRoot - Files to exclude only at the root level (e.g., 'AGENTS.md')
 * @param {boolean} isRoot - Whether this is the root level call
 */
function copyDir(src, dest, excludeAtRoot = [], isRoot = true) {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip excluded files only at root level
    if (isRoot && excludeAtRoot.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, excludeAtRoot, false);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Bundle @aws/agentcore-cdk into dist/assets/bundled-agentcore-cdk/
//
// The CDK constructs package is resolved via AGENTCORE_CDK_PATH env var
// (absolute path to the agentcore-l3-cdk-constructs repo root) or defaults
// to a sibling directory ../agentcore-l3-cdk-constructs relative to this repo.
// The package must already be built (npm run build) before running this script.
// ---------------------------------------------------------------------------
function bundleCdkConstructs() {
  const cdkPkgRoot =
    process.env.AGENTCORE_CDK_PATH ||
    path.join(__dirname, '..', '..', 'agentcore-l3-cdk-constructs');

  const cdkDist = path.join(cdkPkgRoot, 'dist');
  const cdkPkgJson = path.join(cdkPkgRoot, 'package.json');

  if (!fs.existsSync(cdkDist) || !fs.existsSync(cdkPkgJson)) {
    console.warn(
      'WARNING: @aws/agentcore-cdk not found or not built at',
      cdkPkgRoot,
      '— skipping CDK constructs bundling. Set AGENTCORE_CDK_PATH to override.',
    );
    return;
  }

  const bundleDir = path.join(destDir, 'bundled-agentcore-cdk');
  fs.mkdirSync(bundleDir, { recursive: true });

  // Copy package.json
  fs.copyFileSync(cdkPkgJson, path.join(bundleDir, 'package.json'));

  // Copy built dist/
  copyDir(cdkDist, path.join(bundleDir, 'dist'), [], true);

  console.log('Bundled @aws/agentcore-cdk into dist/assets/bundled-agentcore-cdk/');
}

try {
  console.log('Copying assets...');
  copyDir(srcDir, destDir, ['AGENTS.md']);
  console.log('Assets copied successfully!');

  bundleCdkConstructs();
} catch (error) {
  console.error('Error copying assets:', error);
  process.exit(1);
}
