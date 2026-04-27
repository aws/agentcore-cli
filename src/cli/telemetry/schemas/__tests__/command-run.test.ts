import { COMMAND_SCHEMAS, type Command, type CommandAttrs, deriveCommandGroup } from '../command-run';
import { ResourceAttributesSchema } from '../common-attributes';
import { CommandResultSchema } from '../common-shapes';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

describe('CommandResultSchema', () => {
  it('accepts success with no error fields', () => {
    expect(CommandResultSchema.parse({ exit_reason: 'success' })).toEqual({ exit_reason: 'success' });
  });

  it('accepts failure with required error fields', () => {
    const result = CommandResultSchema.parse({
      exit_reason: 'failure',
      error_name: 'PackagingError',
      is_user_error: false,
    });
    expect(result).toMatchObject({ exit_reason: 'failure', error_name: 'PackagingError' });
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
      memory_count: 1,
      credential_count: 0,
      evaluator_count: 0,
      online_eval_count: 0,
      gateway_count: 1,
      gateway_target_count: 3,
      policy_engine_count: 0,
      policy_count: 0,
      has_diff: true,
    };
    expect(COMMAND_SCHEMAS.deploy.parse(attrs)).toEqual(attrs);
  });

  it('rejects deploy attrs with negative count', () => {
    expect(() =>
      COMMAND_SCHEMAS.deploy.parse({
        runtime_count: -1,
        memory_count: 0,
        credential_count: 0,
        evaluator_count: 0,
        online_eval_count: 0,
        gateway_count: 0,
        gateway_target_count: 0,
        policy_engine_count: 0,
        policy_count: 0,
        has_diff: false,
      })
    ).toThrow();
  });

  it('rejects deploy attrs with float count', () => {
    expect(() =>
      COMMAND_SCHEMAS.deploy.parse({
        runtime_count: 1.5,
        memory_count: 0,
        credential_count: 0,
        evaluator_count: 0,
        online_eval_count: 0,
        gateway_count: 0,
        gateway_target_count: 0,
        policy_engine_count: 0,
        policy_count: 0,
        has_diff: false,
      })
    ).toThrow();
  });

  it('accepts valid create attrs', () => {
    const attrs = {
      language: 'python',
      framework: 'strands',
      model_provider: 'bedrock',
      memory: 'shortterm',
      protocol: 'mcp',
      build: 'codezip',
      agent_type: 'create',
      network_mode: 'public',
      has_agent: true,
    };
    expect(COMMAND_SCHEMAS.create.parse(attrs)).toEqual(attrs);
  });

  it('rejects create attrs with invalid enum value', () => {
    expect(() =>
      COMMAND_SCHEMAS.create.parse({
        language: 'rust',
        framework: 'strands',
        model_provider: 'bedrock',
        memory: 'shortterm',
        protocol: 'mcp',
        build: 'codezip',
        agent_type: 'create',
        network_mode: 'public',
        has_agent: true,
      })
    ).toThrow();
  });

  it('no-attrs commands accept empty object', () => {
    expect(COMMAND_SCHEMAS['telemetry.disable'].parse({})).toEqual({});
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

  it('CommandAttrs<create> requires language', () => {
    expectTypeOf<CommandAttrs<'create'>>().toHaveProperty('language');
  });

  it('CommandAttrs<telemetry.disable> is empty', () => {
    expectTypeOf<CommandAttrs<'telemetry.disable'>>().toEqualTypeOf<Record<string, never>>();
  });

  it('no command schema contains arbitrary string fields', () => {
    for (const [cmd, schema] of Object.entries(COMMAND_SCHEMAS)) {
      for (const [field, zodType] of Object.entries(schema.shape)) {
        const safe =
          zodType instanceof z.ZodEnum ||
          zodType instanceof z.ZodBoolean ||
          zodType instanceof z.ZodNumber ||
          zodType instanceof z.ZodLiteral;
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
