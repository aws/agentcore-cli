import { AgentCoreProjectSpecSchema, type AgentCoreProjectSpec } from '@aws/agentcore-cdk';

// Keep in sync with KmsKeyArnSchema in the CLI's schema module.
const KMS_KEY_ARN_PATTERN = /^arn:[^:]+:kms:[a-zA-Z0-9-]*:[0-9]{12}:key\/[a-zA-Z0-9-]{36}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ParsedProjectSpec {
  spec: AgentCoreProjectSpec;
  knowledgeBaseKmsKeys: Record<string, string[]>;
}

/**
 * The published CDK schema does not yet accept S3 encryption keys. Validate
 * those fields here and retain them for the stack's IAM grants, then validate
 * the remaining project with the published schema.
 */
export function parseProjectSpec(input: unknown): ParsedProjectSpec {
  const keys = new Map<string, string[]>();
  let project = input;
  if (isRecord(input) && Array.isArray(input.knowledgeBases)) {
    project = {
      ...input,
      knowledgeBases: input.knowledgeBases.map(kb => {
        if (!isRecord(kb) || !Array.isArray(kb.dataSources)) {
          return kb;
        }
        return {
          ...kb,
          dataSources: kb.dataSources.map(source => {
            if (!isRecord(source) || source.type !== 'S3') {
              return source;
            }
            const { kmsKeyArn, ...dataSource } = source;
            if (kmsKeyArn !== undefined) {
              if (typeof kmsKeyArn !== 'string' || !KMS_KEY_ARN_PATTERN.test(kmsKeyArn)) {
                throw new Error(`Invalid S3 kmsKeyArn for knowledge base '${String(kb.name)}': expected a KMS key ARN`);
              }
              if (typeof kb.name === 'string') {
                const kbKeys = keys.get(kb.name) ?? [];
                kbKeys.push(kmsKeyArn);
                keys.set(kb.name, kbKeys);
              }
            }
            return dataSource;
          }),
        };
      }),
    };
  }
  return { spec: AgentCoreProjectSpecSchema.parse(project), knowledgeBaseKmsKeys: Object.fromEntries(keys) };
}
