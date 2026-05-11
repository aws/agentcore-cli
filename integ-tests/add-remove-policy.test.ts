import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { createTelemetryHelper } from '../src/test-utils/telemetry-helper.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const telemetry = createTelemetryHelper();

describe('integration: add and remove policy engines and policies', () => {
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
    telemetry.destroy();
  });

  describe('policy engine lifecycle', () => {
    const engineName = `IntegEngine${Date.now().toString().slice(-6)}`;

    it('adds a policy engine', async () => {
      const result = await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.engineName).toBe(engineName);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as Record<string, unknown>[] | undefined;
      expect(engines, 'policyEngines should exist').toBeDefined();
      const found = engines!.some((e: Record<string, unknown>) => e.name === engineName);
      expect(found, `Policy engine "${engineName}" should be in config`).toBe(true);
    });

    it('rejects duplicate policy engine name', async () => {
      const result = await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('removes the policy engine', async () => {
      const result = await runCLI(['remove', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const engines = (config.policyEngines as Record<string, unknown>[] | undefined) ?? [];
      const found = engines.some((e: Record<string, unknown>) => e.name === engineName);
      expect(found, `Policy engine "${engineName}" should be removed from config`).toBe(false);
    });
  });

  describe('policy lifecycle', () => {
    const engineName = `IntegEng${Date.now().toString().slice(-6)}`;
    const policyName = `IntegPol${Date.now().toString().slice(-6)}`;
    const cedarStatement = 'permit(principal, action, resource);';

    it('adds a policy engine for policies', async () => {
      const result = await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);
      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    });

    it('adds a policy with inline statement', async () => {
      const result = await runCLI(
        ['add', 'policy', '--name', policyName, '--engine', engineName, '--statement', cedarStatement, '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.policyName).toBe(policyName);
      expect(json.engineName).toBe(engineName);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as {
        name: string;
        policies: { name: string; statement: string }[];
      }[];
      const engine = engines.find(e => e.name === engineName);
      expect(engine, `Engine "${engineName}" should exist`).toBeDefined();
      const policy = engine!.policies.find(p => p.name === policyName);
      expect(policy, `Policy "${policyName}" should exist in engine`).toBeDefined();
      expect(policy!.statement).toBe(cedarStatement);
    });

    it('rejects duplicate policy name in the same engine', async () => {
      const result = await runCLI(
        ['add', 'policy', '--name', policyName, '--engine', engineName, '--statement', cedarStatement, '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('removes a policy with --engine flag', async () => {
      const result = await runCLI(
        ['remove', 'policy', '--name', policyName, '--engine', engineName, '--json'],
        project.projectPath,
        { env: telemetry.env }
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify config updated
      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as { name: string; policies: { name: string }[] }[];
      const engine = engines.find(e => e.name === engineName);
      expect(engine, `Engine "${engineName}" should still exist`).toBeDefined();
      const policy = engine!.policies.find(p => p.name === policyName);
      expect(policy, `Policy "${policyName}" should be removed`).toBeUndefined();
      telemetry.assertMetricEmitted({ command: 'remove.policy', exit_reason: 'success' });
    });
  });

  describe('cross-engine policy disambiguation', () => {
    const engine1 = `EngA${Date.now().toString().slice(-6)}`;
    const engine2 = `EngB${Date.now().toString().slice(-6)}`;
    const sharedPolicyName = 'DenyAll';
    const cedarStatement1 = 'forbid(principal, action, resource);';
    const cedarStatement2 = 'forbid(principal, action, resource) when { true };';

    it('sets up two engines with same-named policies', async () => {
      // Create two engines
      let result = await runCLI(['add', 'policy-engine', '--name', engine1, '--json'], project.projectPath);
      expect(result.exitCode, `engine1 create: ${result.stderr}`).toBe(0);

      result = await runCLI(['add', 'policy-engine', '--name', engine2, '--json'], project.projectPath);
      expect(result.exitCode, `engine2 create: ${result.stderr}`).toBe(0);

      // Add same-named policy to both engines
      result = await runCLI(
        ['add', 'policy', '--name', sharedPolicyName, '--engine', engine1, '--statement', cedarStatement1, '--json'],
        project.projectPath
      );
      expect(result.exitCode, `policy1 create: ${result.stderr}`).toBe(0);

      result = await runCLI(
        ['add', 'policy', '--name', sharedPolicyName, '--engine', engine2, '--statement', cedarStatement2, '--json'],
        project.projectPath
      );
      expect(result.exitCode, `policy2 create: ${result.stderr}`).toBe(0);

      // Verify both policies exist
      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as {
        name: string;
        policies: { name: string; statement: string }[];
      }[];
      const eng1 = engines.find(e => e.name === engine1);
      const eng2 = engines.find(e => e.name === engine2);
      expect(eng1!.policies).toHaveLength(1);
      expect(eng2!.policies).toHaveLength(1);
      expect(eng1!.policies[0]!.name).toBe(sharedPolicyName);
      expect(eng2!.policies[0]!.name).toBe(sharedPolicyName);
    });

    it('removes policy from correct engine using --engine flag', async () => {
      const result = await runCLI(
        ['remove', 'policy', '--name', sharedPolicyName, '--engine', engine1, '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify only engine1's policy was removed
      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as {
        name: string;
        policies: { name: string; statement: string }[];
      }[];
      const eng1 = engines.find(e => e.name === engine1);
      const eng2 = engines.find(e => e.name === engine2);
      expect(eng1!.policies, `engine1 should have no policies`).toHaveLength(0);
      expect(eng2!.policies, `engine2 should still have its policy`).toHaveLength(1);
      expect(eng2!.policies[0]!.statement).toBe(cedarStatement2);
    });

    it('removes policy from second engine', async () => {
      const result = await runCLI(
        ['remove', 'policy', '--name', sharedPolicyName, '--engine', engine2, '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as { name: string; policies: { name: string }[] }[];
      const eng2 = engines.find(e => e.name === engine2);
      expect(eng2!.policies).toHaveLength(0);
    });
  });

  describe('policy removal without --engine flag', () => {
    const engineName = `EngNoFlag${Date.now().toString().slice(-6)}`;
    const policyName = `PolNoFlag${Date.now().toString().slice(-6)}`;

    it('adds engine and policy', async () => {
      let result = await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);
      expect(result.exitCode).toBe(0);

      result = await runCLI(
        [
          'add',
          'policy',
          '--name',
          policyName,
          '--engine',
          engineName,
          '--statement',
          'permit(principal, action, resource);',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(0);
    });

    it('removes policy without --engine when name is unique', async () => {
      // Without --engine, the policy name alone (no slash) should still find it
      const result = await runCLI(['remove', 'policy', '--name', policyName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as { name: string; policies: { name: string }[] }[];
      const engine = engines.find(e => e.name === engineName);
      expect(engine!.policies).toHaveLength(0);
    });
  });

  describe('error cases', () => {
    it('fails to add policy to non-existent engine', async () => {
      const result = await runCLI(
        [
          'add',
          'policy',
          '--name',
          'SomePolicy',
          '--engine',
          'NonExistent',
          '--statement',
          'permit(principal, action, resource);',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });

    it('fails to remove non-existent policy', async () => {
      const result = await runCLI(['remove', 'policy', '--name', 'NonExistentPolicy', '--json'], project.projectPath, {
        env: telemetry.env,
      });

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
      telemetry.assertMetricEmitted({ command: 'remove.policy', exit_reason: 'failure' });
    });

    it('fails to remove non-existent policy engine', async () => {
      const result = await runCLI(
        ['remove', 'policy-engine', '--name', 'NonExistentEngine', '--json'],
        project.projectPath,
        { env: telemetry.env }
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
      telemetry.assertMetricEmitted({ command: 'remove.policy-engine', exit_reason: 'failure' });
    });

    it('requires --engine when adding a policy', async () => {
      const result = await runCLI(
        ['add', 'policy', '--name', 'SomePolicy', '--statement', 'permit(principal, action, resource);', '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--engine is required');
    });

    it('rejects --statement and --source together', async () => {
      const engineName = `EngMutex${Date.now().toString().slice(-6)}`;
      await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      const result = await runCLI(
        [
          'add',
          'policy',
          '--name',
          'MutexPolicy',
          '--engine',
          engineName,
          '--statement',
          'permit(principal, action, resource);',
          '--source',
          'policy.cedar',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Only one of');
    });

    it('rejects --statement and --generate together', async () => {
      const engineName = `EngMutex2${Date.now().toString().slice(-6)}`;
      await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      const result = await runCLI(
        [
          'add',
          'policy',
          '--name',
          'MutexPolicy',
          '--engine',
          engineName,
          '--statement',
          'permit(principal, action, resource);',
          '--generate',
          'Allow all read access',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Only one of');
    });

    it('rejects --source and --generate together', async () => {
      const engineName = `EngMutex3${Date.now().toString().slice(-6)}`;
      await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      const result = await runCLI(
        [
          'add',
          'policy',
          '--name',
          'MutexPolicy',
          '--engine',
          engineName,
          '--source',
          'policy.cedar',
          '--generate',
          'Allow all read access',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Only one of');
    });

    it('rejects all three flags together', async () => {
      const engineName = `EngMutex4${Date.now().toString().slice(-6)}`;
      await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      const result = await runCLI(
        [
          'add',
          'policy',
          '--name',
          'MutexPolicy',
          '--engine',
          engineName,
          '--statement',
          'permit(principal, action, resource);',
          '--source',
          'policy.cedar',
          '--generate',
          'Allow all read access',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Only one of');
    });

    it('requires --statement, --source, or --generate when adding a policy', async () => {
      // First ensure an engine exists
      const engineName = `EngErr${Date.now().toString().slice(-6)}`;
      await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);

      const result = await runCLI(
        ['add', 'policy', '--name', 'SomePolicy', '--engine', engineName, '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--statement');
    });
  });

  describe('policy engine removal cascades', () => {
    const engineName = `EngCascade${Date.now().toString().slice(-6)}`;

    it('removing an engine also removes its policies', async () => {
      // Create engine with a policy
      let result = await runCLI(['add', 'policy-engine', '--name', engineName, '--json'], project.projectPath);
      expect(result.exitCode).toBe(0);

      result = await runCLI(
        [
          'add',
          'policy',
          '--name',
          'CascadePolicy',
          '--engine',
          engineName,
          '--statement',
          'permit(principal, action, resource);',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(0);

      // Remove the engine
      result = await runCLI(['remove', 'policy-engine', '--name', engineName, '--json'], project.projectPath);
      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      // Verify both engine and policy are gone
      const config = await readProjectConfig(project.projectPath);
      const engines = config.policyEngines as { name: string; policies: { name: string }[] }[];
      const engine = engines.find(e => e.name === engineName);
      expect(engine, 'Engine should be removed').toBeUndefined();
    });
  });
});
