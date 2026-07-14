/**
 * Guards against cloud-assembly schema drift between the vended CDK template
 * and the CLI's bundled readers (@aws-cdk/toolkit-lib, @aws-cdk/cdk-assets-lib).
 *
 * The template's aws-cdk-lib determines the schema version a user project
 * *writes*; the bundled readers determine the schema version the CLI can
 * *read* during deploy. Readers accept older schemas but hard-fail on newer
 * ones (AssemblyVersionMismatch), so the template pin must never emit a
 * schema newer than the readers support. See ticket V2240408418 for the
 * outage this prevents.
 *
 * If any test here fails after a dependency bump, run:
 *
 *   node scripts/sync-template-cdk.mjs
 */
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const HOW_TO_FIX = 'Run `node scripts/sync-template-cdk.mjs` to re-sync the template pin and snapshots.';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const READERS = ['@aws-cdk/toolkit-lib', '@aws-cdk/cdk-assets-lib'];

const requireFromRoot = createRequire(path.join(REPO_ROOT, 'package.json'));

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

const templatePkg = readJson(path.join(REPO_ROOT, 'src/assets/cdk/package.json'));
const rootPkg = readJson(path.join(REPO_ROOT, 'package.json'));
const templatePin: string = templatePkg.dependencies['aws-cdk-lib'];

/**
 * Max cloud-assembly schema major a reader supports. Manifest.version()
 * returns `${revision}.0.0` from schema/version.json in the schema copy the
 * reader resolves, and validation rejects manifests with a greater major.
 * Resolving per-reader handles nested/deduped schema copies in node_modules.
 */
function readerMaxSchemaMajor(readerName: string): number {
  const readerPkgJsonPath = requireFromRoot.resolve(`${readerName}/package.json`);
  const requireFromReader = createRequire(readerPkgJsonPath);
  const schemaPkgJsonPath = requireFromReader.resolve('@aws-cdk/cloud-assembly-schema/package.json');
  const versionJson = readJson(path.join(path.dirname(schemaPkgJsonPath), 'schema', 'version.json'));
  return versionJson.revision;
}

/**
 * Cloud-assembly schema major that the pinned aws-cdk-lib writes in a fresh
 * user project. aws-cdk-lib declares @aws-cdk/cloud-assembly-schema with a
 * caret range, which fixes the major — the only component that matters for
 * reader compatibility.
 */
function emittedSchemaMajor(): number {
  const cdkLibPkg = readJson(requireFromRoot.resolve('aws-cdk-lib/package.json'));
  const range: string = cdkLibPkg.dependencies['@aws-cdk/cloud-assembly-schema'];
  const match = /^\^(\d+)\./.exec(range);
  if (!match) {
    throw new Error(
      `aws-cdk-lib's @aws-cdk/cloud-assembly-schema range "${range}" is not caret-style; ` +
        `this test's major-version parsing is no longer sound and must be updated.`
    );
  }
  return Number(match[1]);
}

describe('vended CDK template / bundled cloud-assembly reader compatibility', () => {
  it('template exact-pins aws-cdk-lib', () => {
    expect(templatePin, `Template must exact-pin aws-cdk-lib, got "${templatePin}". ${HOW_TO_FIX}`).toMatch(
      EXACT_VERSION
    );
  });

  it('root devDependency is exact and in lockstep with the template pin', () => {
    const rootDevDep = rootPkg.devDependencies['aws-cdk-lib'];
    expect(
      rootDevDep,
      `Root devDependency aws-cdk-lib ("${rootDevDep}") must equal the template pin ("${templatePin}"). ${HOW_TO_FIX}`
    ).toBe(templatePin);
  });

  it('installed aws-cdk-lib matches the template pin', () => {
    const installed = readJson(requireFromRoot.resolve('aws-cdk-lib/package.json')).version;
    expect(
      installed,
      `Installed aws-cdk-lib (${installed}) does not match the template pin (${templatePin}) — ` +
        `node_modules may be stale; run \`npm ci\`. ${HOW_TO_FIX}`
    ).toBe(templatePin);
  });

  it.each(READERS)('%s can read cloud assemblies written by the pinned aws-cdk-lib', reader => {
    const readerMajor = readerMaxSchemaMajor(reader);
    const emitted = emittedSchemaMajor();
    expect(
      readerMajor,
      `aws-cdk-lib@${templatePin} writes cloud-assembly schema v${emitted}, but ${reader} reads only up to ` +
        `v${readerMajor}. Fresh projects would fail \`agentcore deploy\` with AssemblyVersionMismatch. ` +
        `Bump ${reader} (npm install) or pin aws-cdk-lib to an older version, then run the sync script. ${HOW_TO_FIX}`
    ).toBeGreaterThanOrEqual(emitted);
  });
});
