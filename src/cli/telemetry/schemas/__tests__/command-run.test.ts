import { COMMAND_SCHEMAS, type Command, type CommandAttrs, deriveCommandGroup } from '../command-run';
import { ResourceAttributesSchema } from '../common-attributes';
import { CommandResultSchema, resilientParse } from '../common-shapes';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

describe('CommandResultSchema', () => {
  it('accepts success with no error fields', () => {
    expect(CommandResultSchema.parse({ exit_reason: 'success' })).toEqual({ exit_reason: 'success' });
  });

  it('accepts failure with required error fields', () => {
    const result = CommandResultSchema.parse({
      exit_reason: 'failure',
      error_name: 'DependencyCheckError',
      error_source: 'user',
    });
    expect(result).toMatchObject({ exit_reason: 'failure', error_name: 'DependencyCheckError' });
  });

  it('rejects failure missing error_name', () => {
    expect(() => CommandResultSchema.parse({ exit_reason: 'failure' })).toThrow();
  });

  it('rejects invalid exit_reason', () => {
    expect(() => CommandResultSchema.parse({ exit_reason: 'timeout' })).toThrow();
  });
});

describe('COMMAND_SCHEMAS', () => {
  it('every command key produces a valid command_group', () => {
    for (const command of Object.keys(COMMAND_SCHEMAS) as Command[]) {
      const group = deriveCommandGroup(command);
      expect(group).toBeTruthy();
      expect(group).not.toContain('.');
    }
  });

  it('accepts valid deploy attrs', () => {
    const attrs = {
      runtime_count: 2,
      harness_count: 1,
      memory_count: 1,
      credential_count: 0,
      evaluator_count: 0,
      online_eval_count: 0,
      gateway_count: 1,
      gateway_target_count: 3,
      policy_engine_count: 0,
      policy_count: 0,
      deploy_mode: 'diff',
    };
    expect(COMMAND_SCHEMAS.deploy.parse(attrs)).toEqual(attrs);
  });

  it('rejects deploy attrs with negative count', () => {
    expect(() =>
      COMMAND_SCHEMAS.deploy.parse({
        runtime_count: -1,
        harness_count: 0,
        memory_count: 0,
        credential_count: 0,
        evaluator_count: 0,
        online_eval_count: 0,
        gateway_count: 0,
        gateway_target_count: 0,
        policy_engine_count: 0,
        policy_count: 0,
        deploy_mode: 'deploy',
      })
    ).toThrow();
  });

  it('rejects deploy attrs with float count', () => {
    expect(() =>
      COMMAND_SCHEMAS.deploy.parse({
        runtime_count: 1.5,
        harness_count: 0,
        memory_count: 0,
        credential_count: 0,
        evaluator_count: 0,
        online_eval_count: 0,
        gateway_count: 0,
        gateway_target_count: 0,
        policy_engine_count: 0,
        policy_count: 0,
        deploy_mode: 'deploy',
      })
    ).toThrow();
  });

  it('accepts valid create attrs', () => {
    const attrs = {
      agent_environment: 'runtime',
      agent_language: 'python',
      agent_framework: 'strands',
      model_provider: 'bedrock',
      memory_type: 'shortterm',
      agent_protocol: 'mcp',
      build_type: 'codezip',
      agent_source: 'create',
      network_mode: 'public',
      has_agent: true,
    };
    expect(COMMAND_SCHEMAS.create.parse(attrs)).toEqual(attrs);
  });

  it('rejects create attrs with invalid enum value', () => {
    expect(() =>
      COMMAND_SCHEMAS.create.parse({
        agent_environment: 'runtime',
        agent_language: 'rust',
        agent_framework: 'strands',
        model_provider: 'bedrock',
        memory_type: 'shortterm',
        agent_protocol: 'mcp',
        build_type: 'codezip',
        agent_source: 'create',
        network_mode: 'public',
        has_agent: true,
      })
    ).toThrow();
  });

  it('no-attrs commands accept empty object', () => {
    expect(COMMAND_SCHEMAS['telemetry.disable'].parse({})).toEqual({});
  });

  it('import subcommand schemas accept empty object', () => {
    expect(COMMAND_SCHEMAS.import.parse({})).toEqual({});
    expect(COMMAND_SCHEMAS['import.runtime'].parse({})).toEqual({});
    expect(COMMAND_SCHEMAS['import.memory'].parse({})).toEqual({});
    expect(COMMAND_SCHEMAS['import.evaluator'].parse({})).toEqual({});
    expect(COMMAND_SCHEMAS['import.online-eval'].parse({})).toEqual({});
    expect(COMMAND_SCHEMAS['import.gateway'].parse({})).toEqual({});
  });

  it('accepts valid dev invoke attrs', () => {
    const attrs = {
      agent_environment: 'runtime',
      dev_action: 'invoke',
      ui_mode: 'terminal',
      has_stream: true,
      agent_protocol: 'http',
      invoke_count: 1,
    };
    expect(COMMAND_SCHEMAS.dev.parse(attrs)).toEqual(attrs);
  });

  it('accepts valid dev server browser attrs', () => {
    const attrs = {
      agent_environment: 'runtime',
      dev_action: 'server',
      ui_mode: 'browser',
      has_stream: false,
      agent_protocol: 'mcp',
      invoke_count: 12,
    };
    expect(COMMAND_SCHEMAS.dev.parse(attrs)).toEqual(attrs);
  });

  it('accepts dev exec attrs', () => {
    const attrs = {
      agent_environment: 'runtime',
      dev_action: 'exec',
      ui_mode: 'terminal',
      has_stream: false,
      agent_protocol: 'http',
      invoke_count: 1,
    };
    expect(COMMAND_SCHEMAS.dev.parse(attrs)).toEqual(attrs);
  });

  it('rejects dev attrs with invalid action', () => {
    expect(() =>
      COMMAND_SCHEMAS.dev.parse({
        agent_environment: 'runtime',
        dev_action: 'unknown',
        ui_mode: 'terminal',
        has_stream: false,
        agent_protocol: 'http',
        invoke_count: 0,
      })
    ).toThrow();
  });

  it('rejects dev attrs with invalid ui_mode', () => {
    expect(() =>
      COMMAND_SCHEMAS.dev.parse({
        agent_environment: 'runtime',
        dev_action: 'server',
        ui_mode: 'headless',
        has_stream: false,
        agent_protocol: 'http',
        invoke_count: 0,
      })
    ).toThrow();
  });
});

describe('deriveCommandGroup', () => {
  it.each([
    ['create', 'create'],
    ['add.agent', 'add'],
    ['logs.evals', 'logs'],
    ['remove.gateway-target', 'remove'],
    ['telemetry.disable', 'telemetry'],
  ] as const)('%s → %s', (command, expected) => {
    expect(deriveCommandGroup(command)).toBe(expected);
  });
});

describe('type safety', () => {
  it('CommandAttrs<deploy> requires runtime_count', () => {
    expectTypeOf<CommandAttrs<'deploy'>>().toHaveProperty('runtime_count');
  });

  it('CommandAttrs<create> requires agent_language', () => {
    expectTypeOf<CommandAttrs<'create'>>().toHaveProperty('agent_language');
  });

  it('CommandAttrs<telemetry.disable> is empty', () => {
    expectTypeOf<CommandAttrs<'telemetry.disable'>>().toEqualTypeOf<Record<string, never>>();
  });

  it('no command schema contains arbitrary string fields', () => {
    for (const [cmd, schema] of Object.entries(COMMAND_SCHEMAS)) {
      for (const [field, zodType] of Object.entries(schema.shape)) {
        const inner = zodType instanceof z.ZodOptional ? zodType.unwrap() : zodType;
        const safe =
          inner instanceof z.ZodEnum ||
          inner instanceof z.ZodBoolean ||
          inner instanceof z.ZodNumber ||
          inner instanceof z.ZodLiteral;
        expect(safe, `${cmd}.${field} is an unsafe type`).toBe(true);
      }
    }
  });

  it('no resource attribute allows unbounded strings', () => {
    for (const field of Object.keys(ResourceAttributesSchema.shape)) {
      const partial = ResourceAttributesSchema.partial();
      const freeText = partial.safeParse({ [field]: 'UNCONSTRAINED_FREE_TEXT_VALUE_THAT_SHOULD_FAIL' });
      const empty = partial.safeParse({ [field]: '' });
      const isConstrained = !freeText.success || !empty.success;
      expect(isConstrained, `${field} accepts arbitrary strings`).toBe(true);
    }
  });
});

describe('resilientParse', () => {
  it('passes valid attrs through unchanged', () => {
    const attrs = {
      agent_environment: 'runtime',
      agent_language: 'python',
      agent_framework: 'strands',
      model_provider: 'bedrock',
      memory_type: 'shortterm',
      agent_protocol: 'mcp',
      build_type: 'codezip',
      agent_source: 'create',
      network_mode: 'public',
      has_agent: true,
    };
    expect(resilientParse(COMMAND_SCHEMAS.create, attrs)).toEqual(attrs);
  });

  it('defaults a single invalid enum field to unknown', () => {
    const attrs = {
      agent_language: 'rust', // invalid
      agent_framework: 'strands',
      model_provider: 'bedrock',
      memory_type: 'shortterm',
      agent_protocol: 'mcp',
      build_type: 'codezip',
      agent_source: 'create',
      network_mode: 'public',
      has_agent: true,
    };
    const result = resilientParse(COMMAND_SCHEMAS.create, attrs);
    expect(result.agent_language).toBe('unknown');
    expect(result.agent_framework).toBe('strands');
  });

  it('defaults missing required fields to unknown', () => {
    const result = resilientParse(COMMAND_SCHEMAS.create, { agent_language: 'python' });
    expect(result.agent_language).toBe('python');
    expect(result.agent_environment).toBe('unknown');
    expect(result.has_agent).toBe('unknown');
  });

  it('defaults all fields to unknown when all are invalid', () => {
    const result = resilientParse(COMMAND_SCHEMAS.create, {});
    for (const value of Object.values(result)) {
      expect(value === 'unknown' || value === undefined).toBe(true);
    }
  });

  it('returns empty object for no-attrs schemas', () => {
    expect(resilientParse(COMMAND_SCHEMAS['telemetry.disable'], {})).toEqual({});
  });
});
