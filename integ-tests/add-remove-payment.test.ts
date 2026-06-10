import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: add and remove payment managers and connectors', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('payment manager lifecycle', () => {
    const managerName = `IntegMgr${Date.now().toString().slice(-6)}`;

    it('adds an AWS_IAM payment manager', async () => {
      const result = await runCLI(['add', 'payment-manager', '--name', managerName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.managerName).toBe(managerName);

      const config = await readProjectConfig(project.projectPath);
      const manager = config.payments?.find((p: Record<string, unknown>) => p.name === managerName);
      expect(manager, `Payment manager "${managerName}" should be in config`).toBeTruthy();
      expect(manager!.authorizerType).toBe('AWS_IAM');
      expect(manager!.autoPayment).toBe(true);
      expect(manager!.connectors).toEqual([]);
    });

    it('rejects duplicate payment manager name', async () => {
      const result = await runCLI(['add', 'payment-manager', '--name', managerName, '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('generates payment capability code for agents', async () => {
      const config = await readProjectConfig(project.projectPath);
      const agentName = config.runtimes?.[0]?.name;
      expect(agentName).toBeTruthy();

      const paymentsPath = join(project.projectPath, 'app', agentName!, 'capabilities', 'payments', 'payments.py');
      const paymentsCode = await readFile(paymentsPath, 'utf-8');
      expect(paymentsCode).toContain('create_payments_plugin');
      expect(paymentsCode).toContain('instrument_id');
      expect(paymentsCode).toContain('session_id');
    });

    it('removes the payment manager', async () => {
      const result = await runCLI(
        ['remove', 'payment-manager', '--name', managerName, '--yes', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const found = config.payments?.some((p: Record<string, unknown>) => p.name === managerName);
      expect(found, `Payment manager "${managerName}" should be removed`).toBeFalsy();
    });
  });

  describe('CUSTOM_JWT payment manager', () => {
    const jwtManagerName = `IntegJwt${Date.now().toString().slice(-6)}`;

    it('adds a CUSTOM_JWT payment manager with OIDC config', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-manager',
          '--name',
          jwtManagerName,
          '--authorizer-type',
          'CUSTOM_JWT',
          '--discovery-url',
          'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test/.well-known/openid-configuration',
          '--allowed-clients',
          'client-1,client-2',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const manager = config.payments?.find((p: Record<string, unknown>) => p.name === jwtManagerName);
      expect(manager).toBeTruthy();
      expect(manager!.authorizerType).toBe('CUSTOM_JWT');
      expect((manager as any).authorizerConfiguration?.customJWTAuthorizer?.discoveryUrl).toContain(
        'openid-configuration'
      );
      expect((manager as any).authorizerConfiguration?.customJWTAuthorizer?.allowedClients).toEqual([
        'client-1',
        'client-2',
      ]);
    });

    it('rejects CUSTOM_JWT without discovery-url', async () => {
      const result = await runCLI(
        ['add', 'payment-manager', '--name', 'noUrl', '--authorizer-type', 'CUSTOM_JWT', '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--discovery-url is required');
    });

    afterAll(async () => {
      await runCLI(['remove', 'payment-manager', '--name', jwtManagerName, '--yes'], project.projectPath);
    });
  });

  describe('payment connector lifecycle', () => {
    const managerName = `IntegConnMgr${Date.now().toString().slice(-6)}`;
    const connectorName1 = `IntegConn1${Date.now().toString().slice(-6)}`;
    const connectorName2 = `IntegConn2${Date.now().toString().slice(-6)}`;

    beforeAll(async () => {
      await runCLI(['add', 'payment-manager', '--name', managerName], project.projectPath);
    });

    it('adds a payment connector to the manager', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          managerName,
          '--name',
          connectorName1,
          '--provider',
          'CoinbaseCDP',
          '--api-key-id',
          'test-key-id',
          '--api-key-secret',
          'test-key-secret',
          '--wallet-secret',
          'test-wallet-secret',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const manager = config.payments?.find((p: Record<string, unknown>) => p.name === managerName);
      const connector = (manager?.connectors as Record<string, unknown>[])?.find(
        (c: Record<string, unknown>) => c.name === connectorName1
      );
      expect(connector, `Connector "${connectorName1}" should be in manager's connectors`).toBeTruthy();

      // Verify credential was created
      const cred = config.credentials?.find(
        (c: Record<string, unknown>) => c.authorizerType === 'PaymentCredentialProvider'
      );
      expect(cred, 'PaymentCredentialProvider credential should exist').toBeTruthy();
    });

    it('stores CDP secrets in .env.local', async () => {
      const envPath = join(project.projectPath, 'agentcore', '.env.local');
      const envContent = await readFile(envPath, 'utf-8');
      expect(envContent).toContain('API_KEY_ID');
      expect(envContent).toContain('API_KEY_SECRET');
      expect(envContent).toContain('WALLET_SECRET');
    });

    it('adds a second connector to the same manager', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          managerName,
          '--name',
          connectorName2,
          '--provider',
          'CoinbaseCDP',
          '--api-key-id',
          'test-key-id-2',
          '--api-key-secret',
          'test-key-secret-2',
          '--wallet-secret',
          'test-wallet-secret-2',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      const manager = config.payments?.find((p: Record<string, unknown>) => p.name === managerName);
      const connectors = manager?.connectors as Record<string, unknown>[];
      expect(connectors?.length).toBe(2);
    });

    it('rejects duplicate connector name', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          managerName,
          '--name',
          connectorName1,
          '--provider',
          'CoinbaseCDP',
          '--api-key-id',
          'x',
          '--api-key-secret',
          'y',
          '--wallet-secret',
          'z',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('rejects connector for non-existent manager', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          'noSuchManager',
          '--name',
          'x',
          '--provider',
          'CoinbaseCDP',
          '--api-key-id',
          'x',
          '--api-key-secret',
          'y',
          '--wallet-secret',
          'z',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });

    it('removes a single connector', async () => {
      const result = await runCLI(
        ['remove', 'payment-connector', '--manager', managerName, '--name', connectorName1, '--yes', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const manager = config.payments?.find((p: Record<string, unknown>) => p.name === managerName);
      const connectors = manager?.connectors as Record<string, unknown>[];
      expect(connectors?.length).toBe(1);
      expect(connectors[0]?.name).toBe(connectorName2);
    });

    it('removes the manager with remaining connector', async () => {
      const result = await runCLI(
        ['remove', 'payment-manager', '--name', managerName, '--yes', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      const found = config.payments?.some((p: Record<string, unknown>) => p.name === managerName);
      expect(found).toBeFalsy();
    });
  });

  describe('StripePrivy connector lifecycle', () => {
    const managerName = `IntegSpMgr${Date.now().toString().slice(-6)}`;
    const connectorName = `IntegSpConn${Date.now().toString().slice(-6)}`;

    beforeAll(async () => {
      await runCLI(['add', 'payment-manager', '--name', managerName], project.projectPath);
    });

    it('adds a StripePrivy connector to the manager', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          managerName,
          '--name',
          connectorName,
          '--provider',
          'StripePrivy',
          '--app-id',
          'test-app-id',
          '--app-secret',
          'test-app-secret',
          '--authorization-private-key',
          'RkFLRV9TVFJJUEVfUFJJVllfVEVTVF9LRVlfQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==',
          '--authorization-id',
          'test-auth-id',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const manager = config.payments?.find((p: Record<string, unknown>) => p.name === managerName);
      const connector = (manager?.connectors as Record<string, unknown>[])?.find(
        (c: Record<string, unknown>) => c.name === connectorName
      );
      expect(connector, `Connector "${connectorName}" should be in manager's connectors`).toBeTruthy();
      expect(connector!.provider).toBe('StripePrivy');

      const cred = config.credentials?.find(
        (c: Record<string, unknown>) => c.authorizerType === 'PaymentCredentialProvider' && c.provider === 'StripePrivy'
      );
      expect(cred, 'StripePrivy PaymentCredentialProvider credential should exist').toBeTruthy();
    });

    it('stores StripePrivy secrets in .env.local', async () => {
      const envPath = join(project.projectPath, 'agentcore', '.env.local');
      const envContent = await readFile(envPath, 'utf-8');
      expect(envContent).toContain('APP_ID');
      expect(envContent).toContain('APP_SECRET');
      expect(envContent).toContain('AUTHORIZATION_PRIVATE_KEY');
      expect(envContent).toContain('AUTHORIZATION_ID');
    });

    it('rejects duplicate StripePrivy connector name', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          managerName,
          '--name',
          connectorName,
          '--provider',
          'StripePrivy',
          '--app-id',
          'x',
          '--app-secret',
          'y',
          '--authorization-private-key',
          'RkFLRV9TVFJJUEVfUFJJVllfVEVTVF9LRVlfQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==',
          '--authorization-id',
          'w',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('rejects StripePrivy connector missing required credentials', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          managerName,
          '--name',
          'incomplete',
          '--provider',
          'StripePrivy',
          '--app-id',
          'x',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
    });

    it('removes the StripePrivy connector', async () => {
      const result = await runCLI(
        ['remove', 'payment-connector', '--manager', managerName, '--name', connectorName, '--yes', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const manager = config.payments?.find((p: Record<string, unknown>) => p.name === managerName);
      const connectors = manager?.connectors as Record<string, unknown>[];
      expect(connectors?.length).toBe(0);
    });

    afterAll(async () => {
      await runCLI(['remove', 'payment-manager', '--name', managerName, '--yes'], project.projectPath);
    });
  });

  describe('validation', () => {
    it('passes agentcore validate after add/remove lifecycle', async () => {
      const result = await runCLI(['validate'], project.projectPath);
      expect(result.exitCode).toBe(0);
    });

    it('rejects invalid authorizer type', async () => {
      const result = await runCLI(
        ['add', 'payment-manager', '--name', 'x', '--authorizer-type', 'INVALID', '--json'],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
    });

    it('rejects invalid provider', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--manager',
          'x',
          '--name',
          'y',
          '--provider',
          'INVALID',
          '--api-key-id',
          'x',
          '--api-key-secret',
          'y',
          '--wallet-secret',
          'z',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
    });

    it('requires --manager for payment-connector', async () => {
      const result = await runCLI(
        [
          'add',
          'payment-connector',
          '--name',
          'x',
          '--provider',
          'CoinbaseCDP',
          '--api-key-id',
          'x',
          '--api-key-secret',
          'y',
          '--wallet-secret',
          'z',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
    });
  });
});
