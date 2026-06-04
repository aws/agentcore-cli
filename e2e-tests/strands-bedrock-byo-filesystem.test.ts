import { createE2ESuite } from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';

/**
 * E2E test: Strands/Bedrock agent with EFS and S3 Files filesystem mounts.
 *
 * Prerequisites (one-time setup):
 *   cd e2e-tests/fixtures/filesystem && python setup_byo_filesystem.py
 *
 * Required environment variables (set from setup_byo_filesystem.py output):
 *   E2E_EFS_ACCESS_POINT_ARN       — EFS access point ARN
 *   E2E_S3_ACCESS_POINT_ARN        — S3 Files access point ARN
 *   E2E_FILESYSTEM_SUBNET_ID       — private subnet ID
 *   E2E_FILESYSTEM_SECURITY_GROUP_ID — security group ID
 */

const uniqueFileContent = randomUUID();

createE2ESuite({
  framework: 'Strands',
  modelProvider: 'Bedrock',
  requiredEnvVars: [
    'E2E_EFS_ACCESS_POINT_ARN',
    'E2E_S3_ACCESS_POINT_ARN',
    'E2E_FILESYSTEM_SUBNET_ID',
    'E2E_FILESYSTEM_SECURITY_GROUP_ID',
  ],
  networkConfig: {
    networkMode: 'VPC',
    subnets: process.env.E2E_FILESYSTEM_SUBNET_ID!,
    securityGroups: process.env.E2E_FILESYSTEM_SECURITY_GROUP_ID!,
  },
  efsAccessPoints: [{ accessPointArn: process.env.E2E_EFS_ACCESS_POINT_ARN!, mountPath: '/mnt/efs' }],
  s3AccessPoints: [{ accessPointArn: process.env.E2E_S3_ACCESS_POINT_ARN!, mountPath: '/mnt/s3' }],
  invokePrompt: `Write the text "${uniqueFileContent}" to /mnt/efs/test.txt using file_write, then read it back using file_read and return the contents.`,
  invokeResponseCheck: response => {
    expect(response, 'Agent response should contain the unique written token').toContain(uniqueFileContent);
  },
});
