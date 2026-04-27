import { partition } from '@aws-sdk/util-endpoints';

const CONSOLE_DOMAINS: Record<string, string> = {
  'aws-us-gov': 'console.amazonaws-us-gov.com',
  'aws-cn': 'console.amazonaws.cn',
};

const DEFAULT_CONSOLE_DOMAIN = 'console.aws.amazon.com';

export function getPartition(region: string): string {
  return partition(region).name;
}

export function arnPrefix(region: string): string {
  return `arn:${getPartition(region)}`;
}

export function dnsSuffix(region: string): string {
  return partition(region).dnsSuffix;
}

export function serviceEndpoint(service: string, region: string): string {
  return `${service}.${region}.${dnsSuffix(region)}`;
}

export function consoleDomain(region: string): string {
  return CONSOLE_DOMAINS[getPartition(region)] ?? DEFAULT_CONSOLE_DOMAIN;
}
