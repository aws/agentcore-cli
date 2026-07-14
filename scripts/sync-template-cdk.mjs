/**
 * Syncs the aws-cdk-lib version across the three places that must stay in
 * lockstep (enforced by src/assets/__tests__/cdk-schema-compat.test.ts):
 *
 *   1. node_modules/aws-cdk-lib          — source of truth (whatever npm resolved)
 *   2. package.json devDependencies      — the lockstep anchor
 *   3. src/assets/cdk/package.json       — the template vended to user projects
 *
 * The template pin controls the cloud-assembly schema version fresh user
 * projects write; the CLI's bundled toolkit-lib/cdk-assets-lib readers must
 * be able to read it, or `agentcore deploy` fails with AssemblyVersionMismatch.
 *
 * Typical use on a Dependabot aws-cdk bump PR:
 *
 *   npm ci && node scripts/sync-template-cdk.mjs
 *
 * Pass --no-snapshots to skip the asset-snapshot regeneration step.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.join(__dirname, '..');
const installedPkgPath = path.join(repoRoot, 'node_modules', 'aws-cdk-lib', 'package.json');
const rootPkgPath = path.join(repoRoot, 'package.json');
const templatePkgPath = path.join(repoRoot, 'src', 'assets', 'cdk', 'package.json');

/**
 * Rewrite the aws-cdk-lib version specifier in a package.json section via
 * targeted string replacement, preserving the file's existing formatting.
 * @param {string} filePath - package.json to rewrite
 * @param {'dependencies' | 'devDependencies'} section - section holding aws-cdk-lib
 * @param {string} version - exact version to pin
 * @returns {boolean} whether the file changed
 */
function pinAwsCdkLib(filePath, section, version) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const pkg = JSON.parse(content);
  const current = pkg[section]?.['aws-cdk-lib'];
  if (current === undefined) {
    console.error(`Error: ${filePath} has no aws-cdk-lib in ${section}.`);
    process.exit(1);
  }
  if (current === version) {
    return false;
  }
  const updated = content.replace(`"aws-cdk-lib": "${current}"`, `"aws-cdk-lib": "${version}"`);
  if (updated === content) {
    console.error(`Error: could not rewrite aws-cdk-lib specifier "${current}" in ${filePath}.`);
    process.exit(1);
  }
  fs.writeFileSync(filePath, updated);
  return true;
}

if (!fs.existsSync(installedPkgPath)) {
  console.error('Error: aws-cdk-lib is not installed. Run "npm ci" first.');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8')).version;
console.log(`Installed aws-cdk-lib: ${version}`);

const rootChanged = pinAwsCdkLib(rootPkgPath, 'devDependencies', version);
console.log(rootChanged ? `Updated package.json devDependency to ${version}` : 'package.json already in sync');

const templateChanged = pinAwsCdkLib(templatePkgPath, 'dependencies', version);
console.log(templateChanged ? `Updated src/assets/cdk/package.json pin to ${version}` : 'Template already in sync');

if (rootChanged) {
  console.log('Note: package.json changed — run "npm install" to update npm-shrinkwrap.json, and commit both.');
}

if (templateChanged) {
  if (process.argv.includes('--no-snapshots')) {
    console.log('Skipping snapshot update (--no-snapshots). Run "npm run test:update-snapshots" before committing.');
  } else {
    console.log('Regenerating asset snapshots...');
    const result = spawnSync('npm', ['run', 'test:update-snapshots'], { cwd: repoRoot, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('Error: snapshot update failed.');
      process.exit(1);
    }
  }
}

console.log(rootChanged || templateChanged ? 'Sync complete.' : 'Everything already in sync — nothing to do.');
