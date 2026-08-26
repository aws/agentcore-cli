#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const CDK_PACKAGE = '@aws/agentcore-cdk';
const TEMPLATE_PATH = path.resolve(__dirname, '../src/assets/cdk/package.json');

function getFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function resolveTargetVersion(): string {
  const explicit = getFlagValue('--to');
  if (explicit) {
    return explicit;
  }
  const tag = getFlagValue('--tag') ?? 'latest';
  const version = execFileSync('npm', ['view', `${CDK_PACKAGE}@${tag}`, 'version'], { encoding: 'utf-8' }).trim();
  if (!version) {
    throw new Error(`could not resolve ${CDK_PACKAGE}@${tag} from npm`);
  }
  return version;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const target = resolveTargetVersion();

  const pkg = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf-8')) as { dependencies: Record<string, string> };
  const current = pkg.dependencies[CDK_PACKAGE];

  if (current === target) {
    console.log(`${CDK_PACKAGE} already pinned to ${target} — no change`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] ${CDK_PACKAGE}: ${current} -> ${target}`);
    return;
  }

  pkg.dependencies[CDK_PACKAGE] = target;
  writeFileSync(TEMPLATE_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${CDK_PACKAGE}: ${current} -> ${target}`);
}

main();
