import { readFileSync } from 'node:fs';
import * as path from 'node:path';

function resolveCdkPin(): string {
  const raw = readFileSync(path.resolve(__dirname, '../../../assets/cdk/package.json'), 'utf-8');
  const pin = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies?.['@aws/agentcore-cdk'];
  if (!pin) {
    throw new Error('vended CDK template is missing its @aws/agentcore-cdk pin');
  }
  return pin;
}

export const CDK_PIN = resolveCdkPin();

export function newerPrerelease(pin: string, by = 2): string {
  const match = /^(.*-[A-Za-z]+\.)(\d+)$/.exec(pin);
  if (!match) {
    throw new Error(`cannot derive a newer prerelease from non-prerelease pin: ${pin}`);
  }
  return `${match[1]}${Number(match[2]) + by}`;
}
