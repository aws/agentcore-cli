import type { Memory } from '../../../schema';
import type { MemoryDetail, MemorySummary } from '../../aws/agentcore-control';
import { getMemoryDetail, listAllMemories } from '../../aws/agentcore-control';
import { ANSI } from './constants';
import { parseAndValidateArn } from './import-utils';
import { executeResourceImport } from './resource-import';
import type { ImportResourceOptions, ImportResourceResult, ResourceImportDescriptor } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Map strategy type from AWS API format to CLI schema format.
 * The API returns types like "SEMANTIC_OVERRIDE", "SUMMARY_OVERRIDE", etc.
 * CLI uses "SEMANTIC", "SUMMARIZATION", "USER_PREFERENCE", "EPISODIC".
 */
function mapStrategyType(apiType: string): string {
  const mapping: Record<string, string> = {
    SEMANTIC_OVERRIDE: 'SEMANTIC',
    SUMMARY_OVERRIDE: 'SUMMARIZATION',
    USER_PREFERENCE_OVERRIDE: 'USER_PREFERENCE',
    EPISODIC_OVERRIDE: 'EPISODIC',
    // Direct mappings
    SEMANTIC: 'SEMANTIC',
    SUMMARIZATION: 'SUMMARIZATION',
    USER_PREFERENCE: 'USER_PREFERENCE',
    EPISODIC: 'EPISODIC',
  };
  return mapping[apiType] ?? apiType;
}

/**
 * Filter out API-internal namespace patterns that are auto-generated
 * and should not be included in local config.
 * These patterns contain template variables like {memoryStrategyId}, {actorId}, etc.
 */
function filterInternalNamespaces(namespaces: string[]): string[] {
  return namespaces.filter(ns => !ns.includes('{memoryStrategyId}'));
}

/**
 * Map an AWS GetMemory response to the CLI Memory format.
 */
function toMemorySpec(memory: MemoryDetail, localName: string): Memory {
  const strategies: Memory['strategies'] = memory.strategies.map(s => {
    const mappedType = mapStrategyType(s.type);
    const filteredNamespaces = s.namespaces ? filterInternalNamespaces(s.namespaces) : [];
    return {
      type: mappedType as Memory['strategies'][number]['type'],
      ...(s.name && { name: s.name }),
      ...(s.description && { description: s.description }),
      ...(filteredNamespaces.length > 0 && { namespaces: filteredNamespaces }),
      ...(s.reflectionNamespaces &&
        s.reflectionNamespaces.length > 0 && { reflectionNamespaces: s.reflectionNamespaces }),
    };
  });

  return {
    name: localName,
    eventExpiryDuration: Math.max(7, Math.min(365, memory.eventExpiryDuration)),
    strategies,
    ...(memory.tags && Object.keys(memory.tags).length > 0 && { tags: memory.tags }),
    ...(memory.encryptionKeyArn && { encryptionKeyArn: memory.encryptionKeyArn }),
    ...(memory.executionRoleArn && { executionRoleArn: memory.executionRoleArn }),
  };
}

const memoryDescriptor: ResourceImportDescriptor<MemoryDetail, MemorySummary> = {
  resourceType: 'memory',
  displayName: 'memory',
  logCommand: 'import-memory',

  listResources: region => listAllMemories({ region }),
  getDetail: (region, id) => getMemoryDetail({ region, memoryId: id }),
  parseResourceId: (arn, target) => parseAndValidateArn(arn, 'memory', target).resourceId,

  extractSummaryId: s => s.memoryId,
  formatListItem: (s, i) =>
    `  ${ANSI.dim}[${i + 1}]${ANSI.reset} ${s.memoryId} — ${s.status}\n       ${ANSI.dim}${s.memoryArn}${ANSI.reset}`,
  formatAutoSelectMessage: s => `Found 1 memory: ${s.memoryId}. Auto-selecting.`,

  extractDetailName: d => d.name,
  extractDetailArn: d => d.memoryArn,
  readyStatus: 'ACTIVE',
  extractDetailStatus: d => d.status,

  getExistingNames: spec => (spec.memories ?? []).map(m => m.name),
  addToProjectSpec: (detail, localName, spec) => {
    (spec.memories ??= []).push(toMemorySpec(detail, localName));
  },

  cfnResourceType: 'AWS::BedrockAgentCore::Memory',
  cfnNameProperty: 'Name',
  cfnIdentifierKey: 'MemoryId',

  buildDeployedStateEntry: (name, id, d) => ({ type: 'memory', name, id, arn: d.memoryArn }),
};

/**
 * Handle `agentcore import memory`.
 */
export async function handleImportMemory(options: ImportResourceOptions): Promise<ImportResourceResult> {
  return executeResourceImport(memoryDescriptor, options);
}

/**
 * Register the `import memory` subcommand.
 */
export function registerImportMemory(importCmd: Command): void {
  importCmd
    .command('memory')
    .description('Import an existing AgentCore Memory from your AWS account')
    .option('--arn <memoryArn>', 'Memory ARN to import')
    .option('--name <name>', 'Local name for the imported memory')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(async (cliOptions: ImportResourceOptions) => {
      const result = await handleImportMemory(cliOptions);

      if (result.success) {
        console.log('');
        console.log(`${ANSI.green}Memory imported successfully!${ANSI.reset}`);
        console.log(`  Name: ${result.resourceName}`);
        console.log(`  ID: ${result.resourceId}`);
        console.log('');
      } else {
        console.error(`\n${ANSI.red}[error]${ANSI.reset} ${result.error}`);
        if (result.logPath) {
          console.error(`Log: ${result.logPath}`);
        }
        process.exit(1);
      }
    });
}
