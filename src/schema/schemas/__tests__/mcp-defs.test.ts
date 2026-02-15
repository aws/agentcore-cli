import {
  AgentCoreCliMcpDefsSchema,
  SchemaDefinitionSchema,
  ToolDefinitionSchema,
  ToolNameSchema,
} from '../mcp-defs.js';
import { describe, expect, it } from 'vitest';

describe('ToolNameSchema', () => {
  it.each(['myTool', 'get_user', 'search-results', 'A'])('accepts valid name "%s"', name => {
    expect(ToolNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(ToolNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name starting with digit', () => {
    expect(ToolNameSchema.safeParse('1tool').success).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    expect(ToolNameSchema.safeParse('-tool').success).toBe(false);
  });

  it('rejects name exceeding 128 chars', () => {
    const name = 'a'.repeat(129);
    expect(ToolNameSchema.safeParse(name).success).toBe(false);
  });

  it('accepts 128-char name (max)', () => {
    const name = 'a'.repeat(128);
    expect(ToolNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects name with dots', () => {
    expect(ToolNameSchema.safeParse('my.tool').success).toBe(false);
  });
});

describe('SchemaDefinitionSchema', () => {
  it('accepts simple string type', () => {
    const result = SchemaDefinitionSchema.safeParse({ type: 'string' });
    expect(result.success).toBe(true);
  });

  it('accepts all primitive types', () => {
    for (const type of ['string', 'number', 'object', 'array', 'boolean', 'integer']) {
      expect(SchemaDefinitionSchema.safeParse({ type }).success, `Should accept type: ${type}`).toBe(true);
    }
  });

  it('accepts type with description', () => {
    const result = SchemaDefinitionSchema.safeParse({
      type: 'string',
      description: 'A user name',
    });
    expect(result.success).toBe(true);
  });

  it('accepts nested object schema', () => {
    const result = SchemaDefinitionSchema.safeParse({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name' },
        age: { type: 'integer' },
      },
      required: ['name'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts array schema with items', () => {
    const result = SchemaDefinitionSchema.safeParse({
      type: 'array',
      items: { type: 'string' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts deeply nested schema', () => {
    const result = SchemaDefinitionSchema.safeParse({
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type', () => {
    expect(SchemaDefinitionSchema.safeParse({ type: 'date' }).success).toBe(false);
  });
});

describe('ToolDefinitionSchema', () => {
  const validDef = {
    name: 'myTool',
    description: 'Does something',
    inputSchema: { type: 'object' as const },
  };

  it('accepts valid tool definition', () => {
    expect(ToolDefinitionSchema.safeParse(validDef).success).toBe(true);
  });

  it('accepts tool with output schema', () => {
    const result = ToolDefinitionSchema.safeParse({
      ...validDef,
      outputSchema: { type: 'string' as const },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(ToolDefinitionSchema.safeParse({ ...validDef, name: '' }).success).toBe(false);
  });

  it('rejects empty description', () => {
    expect(ToolDefinitionSchema.safeParse({ ...validDef, description: '' }).success).toBe(false);
  });

  it('rejects missing inputSchema', () => {
    expect(ToolDefinitionSchema.safeParse({ name: 'tool', description: 'desc' }).success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    expect(ToolDefinitionSchema.safeParse({ ...validDef, extra: true }).success).toBe(false);
  });
});

describe('AgentCoreCliMcpDefsSchema', () => {
  it('accepts valid MCP defs', () => {
    const result = AgentCoreCliMcpDefsSchema.safeParse({
      tools: {
        myTool: {
          name: 'myTool',
          description: 'A tool',
          inputSchema: { type: 'object' as const },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty tools record', () => {
    expect(AgentCoreCliMcpDefsSchema.safeParse({ tools: {} }).success).toBe(true);
  });

  it('rejects missing tools field', () => {
    expect(AgentCoreCliMcpDefsSchema.safeParse({}).success).toBe(false);
  });
});
