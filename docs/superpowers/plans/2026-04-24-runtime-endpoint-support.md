# Runtime Endpoint Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to register, manage, and deploy named endpoints (version aliases) for AgentCore runtimes via
`agentcore add runtime-endpoint` / `agentcore remove runtime-endpoint`, with full TUI support and CDK deployment.

**Architecture:** Runtime endpoints are modeled as a sub-resource of runtimes (similar to how gateway targets are
sub-resources of gateways). An `endpoints` dictionary is added to `AgentEnvSpec` in the schema. The CLI primitive
follows the GatewayTargetPrimitive pattern — a sub-resource that validates its parent exists. The CDK construct creates
`CfnRuntimeEndpoint` resources for each endpoint entry. The `status` command and TUI display endpoints nested under
their parent runtime.

**Tech Stack:** TypeScript, Zod (schema validation), Commander.js (CLI), Ink/React (TUI), AWS CDK (infrastructure)

---

## File Structure

### New Files (CLI repo: `agentcore-cli`)

| File                                                                  | Responsibility                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/cli/primitives/RuntimeEndpointPrimitive.ts`                      | Primitive class: add/remove/preview/getRemovable/registerCommands for runtime endpoints |
| `src/cli/tui/screens/runtime-endpoint/AddRuntimeEndpointFlow.tsx`     | TUI add flow wrapper (wizard state machine)                                             |
| `src/cli/tui/screens/runtime-endpoint/AddRuntimeEndpointScreen.tsx`   | TUI add screen (step-by-step input collection)                                          |
| `src/cli/tui/screens/runtime-endpoint/useAddRuntimeEndpointWizard.ts` | React hook managing wizard steps and config state                                       |
| `src/cli/tui/screens/runtime-endpoint/types.ts`                       | Types for the runtime endpoint wizard config                                            |
| `src/cli/tui/screens/runtime-endpoint/index.ts`                       | Barrel exports                                                                          |
| `src/cli/tui/screens/remove/RemoveRuntimeEndpointScreen.tsx`          | TUI remove screen (list endpoints for selection)                                        |

### Modified Files (CLI repo: `agentcore-cli`)

| File                                          | Change                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/schema/schemas/agent-env.ts`             | Add `RuntimeEndpointSchema`, `endpoints` field to `AgentEnvSpecSchema`                                   |
| `src/schema/schemas/deployed-state.ts`        | Add `runtimeVersion` to `AgentCoreDeployedStateSchema`                                                   |
| `src/cli/primitives/registry.ts`              | Add `runtimeEndpointPrimitive` singleton + to `ALL_PRIMITIVES`                                           |
| `src/cli/primitives/index.ts`                 | Export `RuntimeEndpointPrimitive`                                                                        |
| `src/cli/commands/remove/types.ts`            | Add `'runtime-endpoint'` to `ResourceType` union                                                         |
| `src/cli/commands/status/action.ts`           | Add `'runtime-endpoint'` to `ResourceStatusEntry.resourceType`, store `runtimeVersion` in deployed state |
| `src/cli/tui/screens/add/AddScreen.tsx`       | Add `'runtime-endpoint'` to `ADD_RESOURCES`                                                              |
| `src/cli/tui/screens/add/AddFlow.tsx`         | Add `'runtime-endpoint-wizard'` flow state + render `AddRuntimeEndpointFlow`                             |
| `src/cli/tui/screens/remove/RemoveFlow.tsx`   | Add runtime-endpoint flow states, hooks, handlers, screens                                               |
| `src/cli/tui/screens/remove/RemoveScreen.tsx` | Add `'runtime-endpoint'` to remove resource list                                                         |
| `src/cli/tui/hooks/useRemove.ts`              | Add `useRemovableRuntimeEndpoints` and `useRemoveRuntimeEndpoint` hooks                                  |
| `src/cli/tui/components/ResourceGraph.tsx`    | Display endpoints nested under agents in status view                                                     |

### Modified Files (CDK repo: `agentcore-l3-cdk-constructs`)

| File                                             | Change                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `src/schema/schemas/agent-env.ts`                | Add `RuntimeEndpointSchema`, `endpoints` field to `AgentEnvSpecSchema` (mirror CLI) |
| `src/cdk/constructs/l3/AgentEnvironment.ts`      | Create `CfnRuntimeEndpoint` resources for each endpoint entry                       |
| `src/cdk/constructs/components/mcp/mcp-utils.ts` | Add `getRuntimeEndpointUrlWithQualifier()` function                                 |

---

## Task 1: Add `endpoints` field to AgentEnvSpec schema (CLI repo)

**Files:**

- Modify: `agentcore-cli/src/schema/schemas/agent-env.ts:195-272`
- Test: `agentcore-cli/src/schema/schemas/__tests__/agent-env.test.ts`

- [ ] **Step 1: Write the failing test**

In the existing agent-env test file, add tests for the new endpoints field:

```typescript
describe('endpoints', () => {
  it('accepts a valid endpoints dictionary', () => {
    const spec = {
      ...validCodeZipAgent,
      endpoints: {
        prod: { version: 3, description: 'Production traffic' },
        staging: { version: 2 },
      },
    };
    const result = AgentEnvSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoints).toEqual({
        prod: { version: 3, description: 'Production traffic' },
        staging: { version: 2 },
      });
    }
  });

  it('defaults to undefined when endpoints is not provided', () => {
    const result = AgentEnvSpecSchema.safeParse(validCodeZipAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoints).toBeUndefined();
    }
  });

  it('rejects endpoint name with invalid characters', () => {
    const spec = {
      ...validCodeZipAgent,
      endpoints: {
        'invalid name!': { version: 1 },
      },
    };
    const result = AgentEnvSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  it('rejects endpoint with version less than 1', () => {
    const spec = {
      ...validCodeZipAgent,
      endpoints: {
        prod: { version: 0 },
      },
    };
    const result = AgentEnvSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  it('accepts endpoint with only version (description optional)', () => {
    const spec = {
      ...validCodeZipAgent,
      endpoints: {
        canary: { version: 1 },
      },
    };
    const result = AgentEnvSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx vitest run src/schema/schemas/__tests__/agent-env.test.ts --reporter=verbose`
Expected: FAIL — `endpoints` field not recognized (strict schema rejects unknown keys)

- [ ] **Step 3: Add RuntimeEndpointSchema and endpoints field to AgentEnvSpecSchema**

In `agentcore-cli/src/schema/schemas/agent-env.ts`, add before the `AgentEnvSpecSchema` definition:

```typescript
// ============================================================================
// Runtime Endpoint Schema
// ============================================================================

/**
 * Endpoint name follows the AgentCore API regex for endpoint aliases.
 * https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateAgentRuntimeEndpoint.html
 */
export const RuntimeEndpointNameSchema = z
  .string()
  .min(1, 'Endpoint name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

export const RuntimeEndpointSchema = z.object({
  /** Version number this endpoint points to. Must be >= 1. */
  version: z.number().int().min(1),
  /** Optional human-readable description of this endpoint. */
  description: z.string().max(200).optional(),
});

export type RuntimeEndpoint = z.infer<typeof RuntimeEndpointSchema>;
```

Then add the `endpoints` field to the `AgentEnvSpecSchema` object, after `filesystemConfigurations`:

```typescript
    /** Named endpoints (version aliases) for this runtime. Keys are endpoint names. */
    endpoints: z.record(RuntimeEndpointNameSchema, RuntimeEndpointSchema).optional(),
```

Export the new types from the file:

```typescript
export { RuntimeEndpointNameSchema, RuntimeEndpointSchema };
export type { RuntimeEndpoint };
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx vitest run src/schema/schemas/__tests__/agent-env.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/schema/schemas/agent-env.ts src/schema/schemas/__tests__/agent-env.test.ts
git commit -m "feat: add endpoints field to AgentEnvSpec schema"
```

---

## Task 2: Add `runtimeVersion` to deployed state schema (CLI repo)

**Files:**

- Modify: `agentcore-cli/src/schema/schemas/deployed-state.ts:9-17`
- Test: `agentcore-cli/src/schema/schemas/__tests__/deployed-state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('AgentCoreDeployedStateSchema', () => {
  it('accepts runtimeVersion field', () => {
    const state = {
      runtimeId: 'rt-123',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/rt-123',
      roleArn: 'arn:aws:iam::123456789:role/test',
      runtimeVersion: 3,
    };
    const result = AgentCoreDeployedStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimeVersion).toBe(3);
    }
  });

  it('allows runtimeVersion to be omitted (backwards compatible)', () => {
    const state = {
      runtimeId: 'rt-123',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/rt-123',
      roleArn: 'arn:aws:iam::123456789:role/test',
    };
    const result = AgentCoreDeployedStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx vitest run src/schema/schemas/__tests__/deployed-state.test.ts --reporter=verbose`
Expected: FAIL — `runtimeVersion` not in schema

- [ ] **Step 3: Add runtimeVersion to AgentCoreDeployedStateSchema**

In `agentcore-cli/src/schema/schemas/deployed-state.ts`, modify `AgentCoreDeployedStateSchema`:

```typescript
export const AgentCoreDeployedStateSchema = z.object({
  runtimeId: z.string().min(1),
  runtimeArn: z.string().min(1),
  roleArn: z.string().min(1),
  sessionId: z.string().optional(),
  memoryIds: z.array(z.string()).optional(),
  browserId: z.string().optional(),
  codeInterpreterId: z.string().optional(),
  /** The latest deployed version number of this runtime. */
  runtimeVersion: z.number().int().min(1).optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx vitest run src/schema/schemas/__tests__/deployed-state.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/schema/schemas/deployed-state.ts src/schema/schemas/__tests__/deployed-state.test.ts
git commit -m "feat: add runtimeVersion to deployed state for version tracking"
```

---

## Task 3: Add `'runtime-endpoint'` to ResourceType union (CLI repo)

**Files:**

- Modify: `agentcore-cli/src/cli/commands/remove/types.ts:1-10`
- Modify: `agentcore-cli/src/cli/commands/status/action.ts:12-28`

- [ ] **Step 1: Add 'runtime-endpoint' to ResourceType**

In `agentcore-cli/src/cli/commands/remove/types.ts`:

```typescript
export type ResourceType =
  | 'agent'
  | 'gateway'
  | 'gateway-target'
  | 'runtime-endpoint'
  | 'memory'
  | 'credential'
  | 'evaluator'
  | 'online-eval'
  | 'policy-engine'
  | 'policy';
```

- [ ] **Step 2: Add 'runtime-endpoint' to ResourceStatusEntry.resourceType**

In `agentcore-cli/src/cli/commands/status/action.ts`, update the `ResourceStatusEntry` interface:

```typescript
export interface ResourceStatusEntry {
  resourceType:
    | 'agent'
    | 'memory'
    | 'credential'
    | 'gateway'
    | 'evaluator'
    | 'online-eval'
    | 'policy-engine'
    | 'policy'
    | 'runtime-endpoint';
  name: string;
  deploymentState: ResourceDeploymentState;
  identifier?: string;
  detail?: string;
  error?: string;
  invocationUrl?: string;
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/cli/commands/remove/types.ts src/cli/commands/status/action.ts
git commit -m "feat: add runtime-endpoint to ResourceType and ResourceStatusEntry"
```

---

## Task 4: Create RuntimeEndpointPrimitive (CLI repo)

**Files:**

- Create: `agentcore-cli/src/cli/primitives/RuntimeEndpointPrimitive.ts`
- Test: `agentcore-cli/src/cli/primitives/__tests__/RuntimeEndpointPrimitive.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import type { AgentCoreProjectSpec } from '../../../schema';
import { RuntimeEndpointPrimitive } from '../RuntimeEndpointPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// We'll test the primitive's core logic via its public methods
// Mock ConfigIO to avoid filesystem access
vi.mock('../../../lib', () => ({
  ConfigIO: vi.fn().mockImplementation(() => ({
    readProjectSpec: vi.fn(),
    writeProjectSpec: vi.fn(),
    configExists: vi.fn().mockReturnValue(false),
  })),
  findConfigRoot: vi.fn().mockReturnValue('/mock/agentcore'),
  requireConfigRoot: vi.fn().mockReturnValue('/mock/agentcore'),
}));

describe('RuntimeEndpointPrimitive', () => {
  let primitive: RuntimeEndpointPrimitive;

  beforeEach(() => {
    primitive = new RuntimeEndpointPrimitive();
  });

  it('has kind "runtime-endpoint"', () => {
    expect(primitive.kind).toBe('runtime-endpoint');
  });

  it('has label "Runtime Endpoint"', () => {
    expect(primitive.label).toBe('Runtime Endpoint');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx vitest run src/cli/primitives/__tests__/RuntimeEndpointPrimitive.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Create RuntimeEndpointPrimitive**

Create `agentcore-cli/src/cli/primitives/RuntimeEndpointPrimitive.ts`:

```typescript
import { findConfigRoot } from '../../lib';
import type { AgentCoreProjectSpec, RuntimeEndpoint } from '../../schema';
import { RuntimeEndpointSchema } from '../../schema';
import type { ResourceType } from '../commands/remove/types';
import { getErrorMessage } from '../errors';
import type { SchemaChange } from '../operations/remove/types';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import type { AddResult, AddScreenComponent, RemovableResource, RemovalPreview, RemovalResult } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Options for adding a runtime endpoint (CLI-level).
 */
export interface AddRuntimeEndpointOptions {
  runtime: string;
  endpoint: string;
  version?: number;
  description?: string;
}

/**
 * Removable runtime endpoint with parent runtime info.
 */
export interface RemovableRuntimeEndpoint extends RemovableResource {
  runtimeName: string;
  endpointName: string;
  version: number;
  description?: string;
}

/**
 * RuntimeEndpointPrimitive handles all runtime endpoint add/remove operations.
 * Follows the sub-resource pattern established by GatewayTargetPrimitive.
 */
export class RuntimeEndpointPrimitive extends BasePrimitive<AddRuntimeEndpointOptions, RemovableRuntimeEndpoint> {
  readonly kind: ResourceType = 'runtime-endpoint';
  readonly label = 'Runtime Endpoint';
  readonly primitiveSchema = RuntimeEndpointSchema;

  async add(options: AddRuntimeEndpointOptions): Promise<AddResult> {
    try {
      const project = await this.readProjectSpec();

      // Validate runtime exists
      const runtime = project.runtimes.find(r => r.name === options.runtime);
      if (!runtime) {
        return { success: false, error: `Runtime "${options.runtime}" not found in agentcore.json.` };
      }

      // Initialize endpoints if needed
      if (!runtime.endpoints) {
        runtime.endpoints = {};
      }

      // Check for duplicate endpoint name
      if (runtime.endpoints[options.endpoint]) {
        return {
          success: false,
          error: `Endpoint "${options.endpoint}" already exists on runtime "${options.runtime}".`,
        };
      }

      // Build endpoint config
      const endpointConfig: RuntimeEndpoint = {
        version: options.version ?? 1,
        ...(options.description && { description: options.description }),
      };

      // Validate
      RuntimeEndpointSchema.parse(endpointConfig);

      runtime.endpoints[options.endpoint] = endpointConfig;
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(name: string): Promise<RemovalResult> {
    try {
      const project = await this.readProjectSpec();

      // Find the endpoint across all runtimes
      for (const runtime of project.runtimes) {
        if (runtime.endpoints && runtime.endpoints[name]) {
          delete runtime.endpoints[name];
          // Clean up empty endpoints object
          if (Object.keys(runtime.endpoints).length === 0) {
            delete runtime.endpoints;
          }
          await this.writeProjectSpec(project);
          return { success: true };
        }
      }

      return { success: false, error: `Runtime endpoint "${name}" not found.` };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async previewRemove(name: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    for (const runtime of project.runtimes) {
      if (runtime.endpoints && runtime.endpoints[name]) {
        const endpoint = runtime.endpoints[name];
        const summary = [
          `Removing endpoint "${name}" from runtime "${runtime.name}"`,
          `Version: ${endpoint.version}`,
          ...(endpoint.description ? [`Description: ${endpoint.description}`] : []),
        ];

        // Check cross-references: gateway targets that use this endpoint as a qualifier
        const blockingRefs = this.findGatewayTargetReferences(project, runtime.name, name);
        if (blockingRefs.length > 0) {
          const refList = blockingRefs.map(ref => `"${ref.targetName}" in gateway "${ref.gatewayName}"`).join(', ');
          throw new Error(
            `Cannot remove endpoint "${name}" — it is referenced by gateway target ${refList}. Remove the gateway target first.`
          );
        }

        const afterProject = structuredClone(project);
        const afterRuntime = afterProject.runtimes.find(r => r.name === runtime.name)!;
        delete afterRuntime.endpoints![name];
        if (Object.keys(afterRuntime.endpoints!).length === 0) {
          delete afterRuntime.endpoints;
        }

        const schemaChanges: SchemaChange[] = [
          {
            file: 'agentcore/agentcore.json',
            before: project,
            after: afterProject,
          },
        ];

        return { summary, directoriesToDelete: [], schemaChanges };
      }
    }

    throw new Error(`Runtime endpoint "${name}" not found.`);
  }

  async getRemovable(): Promise<RemovableRuntimeEndpoint[]> {
    try {
      const project = await this.readProjectSpec();
      const endpoints: RemovableRuntimeEndpoint[] = [];

      for (const runtime of project.runtimes) {
        if (runtime.endpoints) {
          for (const [endpointName, config] of Object.entries(runtime.endpoints)) {
            endpoints.push({
              name: endpointName,
              type: 'runtime-endpoint',
              runtimeName: runtime.name,
              endpointName,
              version: config.version,
              description: config.description,
            });
          }
        }
      }

      return endpoints;
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('runtime-endpoint')
      .description('Add a named endpoint (version alias) to a runtime')
      .requiredOption('--runtime <name>', 'Runtime to add the endpoint to')
      .requiredOption('--endpoint <name>', 'Endpoint name')
      .option('--version <number>', 'Version number (defaults to latest)', parseInt)
      .option('--description <desc>', 'Endpoint description')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          runtime: string;
          endpoint: string;
          version?: number;
          description?: string;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            const result = await this.add({
              runtime: cliOptions.runtime,
              endpoint: cliOptions.endpoint,
              version: cliOptions.version,
              description: cliOptions.description,
            });

            if (cliOptions.json) {
              console.log(JSON.stringify(result));
            } else if (result.success) {
              console.log(`Added endpoint '${cliOptions.endpoint}' to runtime '${cliOptions.runtime}'.`);
              console.log('Run `agentcore deploy` to create the endpoint.');
            } else {
              console.error(result.error);
            }

            process.exit(result.success ? 0 : 1);
          } catch (error) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
            } else {
              console.error(`Error: ${getErrorMessage(error)}`);
            }
            process.exit(1);
          }
        }
      );

    removeCmd
      .command('runtime-endpoint')
      .description('Remove a runtime endpoint from the project')
      .option('--name <name>', 'Name of endpoint to remove [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; yes?: boolean; json?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.yes || cliOptions.json) {
            if (!cliOptions.name) {
              console.log(JSON.stringify({ success: false, error: '--name is required' }));
              process.exit(1);
            }

            const result = await this.remove(cliOptions.name);
            console.log(
              JSON.stringify({
                success: result.success,
                resourceType: this.kind,
                resourceName: cliOptions.name,
                message: result.success ? `Removed runtime endpoint '${cliOptions.name}'` : undefined,
                note: result.success ? SOURCE_CODE_NOTE : undefined,
                error: !result.success ? result.error : undefined,
              })
            );
            process.exit(result.success ? 0 : 1);
          } else {
            // TUI fallback
            const [{ render }, { default: React }, { RemoveFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/remove'),
            ]);
            const { clear, unmount } = render(
              React.createElement(RemoveFlow, {
                isInteractive: false,
                force: cliOptions.yes,
                initialResourceType: this.kind,
                initialResourceName: cliOptions.name,
                onExit: () => {
                  clear();
                  unmount();
                  process.exit(0);
                },
              })
            );
          }
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            console.error(`Error: ${getErrorMessage(error)}`);
          }
          process.exit(1);
        }
      });
  }

  addScreen(): AddScreenComponent {
    return null; // TUI add screen is handled via AddRuntimeEndpointFlow in AddFlow.tsx
  }

  /**
   * Find gateway targets that reference a specific runtime endpoint as a qualifier.
   * Used for cross-reference validation during remove.
   */
  private findGatewayTargetReferences(
    project: AgentCoreProjectSpec,
    _runtimeName: string,
    _endpointName: string
  ): { gatewayName: string; targetName: string }[] {
    // Future: when gateway targets support endpoint qualifiers, check here.
    // For now, return empty — no cross-references exist yet.
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx vitest run src/cli/primitives/__tests__/RuntimeEndpointPrimitive.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/cli/primitives/RuntimeEndpointPrimitive.ts src/cli/primitives/__tests__/RuntimeEndpointPrimitive.test.ts
git commit -m "feat: add RuntimeEndpointPrimitive with add/remove/preview logic"
```

---

## Task 5: Register primitive in registry and exports (CLI repo)

**Files:**

- Modify: `agentcore-cli/src/cli/primitives/registry.ts`
- Modify: `agentcore-cli/src/cli/primitives/index.ts`

- [ ] **Step 1: Add to registry.ts**

Add import at top:

```typescript
import { RuntimeEndpointPrimitive } from './RuntimeEndpointPrimitive';
```

Add singleton after `policyPrimitive`:

```typescript
export const runtimeEndpointPrimitive = new RuntimeEndpointPrimitive();
```

Add to `ALL_PRIMITIVES` array (after `policyPrimitive`):

```typescript
export const ALL_PRIMITIVES: BasePrimitive<unknown, RemovableResource>[] = [
  agentPrimitive,
  memoryPrimitive,
  credentialPrimitive,
  evaluatorPrimitive,
  onlineEvalConfigPrimitive,
  gatewayPrimitive,
  gatewayTargetPrimitive,
  policyEnginePrimitive,
  policyPrimitive,
  runtimeEndpointPrimitive,
];
```

- [ ] **Step 2: Add to index.ts barrel export**

In `agentcore-cli/src/cli/primitives/index.ts`, add:

```typescript
export { RuntimeEndpointPrimitive } from './RuntimeEndpointPrimitive';
export type { AddRuntimeEndpointOptions, RemovableRuntimeEndpoint } from './RuntimeEndpointPrimitive';
```

- [ ] **Step 3: Verify build passes**

Run: `cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx tsc --noEmit` Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/cli/primitives/registry.ts src/cli/primitives/index.ts
git commit -m "feat: register RuntimeEndpointPrimitive in registry"
```

---

## Task 6: Add runtime-endpoint to TUI Add flow (CLI repo)

**Files:**

- Modify: `agentcore-cli/src/cli/tui/screens/add/AddScreen.tsx:4-13`
- Modify: `agentcore-cli/src/cli/tui/screens/add/AddFlow.tsx`
- Create: `agentcore-cli/src/cli/tui/screens/runtime-endpoint/types.ts`
- Create: `agentcore-cli/src/cli/tui/screens/runtime-endpoint/useAddRuntimeEndpointWizard.ts`
- Create: `agentcore-cli/src/cli/tui/screens/runtime-endpoint/AddRuntimeEndpointScreen.tsx`
- Create: `agentcore-cli/src/cli/tui/screens/runtime-endpoint/AddRuntimeEndpointFlow.tsx`
- Create: `agentcore-cli/src/cli/tui/screens/runtime-endpoint/index.ts`

- [ ] **Step 1: Create types.ts**

Create `agentcore-cli/src/cli/tui/screens/runtime-endpoint/types.ts`:

```typescript
export interface RuntimeEndpointWizardConfig {
  runtimeName: string;
  endpointName: string;
  version: number;
  description?: string;
}

export type RuntimeEndpointWizardStep = 'runtime' | 'endpoint' | 'confirm';
```

- [ ] **Step 2: Create useAddRuntimeEndpointWizard.ts**

Create `agentcore-cli/src/cli/tui/screens/runtime-endpoint/useAddRuntimeEndpointWizard.ts`:

```typescript
import type { RuntimeEndpointWizardConfig, RuntimeEndpointWizardStep } from './types';
import { useCallback, useMemo, useState } from 'react';

const BASE_STEPS: RuntimeEndpointWizardStep[] = ['runtime', 'endpoint', 'confirm'];

export function useAddRuntimeEndpointWizard(runtimes: { name: string }[]) {
  const [step, setStep] = useState<RuntimeEndpointWizardStep>(runtimes.length === 1 ? 'endpoint' : 'runtime');
  const [config, setConfig] = useState<Partial<RuntimeEndpointWizardConfig>>(() => ({
    runtimeName: runtimes.length === 1 ? runtimes[0].name : undefined,
    version: 1,
  }));

  const steps = useMemo(() => {
    if (runtimes.length === 1) {
      return BASE_STEPS.filter(s => s !== 'runtime');
    }
    return BASE_STEPS;
  }, [runtimes.length]);

  const nextStep = useCallback(
    (current: RuntimeEndpointWizardStep) => {
      const idx = steps.indexOf(current);
      return idx < steps.length - 1 ? steps[idx + 1] : undefined;
    },
    [steps]
  );

  const goBack = useCallback(() => {
    const idx = steps.indexOf(step);
    if (idx > 0) {
      setStep(steps[idx - 1]);
    }
  }, [step, steps]);

  const setRuntime = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, runtimeName: name }));
      const next = nextStep('runtime');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setEndpointDetails = useCallback(
    (endpointName: string, version: number, description?: string) => {
      setConfig(c => ({ ...c, endpointName, version, description }));
      const next = nextStep('endpoint');
      if (next) setStep(next);
    },
    [nextStep]
  );

  return {
    step,
    config: config as RuntimeEndpointWizardConfig,
    steps,
    goBack,
    setRuntime,
    setEndpointDetails,
  };
}
```

- [ ] **Step 3: Create AddRuntimeEndpointScreen.tsx**

Create `agentcore-cli/src/cli/tui/screens/runtime-endpoint/AddRuntimeEndpointScreen.tsx`:

```typescript
import type { AgentEnvSpec } from '../../../../schema';
import { Panel, Screen, TextInput, WizardSelect } from '../../components';
import { useAddRuntimeEndpointWizard } from './useAddRuntimeEndpointWizard';
import type { RuntimeEndpointWizardConfig } from './types';
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';

interface AddRuntimeEndpointScreenProps {
  runtimes: AgentEnvSpec[];
  onComplete: (config: RuntimeEndpointWizardConfig) => void;
  onBack: () => void;
  onExit: () => void;
}

export function AddRuntimeEndpointScreen({
  runtimes,
  onComplete,
  onBack,
  onExit,
}: AddRuntimeEndpointScreenProps) {
  const wizard = useAddRuntimeEndpointWizard(runtimes);
  const [endpointName, setEndpointName] = useState('');
  const [version, setVersion] = useState('1');
  const [description, setDescription] = useState('');
  const [inputField, setInputField] = useState<'name' | 'version' | 'description'>('name');

  const stepLabels = wizard.steps.map((s, i) => {
    const idx = wizard.steps.indexOf(wizard.step);
    const label = s === 'runtime' ? 'Runtime' : s === 'endpoint' ? 'Endpoint' : 'Confirm';
    if (i < idx) return `✓ ${label}`;
    if (i === idx) return `[${i + 1} ${label}]`;
    return `${i + 1} ${label}`;
  });

  const handleBack = () => {
    if (wizard.steps.indexOf(wizard.step) === 0) {
      onBack();
    } else {
      wizard.goBack();
    }
  };

  useInput((_input, key) => {
    if (key.escape) {
      handleBack();
    }
  });

  return (
    <Screen title="Add Runtime Endpoint" onExit={onExit}>
      <Panel>
        <Text dimColor>Step: {stepLabels.join(' → ')}</Text>
        <Box marginTop={1} flexDirection="column">
          {wizard.step === 'runtime' && (
            <WizardSelect
              label="Select runtime:"
              items={runtimes.map(r => ({
                id: r.name,
                title: r.name,
                description: r.build,
              }))}
              onSelect={item => wizard.setRuntime(item.id)}
              isActive={true}
            />
          )}

          {wizard.step === 'endpoint' && (
            <Box flexDirection="column">
              <Text>Runtime: <Text color="cyan">{wizard.config.runtimeName}</Text></Text>
              <Box marginTop={1} flexDirection="column">
                {inputField === 'name' && (
                  <Box>
                    <Text>Endpoint name: </Text>
                    <TextInput
                      value={endpointName}
                      onChange={setEndpointName}
                      onSubmit={() => {
                        if (endpointName.trim()) setInputField('version');
                      }}
                    />
                  </Box>
                )}
                {inputField === 'version' && (
                  <Box flexDirection="column">
                    <Text>Endpoint name: <Text color="cyan">{endpointName}</Text></Text>
                    <Box>
                      <Text>Version: </Text>
                      <TextInput
                        value={version}
                        onChange={setVersion}
                        onSubmit={() => setInputField('description')}
                      />
                    </Box>
                  </Box>
                )}
                {inputField === 'description' && (
                  <Box flexDirection="column">
                    <Text>Endpoint name: <Text color="cyan">{endpointName}</Text></Text>
                    <Text>Version: <Text color="cyan">{version}</Text></Text>
                    <Box>
                      <Text>Description (optional): </Text>
                      <TextInput
                        value={description}
                        onChange={setDescription}
                        onSubmit={() => {
                          wizard.setEndpointDetails(
                            endpointName.trim(),
                            parseInt(version, 10) || 1,
                            description.trim() || undefined
                          );
                        }}
                      />
                    </Box>
                  </Box>
                )}
              </Box>
            </Box>
          )}

          {wizard.step === 'confirm' && (
            <Box flexDirection="column">
              <Text bold>Review Runtime Endpoint</Text>
              <Text dimColor>{'─'.repeat(25)}</Text>
              <Text>Runtime:     <Text color="cyan">{wizard.config.runtimeName}</Text></Text>
              <Text>Endpoint:    <Text color="cyan">{wizard.config.endpointName}</Text></Text>
              <Text>Version:     <Text color="cyan">{wizard.config.version}</Text></Text>
              {wizard.config.description && (
                <Text>Description: <Text color="cyan">{wizard.config.description}</Text></Text>
              )}
              <Box marginTop={1}>
                <Text dimColor>⏎ confirm  esc go back</Text>
              </Box>
            </Box>
          )}
        </Box>
      </Panel>
    </Screen>
  );
}
```

Note: The confirm step's enter-to-submit behavior needs to be wired via `useInput` — the implementer should check the
existing patterns in `AddMemoryScreen.tsx` for the exact `useInput` + confirm pattern and replicate it.

- [ ] **Step 4: Create AddRuntimeEndpointFlow.tsx**

Create `agentcore-cli/src/cli/tui/screens/runtime-endpoint/AddRuntimeEndpointFlow.tsx`:

```typescript
import { ConfigIO } from '../../../../lib';
import type { AgentEnvSpec } from '../../../../schema';
import { runtimeEndpointPrimitive } from '../../../primitives/registry';
import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddRuntimeEndpointScreen } from './AddRuntimeEndpointScreen';
import type { RuntimeEndpointWizardConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'create-wizard'; runtimes: AgentEnvSpec[] }
  | { name: 'create-success'; endpointName: string; runtimeName: string }
  | { name: 'error'; message: string };

interface AddRuntimeEndpointFlowProps {
  isInteractive: boolean;
  onBack: () => void;
  onExit: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddRuntimeEndpointFlow(props: AddRuntimeEndpointFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  useEffect(() => {
    void (async () => {
      try {
        const configIO = new ConfigIO();
        const project = await configIO.readProjectSpec();
        if (project.runtimes.length === 0) {
          setFlow({ name: 'error', message: 'No runtimes found. Add an agent first with `agentcore add agent`.' });
          return;
        }
        setFlow({ name: 'create-wizard', runtimes: project.runtimes });
      } catch (err) {
        setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
      }
    })();
  }, []);

  const handleComplete = useCallback(async (config: RuntimeEndpointWizardConfig) => {
    const result = await runtimeEndpointPrimitive.add({
      runtime: config.runtimeName,
      endpoint: config.endpointName,
      version: config.version,
      description: config.description,
    });
    if (result.success) {
      setFlow({ name: 'create-success', endpointName: config.endpointName, runtimeName: config.runtimeName });
    } else {
      setFlow({ name: 'error', message: result.error ?? 'Failed to add endpoint' });
    }
  }, []);

  // Non-interactive: exit after success
  useEffect(() => {
    if (!props.isInteractive && flow.name === 'create-success') {
      props.onExit();
    }
  }, [props.isInteractive, flow.name, props.onExit]);

  if (flow.name === 'loading') {
    return null;
  }

  if (flow.name === 'create-wizard') {
    return (
      <AddRuntimeEndpointScreen
        runtimes={flow.runtimes}
        onComplete={(config) => void handleComplete(config)}
        onBack={props.onBack}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={props.isInteractive}
        message={`Added endpoint: ${flow.endpointName} → ${flow.runtimeName}`}
        detail="Run `agentcore deploy` to create the endpoint."
        onAddAnother={props.onBack}
        onDeploy={props.onDeploy}
        onExit={props.onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add runtime endpoint"
      detail={flow.message}
      onBack={props.onBack}
      onExit={props.onExit}
    />
  );
}
```

- [ ] **Step 5: Create index.ts barrel**

Create `agentcore-cli/src/cli/tui/screens/runtime-endpoint/index.ts`:

```typescript
export { AddRuntimeEndpointFlow } from './AddRuntimeEndpointFlow';
export { AddRuntimeEndpointScreen } from './AddRuntimeEndpointScreen';
export type { RuntimeEndpointWizardConfig } from './types';
```

- [ ] **Step 6: Add to AddScreen.tsx**

In `agentcore-cli/src/cli/tui/screens/add/AddScreen.tsx`, add to `ADD_RESOURCES` array (after `'gateway-target'`):

```typescript
{ id: 'runtime-endpoint', title: 'Runtime Endpoint', description: 'Named endpoint (version alias) for a runtime' },
```

- [ ] **Step 7: Add to AddFlow.tsx**

In `agentcore-cli/src/cli/tui/screens/add/AddFlow.tsx`:

1. Add import:

```typescript
import { AddRuntimeEndpointFlow } from '../runtime-endpoint';
```

2. Add to `FlowState` union:

```typescript
| { name: 'runtime-endpoint-wizard' }
```

3. Add to `getInitialFlowState`:

```typescript
case 'runtime-endpoint':
  return { name: 'runtime-endpoint-wizard' };
```

4. Add to `handleSelectResource`:

```typescript
case 'runtime-endpoint':
  setFlow({ name: 'runtime-endpoint-wizard' });
  break;
```

5. Add render block (after the policy-wizard block):

```typescript
if (flow.name === 'runtime-endpoint-wizard') {
  return (
    <AddRuntimeEndpointFlow
      isInteractive={props.isInteractive}
      onExit={props.onExit}
      onBack={() => setFlow({ name: 'select' })}
      onDev={props.onDev}
      onDeploy={props.onDeploy}
    />
  );
}
```

- [ ] **Step 8: Verify build passes**

Run: `cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx tsc --noEmit` Expected: No errors

- [ ] **Step 9: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/cli/tui/screens/runtime-endpoint/ src/cli/tui/screens/add/AddScreen.tsx src/cli/tui/screens/add/AddFlow.tsx
git commit -m "feat: add runtime-endpoint TUI add flow"
```

---

## Task 7: Add runtime-endpoint to TUI Remove flow (CLI repo)

**Files:**

- Create: `agentcore-cli/src/cli/tui/screens/remove/RemoveRuntimeEndpointScreen.tsx`
- Modify: `agentcore-cli/src/cli/tui/screens/remove/RemoveFlow.tsx`
- Modify: `agentcore-cli/src/cli/tui/screens/remove/RemoveScreen.tsx`
- Modify: `agentcore-cli/src/cli/tui/hooks/useRemove.ts`

- [ ] **Step 1: Add hooks to useRemove.ts**

In `agentcore-cli/src/cli/tui/hooks/useRemove.ts`, add:

```typescript
import type { RemovableRuntimeEndpoint } from '../../primitives/RuntimeEndpointPrimitive';
import { runtimeEndpointPrimitive } from '../../primitives/registry';

export function useRemovableRuntimeEndpoints() {
  const { items: endpoints, ...rest } = useRemovableResources(() => runtimeEndpointPrimitive.getRemovable());
  return { endpoints, ...rest };
}

export function useRemoveRuntimeEndpoint() {
  return useRemoveResource<string>(
    async (name, preview) => runtimeEndpointPrimitive.remove(name),
    'runtime-endpoint',
    name => name
  );
}
```

Also add a `loadRuntimeEndpointPreview` function to the `useRemovalPreview` hook:

```typescript
const loadRuntimeEndpointPreview = useCallback(async (name: string) => {
  try {
    const preview = await runtimeEndpointPrimitive.previewRemove(name);
    return { ok: true as const, preview };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}, []);
```

Return it from the hook alongside the others.

- [ ] **Step 2: Create RemoveRuntimeEndpointScreen.tsx**

Create `agentcore-cli/src/cli/tui/screens/remove/RemoveRuntimeEndpointScreen.tsx`:

```typescript
import type { RemovableRuntimeEndpoint } from '../../../primitives/RuntimeEndpointPrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveRuntimeEndpointScreenProps {
  endpoints: RemovableRuntimeEndpoint[];
  onSelect: (name: string) => void;
  onExit: () => void;
}

export function RemoveRuntimeEndpointScreen({ endpoints, onSelect, onExit }: RemoveRuntimeEndpointScreenProps) {
  if (endpoints.length === 0) {
    return null;
  }

  const items = endpoints.map(ep => ({
    id: ep.name,
    title: `${ep.name}`,
    description: `${ep.runtimeName} v${ep.version}${ep.description ? ` — ${ep.description}` : ''}`,
  }));

  return (
    <SelectScreen
      title="Remove Runtime Endpoint"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
```

- [ ] **Step 3: Wire into RemoveFlow.tsx**

In `agentcore-cli/src/cli/tui/screens/remove/RemoveFlow.tsx`:

1. Add imports for the new hooks and screen.
2. Add flow states to the `FlowState` union:

```typescript
| { name: 'select-runtime-endpoint' }
| { name: 'confirm-runtime-endpoint'; endpointName: string; preview: RemovalPreview }
| { name: 'runtime-endpoint-success'; endpointName: string; logFilePath?: string }
```

3. Add data hook:
   `const { endpoints: runtimeEndpoints, isLoading: isLoadingRuntimeEndpoints, refresh: refreshRuntimeEndpoints } = useRemovableRuntimeEndpoints();`
4. Add to `isLoading` computation.
5. Add `handleSelectRuntimeEndpoint` callback (same pattern as others).
6. Add `handleConfirmRuntimeEndpoint` callback.
7. Add `case 'runtime-endpoint':` to `handleSelectResource` and `getInitialState`.
8. Add render blocks for `select-runtime-endpoint`, `confirm-runtime-endpoint`, and `runtime-endpoint-success`.
9. Add to `resetAll` and `refreshAll`.
10. Add to the `RemoveScreen` component's props (endpointCount).

- [ ] **Step 4: Add to RemoveScreen.tsx**

Add `'runtime-endpoint'` to the remove resources list with a count badge.

- [ ] **Step 5: Verify build passes**

Run: `cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx tsc --noEmit` Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/cli/tui/screens/remove/ src/cli/tui/hooks/useRemove.ts
git commit -m "feat: add runtime-endpoint TUI remove flow"
```

---

## Task 8: Display endpoints in status and ResourceGraph (CLI repo)

**Files:**

- Modify: `agentcore-cli/src/cli/tui/components/ResourceGraph.tsx`
- Modify: `agentcore-cli/src/cli/commands/status/action.ts`

- [ ] **Step 1: Add endpoint display to ResourceGraph**

In `agentcore-cli/src/cli/tui/components/ResourceGraph.tsx`, modify the Agents section to render endpoints nested under
each agent. After the `ResourceRow` for each agent, add:

```typescript
{agent.endpoints && Object.entries(agent.endpoints).map(([epName, ep]) => (
  <Text key={epName}>
    {'    '}
    <Text color="green">◉</Text> {epName}
    <Text color="gray">{' '}v{ep.version}</Text>
    {ep.description && <Text color="gray">{' '}{ep.description}</Text>}
  </Text>
))}
```

- [ ] **Step 2: Update status action to include version in deployed state**

In `agentcore-cli/src/cli/commands/status/action.ts`, in the `computeResourceStatuses` function, update the agents
section to include version info in the detail field when available:

```typescript
const agents = diffResourceSet({
  resourceType: 'agent',
  localItems: project.runtimes,
  deployedRecord: resources?.runtimes ?? {},
  getIdentifier: deployed => deployed.runtimeArn,
  getLocalDetail: item => {
    const endpointCount = item.endpoints ? Object.keys(item.endpoints).length : 0;
    return endpointCount > 0 ? `${endpointCount} endpoint${endpointCount !== 1 ? 's' : ''}` : undefined;
  },
});
```

- [ ] **Step 3: Verify build passes**

Run: `cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npx tsc --noEmit` Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add src/cli/tui/components/ResourceGraph.tsx src/cli/commands/status/action.ts
git commit -m "feat: display runtime endpoints in status and resource graph"
```

---

## Task 9: Mirror schema changes in CDK repo

**Files:**

- Modify: `agentcore-l3-cdk-constructs/src/schema/schemas/agent-env.ts`
- Test: `agentcore-l3-cdk-constructs/test/schemas/agent-env.test.ts`

- [ ] **Step 1: Write the failing test**

Same test as Task 1 Step 1 but in the CDK repo's test directory.

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs && npx vitest run test/schemas/agent-env.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Add RuntimeEndpointSchema and endpoints field**

Mirror the exact same schema changes from Task 1 Step 3 into
`agentcore-l3-cdk-constructs/src/schema/schemas/agent-env.ts`. The schemas must be identical across both repos.

- [ ] **Step 4: Run test to verify it passes**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs && npx vitest run test/schemas/agent-env.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs
git add src/schema/schemas/agent-env.ts test/schemas/agent-env.test.ts
git commit -m "feat: add endpoints field to AgentEnvSpec schema (CDK)"
```

---

## Task 10: Add CDK construct support for runtime endpoints

**Files:**

- Modify: `agentcore-l3-cdk-constructs/src/cdk/constructs/l3/AgentEnvironment.ts`
- Modify: `agentcore-l3-cdk-constructs/src/cdk/constructs/components/mcp/mcp-utils.ts`
- Test: `agentcore-l3-cdk-constructs/test/constructs/agent-environment.test.ts`

**Important note:** There is no `CfnRuntimeEndpoint` L1 construct yet in `aws-cdk-lib`. The implementer must check
whether `aws_bedrockagentcore.CfnRuntimeEndpoint` exists in the version of `aws-cdk-lib` used (currently ^2.248.0). If
it does not exist:

- Option A: Use `cdk.CfnResource` with resource type `AWS::BedrockAgentCore::RuntimeEndpoint` directly.
- Option B: Wait for the L1 to be generated and skip this task until then.

The plan below assumes Option A (CfnResource) as a fallback.

- [ ] **Step 1: Write the failing test**

```typescript
describe('AgentEnvironment with endpoints', () => {
  it('creates CfnResource for each endpoint in the spec', () => {
    const stack = new cdk.Stack();
    const agent: AgentEnvSpec = {
      ...validCodeZipAgent,
      endpoints: {
        prod: { version: 3, description: 'Production traffic' },
        staging: { version: 2 },
      },
    };

    new AgentEnvironment(stack, 'TestEnv', {
      projectName: 'TestProject',
      agent,
      configRoot: '/tmp/test',
    });

    const template = Template.fromStack(stack);
    // Verify endpoint resources are created
    template.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs && npx vitest run test/constructs/agent-environment.test.ts --reporter=verbose`
Expected: FAIL — no endpoint resources created

- [ ] **Step 3: Add getRuntimeEndpointUrlWithQualifier to mcp-utils.ts**

In `agentcore-l3-cdk-constructs/src/cdk/constructs/components/mcp/mcp-utils.ts`:

```typescript
/** Runtime endpoint URL template with custom qualifier */
export const RUNTIME_ENDPOINT_URL_WITH_QUALIFIER_TEMPLATE =
  'https://bedrock-agentcore.${AWS::Region}.${AWS::URLSuffix}/runtimes/${EncodedArn}/invocations?qualifier=${Qualifier}';

/**
 * Generates a runtime endpoint URL with a specific qualifier (endpoint name).
 */
export function getRuntimeEndpointUrlWithQualifier(runtimeArn: string, qualifier: string): string {
  const encodedArn = urlEncodeArn(runtimeArn);
  return Fn.sub(RUNTIME_ENDPOINT_URL_WITH_QUALIFIER_TEMPLATE, {
    EncodedArn: encodedArn,
    Qualifier: qualifier,
  });
}
```

- [ ] **Step 4: Create endpoint resources in AgentEnvironment**

In `agentcore-l3-cdk-constructs/src/cdk/constructs/l3/AgentEnvironment.ts`, after the runtime is created and env vars
are added, add endpoint creation:

```typescript
// Create runtime endpoints (version aliases)
if (agent.endpoints) {
  for (const [endpointName, endpointConfig] of Object.entries(agent.endpoints)) {
    new cdk.CfnResource(this, `Endpoint${toPascalId(endpointName)}`, {
      type: 'AWS::BedrockAgentCore::RuntimeEndpoint',
      properties: {
        AgentRuntimeId: this.runtime.runtimeId,
        Name: endpointName,
        AgentRuntimeVersion: String(endpointConfig.version),
        ...(endpointConfig.description && { Description: endpointConfig.description }),
      },
    });
  }
}
```

Add the import for `toPascalId` from `../../logical-ids` and `cdk` from `aws-cdk-lib`.

- [ ] **Step 5: Run test to verify it passes**

Run:
`cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs && npx vitest run test/constructs/agent-environment.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs
git add src/cdk/constructs/l3/AgentEnvironment.ts src/cdk/constructs/components/mcp/mcp-utils.ts test/constructs/agent-environment.test.ts
git commit -m "feat: create CfnResource for runtime endpoints during CDK synth"
```

---

## Task 11: Update schema exports and run full test suite

**Files:**

- Modify: `agentcore-cli/src/schema/index.ts` (if not auto-exported)
- Modify: `agentcore-l3-cdk-constructs/src/schema/index.ts` (if not auto-exported)

- [ ] **Step 1: Verify CLI schema exports RuntimeEndpoint types**

Check `agentcore-cli/src/schema/index.ts` and ensure `RuntimeEndpoint`, `RuntimeEndpointSchema`,
`RuntimeEndpointNameSchema` are exported. Add if missing.

- [ ] **Step 2: Verify CDK schema exports RuntimeEndpoint types**

Check `agentcore-l3-cdk-constructs/src/schema/index.ts` (or `src/index.ts`) and ensure the same exports. Add if missing.

- [ ] **Step 3: Run full CLI test suite**

Run: `cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli && npm test` Expected: All tests pass.
Fix any snapshot failures with `npm run test:update-snapshots` if the asset files changed.

- [ ] **Step 4: Run full CDK test suite**

Run: `cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs && npm test` Expected: All
tests pass.

- [ ] **Step 5: Commit any remaining fixes**

```bash
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-cli
git add -A && git commit -m "fix: update exports and fix test failures for runtime-endpoint feature"
cd /Users/tjariy/github_workspace/runtime_endpoint_project/agentcore-l3-cdk-constructs
git add -A && git commit -m "fix: update exports and fix test failures for runtime-endpoint feature"
```

---

## Notes for Implementer

### Key decisions

1. **Endpoints are a dictionary, not an array.** Keys are endpoint names, values have `version` and optional
   `description`. This matches the spec: `"prod": { "version": 3, "description": "..." }`.
2. **No CfnRuntimeEndpoint L1 exists yet.** Task 10 uses `cdk.CfnResource` as a fallback. If/when the L1 is available,
   switch to `bedrockagentcore.CfnRuntimeEndpoint`.
3. **Version defaults to 1** when not provided via CLI flag. The spec says "default to latest" — but "latest" requires
   an API call to determine. For V1, default to 1 and document that users should check `agentcore status` for the
   current version.
4. **Cross-reference validation** (gateway targets referencing endpoints) is stubbed out. The spec mentions this as
   future work. The `findGatewayTargetReferences` method is ready for extension.
5. **Deploy behavior** is handled by CDK — no CLI deploy changes needed. The CDK stack reads `agentcore.json`, sees the
   `endpoints` dict, and creates/updates the CFN resources.

### Files NOT changed (intentionally)

- `src/cli/commands/add/command.tsx` — subcommands auto-register via `primitive.registerCommands()` in `cli.ts`.
- `src/cli/commands/remove/command.tsx` — same auto-registration.
- `src/cli/cli.ts` — the `ALL_PRIMITIVES` loop handles registration automatically.
- `src/assets/cdk/` — the vended CDK project imports `@aws/agentcore-cdk` which contains the construct changes.
