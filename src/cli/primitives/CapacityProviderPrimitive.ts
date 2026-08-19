import { ResourceNotFoundError, ValidationError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { CapacityProvider } from '../../schema';
import { CapacityProviderSchema } from '../../schema';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { OperatingSystem, standardize } from '../telemetry/schemas/common-shapes.js';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Options for adding a capacity provider resource (CLI-level).
 */
export interface AddCapacityProviderOptions {
  name: string;
  operatorRoleArn?: string;
  description?: string;
  subnets: string;
  securityGroups: string;
  os?: string;
  instanceTypes: string;
  volume?: string[];
  volumeEncrypted?: boolean;
  volumeKmsKey?: string;
  instanceProfileArn?: string;
  idleInstanceTimeout?: string;
  maxLifetime?: string;
}

/** Split a comma-separated CLI value into a trimmed, non-empty string array. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * CapacityProviderPrimitive handles capacity provider add/remove operations.
 *
 * A capacity provider is a declarative resource stored in agentcore.json and
 * synthesized to an `AWS::BedrockAgentCore::CapacityProvider` CFN resource by
 * the vended CDK project. Everything except Description/Tags is immutable after
 * creation.
 */
export class CapacityProviderPrimitive extends BasePrimitive<AddCapacityProviderOptions, RemovableResource> {
  readonly kind = 'capacity-provider';
  readonly label = 'Capacity Provider';
  readonly primitiveSchema = CapacityProviderSchema;

  async add(options: AddCapacityProviderOptions): Promise<AddResult<{ capacityProviderName: string }>> {
    try {
      const capacityProvider = this.buildCapacityProvider(options);

      const project = await this.readProjectSpec();
      this.checkDuplicate(project.capacityProviders ?? [], capacityProvider.name);

      project.capacityProviders = [...(project.capacityProviders ?? []), capacityProvider];
      await this.writeProjectSpec(project);

      return { success: true, capacityProviderName: capacityProvider.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(name: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();
      const existing = project.capacityProviders ?? [];

      if (!existing.some(cp => cp.name === name)) {
        return { success: false, error: new ResourceNotFoundError(`Capacity provider "${name}" not found.`) };
      }

      const remaining = existing.filter(cp => cp.name !== name);
      await this.writeProjectSpec({
        ...project,
        capacityProviders: remaining.length > 0 ? remaining : undefined,
      });

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(name: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();
    const existing = project.capacityProviders ?? [];

    if (!existing.some(cp => cp.name === name)) {
      throw new Error(`Capacity provider "${name}" not found.`);
    }

    const remaining = existing.filter(cp => cp.name !== name);
    const schemaChanges: SchemaChange[] = [
      {
        file: 'agentcore/agentcore.json',
        before: project,
        after: { ...project, capacityProviders: remaining.length > 0 ? remaining : undefined },
      },
    ];

    return {
      summary: [`Removing capacity provider: ${name}`],
      directoriesToDelete: [],
      schemaChanges,
    };
  }

  async getRemovable(): Promise<RemovableResource[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.capacityProviders ?? []).map(cp => ({ name: cp.name }));
    } catch {
      return [];
    }
  }

  /** Names of all capacity providers in the project (for duplicate checks in the TUI). */
  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.capacityProviders ?? []).map(cp => cp.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('capacity-provider')
      .description('Add a capacity provider (customer-managed EC2 compute pool for agent runtimes)')
      .option('--name <name>', 'Capacity provider name [non-interactive]')
      .option(
        '--operator-role-arn <arn>',
        'IAM role ARN AgentCore assumes to manage the capacity provider. Optional — omit to have one created automatically [non-interactive]'
      )
      .option('--description <desc>', 'Capacity provider description [non-interactive]')
      .option('--subnets <subnets>', 'Comma-separated subnet IDs (1-16) [non-interactive]')
      .option('--security-groups <groups>', 'Comma-separated security group IDs (1-16) [non-interactive]')
      .option('--os <os>', 'Operating system: LINUX_X86_64 or LINUX_ARM64 (default: LINUX_X86_64) [non-interactive]')
      .option('--instance-types <types>', 'Comma-separated allowed EC2 instance types (1-30) [non-interactive]')
      .option(
        '--volume <name:sizeGiB>',
        'Named EBS volume as name:sizeGiB (repeatable, max 5) [non-interactive]',
        (val: string, prev: string[] = []) => [...prev, val]
      )
      .option('--volume-encrypted', 'Encrypt EBS volumes [non-interactive]')
      .option('--volume-kms-key <arn>', 'KMS key ARN for EBS volume encryption [non-interactive]')
      .option('--instance-profile-arn <arn>', 'IAM instance profile ARN for launched instances [non-interactive]')
      .option('--idle-instance-timeout <seconds>', 'Idle instance timeout in seconds (60-1209600) [non-interactive]')
      .option('--max-lifetime <seconds>', 'Maximum instance lifetime in seconds (60-1209600) [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (rawOptions: Record<string, string | string[] | boolean | undefined>) => {
        const cliOptions = rawOptions as unknown as AddCapacityProviderOptions & { json?: boolean };
        if (!findConfigRoot()) {
          console.error('No agentcore project found. Run `agentcore create` first.');
          process.exit(1);
        }
        await runCliCommand('add.capacity-provider', !!cliOptions.json, async () => {
          this.validateRequiredOptions(cliOptions);

          const result = await this.add(cliOptions);
          if (!result.success) {
            throw result.error;
          }

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else {
            console.log(`Added capacity provider '${result.capacityProviderName}'`);
          }

          const built = this.buildCapacityProvider(cliOptions);
          const ec2 = built.computeConfiguration.ec2Configuration;
          return {
            operating_system: standardize(OperatingSystem, ec2.launchTemplateSource.launchParameters.operatingSystem),
            instance_type_count:
              ec2.launchTemplateSource.launchParameters.instanceRequirements.allowedInstanceTypes.length,
            subnet_count: ec2.vpcConfiguration.subnets.length,
            security_group_count: ec2.vpcConfiguration.securityGroups.length,
            volume_count: ec2.volumes?.length ?? 0,
            has_description: !!built.description,
          };
        });
      });

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  /**
   * Validate that all required CLI flags are present, throwing ValidationError
   * with an actionable message when they are not.
   */
  private validateRequiredOptions(options: AddCapacityProviderOptions): void {
    const missing: string[] = [];
    if (!options.name) missing.push('--name');
    if (!options.subnets) missing.push('--subnets');
    if (!options.securityGroups) missing.push('--security-groups');
    if (!options.instanceTypes) missing.push('--instance-types');
    if (missing.length > 0) {
      throw new ValidationError(`Missing required option(s): ${missing.join(', ')}`);
    }
  }

  /**
   * Build a validated CapacityProvider config from CLI options.
   * Zod validation (via CapacityProviderSchema.parse) rejects bad input here,
   * at `add` time, rather than late at deploy/CFN time.
   */
  private buildCapacityProvider(options: AddCapacityProviderOptions): CapacityProvider {
    const volumes = (options.volume ?? []).map(entry => {
      // Require exactly `name:sizeGiB`. Splitting without a segment count lets `data:20:gp3`
      // silently drop the trailing segment, and Number() accepts hex/exponent (`0x14`, `2e1`)
      // as 20 — so validate the size as literal digits instead of trusting Number().
      const segments = entry.split(':');
      const [volName, sizeRaw] = segments;
      if (segments.length !== 2 || !volName || !sizeRaw || !/^[0-9]+$/.test(sizeRaw)) {
        throw new ValidationError(`Invalid --volume "${entry}". Expected format name:sizeGiB (e.g. data:20).`);
      }
      const sizeGiB = Number(sizeRaw);
      return {
        ebsConfiguration: {
          name: volName,
          sizeGiB,
          ...(options.volumeEncrypted !== undefined && { encrypted: options.volumeEncrypted }),
          ...(options.volumeKmsKey && { kmsKeyId: options.volumeKmsKey }),
        },
      };
    });

    const lifecycle: { idleInstanceTimeout?: number; maxLifetime?: number } = {};
    if (options.idleInstanceTimeout !== undefined) {
      lifecycle.idleInstanceTimeout = Number(options.idleInstanceTimeout);
    }
    if (options.maxLifetime !== undefined) {
      lifecycle.maxLifetime = Number(options.maxLifetime);
    }

    const candidate = {
      name: options.name,
      ...(options.description && { description: options.description }),
      ...(options.operatorRoleArn && { operatorRoleArn: options.operatorRoleArn }),
      computeConfiguration: {
        ec2Configuration: {
          launchTemplateSource: {
            launchParameters: {
              operatingSystem: options.os ?? 'LINUX_X86_64',
              instanceRequirements: {
                allowedInstanceTypes: splitList(options.instanceTypes),
              },
              ...(options.instanceProfileArn && { instanceProfileArn: options.instanceProfileArn }),
            },
          },
          vpcConfiguration: {
            subnets: splitList(options.subnets),
            securityGroups: splitList(options.securityGroups),
          },
          ...(volumes.length > 0 && { volumes }),
          ...(Object.keys(lifecycle).length > 0 && { lifecycleConfiguration: lifecycle }),
        },
      },
    };

    return CapacityProviderSchema.parse(candidate);
  }
}
