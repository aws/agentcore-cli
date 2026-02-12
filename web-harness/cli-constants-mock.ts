// Mock for CLI constants that use Node.js 'module' built-in

export const PACKAGE_VERSION = '0.0.0-browser';
export const CDK_PROJECT_DIR = 'cdk';
export const CDK_APP_ENTRY = 'dist/bin/cdk.js';
export const DEV_MODE = true;
export const DEV_LINK_PACKAGES = ['@agentcore/cdk', '@agentcore/lib', '@agentcore/schema'];
export const SCHEMA_VERSION = 1;

export type DistroMode = 'PROD_DISTRO' | 'PRIVATE_DEV_DISTRO';
export const DISTRO_MODE: DistroMode = 'PROD_DISTRO';

export const DISTRO_CONFIG = {
  PROD_DISTRO: {
    packageName: '@aws/agentcore',
    registryUrl: 'https://registry.npmjs.org',
    installCommand: 'npm install -g @aws/agentcore@latest',
  },
  PRIVATE_DEV_DISTRO: {
    packageName: '@aws/agentcore',
    registryUrl: 'https://npm.pkg.github.com',
    installCommand: 'npm install -g @aws/agentcore@latest --registry=https://npm.pkg.github.com',
  },
} as const;

export function getDistroConfig() {
  return DISTRO_CONFIG[DISTRO_MODE];
}
