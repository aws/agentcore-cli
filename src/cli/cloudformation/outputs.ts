import type {
  AgentCoreDeployedState,
  CapacityProviderDeployedState,
  ConfigBundleDeployedState,
  DatasetDeployedState,
  DeployedState,
  EvaluatorDeployedState,
  HarnessDeployedState,
  KnowledgeBaseDeployedState,
  MemoryDeployedState,
  OnlineEvalDeployedState,
  PaymentConnectorDeployedState,
  PaymentDeployedState,
  PolicyDeployedState,
  PolicyEngineDeployedState,
  RuntimeEndpointDeployedState,
  TargetDeployedState,
} from '../../schema';
import { getCredentialProvider } from '../aws';
import { toPascalId } from './logical-ids';
import { getStackName } from './stack-discovery';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export type StackOutputs = Record<string, string>;

export function omitPaymentAuthorizationOutputs(outputs: StackOutputs): StackOutputs {
  return Object.fromEntries(
    Object.entries(outputs).filter(([key]) => !key.startsWith('Payment') || !key.endsWith('AuthorizationUrl'))
  );
}

/**
 * Fetch CloudFormation stack outputs.
 */
export async function getStackOutputs(region: string, stackName: string): Promise<StackOutputs> {
  const cfn = new CloudFormationClient({ region, credentials: getCredentialProvider() });
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = resp.Stacks?.[0];
  if (!stack) {
    throw new Error(`Stack ${stackName} not found`);
  }

  const outputs: StackOutputs = {};
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey && output.OutputValue) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  return outputs;
}

/**
 * Parse stack outputs into deployed state for gateways.
 *
 * Output key pattern for gateways:
 * Gateway{GatewayName}(Id|Arn|Url)Output{Hash}
 *
 * Output key pattern for gateway targets:
 * GatewayTarget{TargetName}IdOutput{Hash}
 *
 * Examples:
 * - GatewayMyGatewayUrlOutput3E11FAB4
 * - GatewayTargetMyTargetIdOutputA1B2C3D4
 */
export function parseGatewayOutputs(
  outputs: StackOutputs,
  gatewaySpecs: Record<string, unknown>
): Record<
  string,
  { gatewayId: string; gatewayArn: string; gatewayUrl?: string; targets?: Record<string, { targetId: string }> }
> {
  const gateways: Record<
    string,
    { gatewayId: string; gatewayArn: string; gatewayUrl?: string; targets?: Record<string, { targetId: string }> }
  > = {};

  // Map PascalCase gateway names to original names for lookup
  const gatewayNames = Object.keys(gatewaySpecs);
  const gatewayIdMap = new Map(gatewayNames.map(name => [toPascalId(name), name]));

  // Match pattern: Gateway{Name}{Type}Output{Hash}
  const outputPattern = /^Gateway(.+?)(Id|Arn|Url)Output/;
  // Match pattern: GatewayTarget{TargetName}IdOutput{Hash}
  const targetOutputPattern = /^GatewayTarget(.+?)IdOutput/;

  // Collect target outputs separately
  const targetOutputs: { logicalTarget: string; targetId: string }[] = [];

  for (const [key, value] of Object.entries(outputs)) {
    // Check target pattern first (more specific) to avoid false matches with gateway pattern
    const targetMatch = targetOutputPattern.exec(key);
    if (targetMatch) {
      const logicalTarget = targetMatch[1];
      if (logicalTarget) {
        targetOutputs.push({ logicalTarget, targetId: value });
      }
      continue;
    }

    const match = outputPattern.exec(key);
    if (!match) continue;

    const logicalGateway = match[1];
    const outputType = match[2];
    if (!logicalGateway || !outputType) continue;

    // Look up original gateway name from PascalCase version
    const gatewayName = gatewayIdMap.get(logicalGateway) ?? logicalGateway;

    gateways[gatewayName] ??= { gatewayId: gatewayName, gatewayArn: '' };

    if (outputType === 'Id') {
      gateways[gatewayName].gatewayId = value;
    } else if (outputType === 'Arn') {
      gateways[gatewayName].gatewayArn = value;
    } else if (outputType === 'Url') {
      gateways[gatewayName].gatewayUrl = value;
    }
  }

  // Associate target outputs with gateways
  // Build a map from PascalCase target name to [gatewayName, originalTargetName]
  const targetToGateway = new Map<string, { gatewayName: string; targetName: string }>();
  for (const gwName of gatewayNames) {
    const gwSpec = gatewaySpecs[gwName];
    if (
      gwSpec &&
      typeof gwSpec === 'object' &&
      'targets' in gwSpec &&
      Array.isArray((gwSpec as { targets?: unknown[] }).targets)
    ) {
      for (const target of (gwSpec as { targets: { name: string }[] }).targets) {
        targetToGateway.set(toPascalId(target.name), { gatewayName: gwName, targetName: target.name });
      }
    }
  }

  for (const { logicalTarget, targetId } of targetOutputs) {
    const mapping = targetToGateway.get(logicalTarget);
    const gwState = mapping ? gateways[mapping.gatewayName] : undefined;
    if (mapping && gwState) {
      gwState.targets ??= {};
      gwState.targets[mapping.targetName] = { targetId };
    }
  }

  return gateways;
}

/**
 * Parse stack outputs into deployed state for agents.
 *
 * Output key pattern after logical ID simplification:
 * ApplicationAgent{AgentName}{OutputType}Output{Hash}
 *
 * Examples:
 * - ApplicationAgentAdvancedAgentRuntimeIdOutput3E11FAB4
 * - ApplicationAgentBasicStrandsRoleArnOutputF1FD8F36
 */
export function parseAgentOutputs(
  outputs: StackOutputs,
  agentNames: string[],
  _stackName: string
): Record<string, AgentCoreDeployedState> {
  const agents: Record<string, AgentCoreDeployedState> = {};

  // Map PascalCase agent names to original names for lookup
  const agentIdMap = new Map(agentNames.map(name => [toPascalId(name), name]));
  const outputsByAgent: Record<
    string,
    {
      runtimeId?: string;
      runtimeArn?: string;
      roleArn?: string;
      memoryIds?: string;
      browserId?: string;
      codeInterpreterId?: string;
    }
  > = {};

  // Match pattern: ApplicationAgent{AgentName}{OutputType}Output
  const outputPattern =
    /^ApplicationAgent(.+?)(RuntimeId|RuntimeArn|RoleArn|MemoryIds|BrowserId|CodeInterpreterId)Output/;

  for (const [key, value] of Object.entries(outputs)) {
    const match = outputPattern.exec(key);
    if (!match) continue;

    const logicalAgent = match[1];
    const outputType = match[2];
    if (!logicalAgent || !outputType) continue;

    // Look up original agent name from PascalCase version
    const agentName = agentIdMap.get(logicalAgent) ?? logicalAgent;

    outputsByAgent[agentName] ??= {};

    switch (outputType) {
      case 'RuntimeId':
        outputsByAgent[agentName].runtimeId = value;
        break;
      case 'RuntimeArn':
        outputsByAgent[agentName].runtimeArn = value;
        break;
      case 'RoleArn':
        outputsByAgent[agentName].roleArn = value;
        break;
      case 'MemoryIds':
        outputsByAgent[agentName].memoryIds = value;
        break;
      case 'BrowserId':
        outputsByAgent[agentName].browserId = value;
        break;
      case 'CodeInterpreterId':
        outputsByAgent[agentName].codeInterpreterId = value;
        break;
      default:
        break;
    }
  }

  for (const [agentName, agentOutputs] of Object.entries(outputsByAgent)) {
    if (!agentOutputs.runtimeId || !agentOutputs.runtimeArn || !agentOutputs.roleArn) {
      continue;
    }

    const state: AgentCoreDeployedState = {
      runtimeId: agentOutputs.runtimeId,
      runtimeArn: agentOutputs.runtimeArn,
      roleArn: agentOutputs.roleArn,
    };

    if (agentOutputs.memoryIds) {
      state.memoryIds = agentOutputs.memoryIds.split(',');
    }
    if (agentOutputs.browserId) {
      state.browserId = agentOutputs.browserId;
    }
    if (agentOutputs.codeInterpreterId) {
      state.codeInterpreterId = agentOutputs.codeInterpreterId;
    }

    agents[agentName] = state;
  }

  return agents;
}

/**
 * Parse stack outputs into deployed state for memories.
 *
 * Looks up outputs by constructing the expected key prefix from known memory names
 *
 * Output key pattern: ApplicationMemory{PascalName}(Id|Arn)Output{Hash}
 */
export function parseMemoryOutputs(outputs: StackOutputs, memoryNames: string[]): Record<string, MemoryDeployedState> {
  const memories: Record<string, MemoryDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const memoryName of memoryNames) {
    const pascal = toPascalId(memoryName);
    const idPrefix = `ApplicationMemory${pascal}IdOutput`;
    const arnPrefix = `ApplicationMemory${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      memories[memoryName] = {
        memoryId: outputs[idKey]!,
        memoryArn: outputs[arnKey]!,
      };
    }
  }

  return memories;
}

/**
 * Parse stack outputs into deployed state for knowledge bases.
 *
 * Output key patterns (L3 ≥ #234):
 *   ApplicationKnowledgeBase{Pascal}(Id|Arn)Output{Hash}
 *   ApplicationKnowledgeBase{Pascal}DataSource{N}(Id|Uri)Output{Hash}
 *
 * Per-DS outputs are how we map URI → deployed DS id deterministically. For
 * stacks deployed against an older L3 that pre-dates those outputs, the map
 * comes back empty — callers fall back to ListDataSources.
 *
 * `sourcesHash` is populated separately by the post-deploy step.
 */
export function parseKnowledgeBaseOutputs(
  outputs: StackOutputs,
  knowledgeBaseNames: string[]
): Record<string, KnowledgeBaseDeployedState> {
  const knowledgeBases: Record<string, KnowledgeBaseDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const kbName of knowledgeBaseNames) {
    const pascal = toPascalId('KnowledgeBase', kbName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      knowledgeBases[kbName] = {
        knowledgeBaseId: outputs[idKey]!,
        knowledgeBaseArn: outputs[arnKey]!,
        dataSources: parseKnowledgeBaseDataSourceOutputs(outputs, kbName),
      };
    }
  }

  return knowledgeBases;
}

/**
 * Parse the per-DataSource CFN outputs for a single KB into an ordered
 * `[{dataSourceId, uri}]` array. Outputs are paired by index (DataSource{N}Id
 * + DataSource{N}Uri) and sorted ascending by N so the result mirrors the
 * local `dataSources[]` order from agentcore.json.
 *
 * Returns an empty array when no per-DS outputs are present (e.g. stack
 * deployed against an older L3) — callers should fall back to a SDK listing.
 */
export function parseKnowledgeBaseDataSourceOutputs(
  outputs: StackOutputs,
  knowledgeBaseName: string
): { dataSourceId: string; uri: string }[] {
  const pascal = toPascalId('KnowledgeBase', knowledgeBaseName);
  const indexed = new Map<number, { dataSourceId?: string; uri?: string }>();
  // Match `Application{Pascal}DataSource{N}IdOutput…` and `…UriOutput…`.
  const pattern = new RegExp(`^Application${pascal}DataSource(\\d+)(Id|Uri)Output`);

  for (const [key, value] of Object.entries(outputs)) {
    const match = pattern.exec(key);
    if (!match) continue;
    const idx = parseInt(match[1]!, 10);
    const kind = match[2] as 'Id' | 'Uri';
    const slot = indexed.get(idx) ?? {};
    if (kind === 'Id') slot.dataSourceId = value;
    else slot.uri = value;
    indexed.set(idx, slot);
  }

  return [...indexed.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => slot)
    .filter((slot): slot is { dataSourceId: string; uri: string } => !!slot.dataSourceId && !!slot.uri);
}

/**
 * Parse stack outputs into deployed state for evaluators.
 *
 * Output key pattern: ApplicationEvaluator{PascalName}(Id|Arn)Output{Hash}
 */
export function parseEvaluatorOutputs(
  outputs: StackOutputs,
  evaluatorNames: string[]
): Record<string, EvaluatorDeployedState> {
  const evaluators: Record<string, EvaluatorDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const evalName of evaluatorNames) {
    const pascal = toPascalId('Evaluator', evalName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      evaluators[evalName] = {
        evaluatorId: outputs[idKey]!,
        evaluatorArn: outputs[arnKey]!,
      };
    }
  }

  return evaluators;
}

/**
 * Parse stack outputs into deployed state for online evaluation configs.
 *
 * Output key pattern: ApplicationOnlineEval{PascalName}(Id|Arn)Output{Hash}
 */
export function parseOnlineEvalOutputs(
  outputs: StackOutputs,
  onlineEvalSpecs: { name: string; agent?: string; endpoint?: string }[]
): Record<string, OnlineEvalDeployedState> {
  const configs: Record<string, OnlineEvalDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const spec of onlineEvalSpecs) {
    const pascal = toPascalId('OnlineEval', spec.name);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      configs[spec.name] = {
        onlineEvaluationConfigId: outputs[idKey]!,
        onlineEvaluationConfigArn: outputs[arnKey]!,
        ...(spec.agent && { agent: spec.agent }),
        ...(spec.endpoint && { endpoint: spec.endpoint }),
      };
    }
  }

  return configs;
}

/**
 * Parse stack outputs into deployed state for policy engines.
 *
 * Output key pattern: ApplicationPolicyEngine{PascalName}(Id|Arn)Output{Hash}
 */
export function parsePolicyEngineOutputs(
  outputs: StackOutputs,
  engineNames: string[]
): Record<string, PolicyEngineDeployedState> {
  const engines: Record<string, PolicyEngineDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const engineName of engineNames) {
    const pascal = toPascalId('PolicyEngine', engineName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      engines[engineName] = {
        policyEngineId: outputs[idKey]!,
        policyEngineArn: outputs[arnKey]!,
      };
    }
  }

  return engines;
}

/**
 * Parse stack outputs into deployed state for policies.
 *
 * Output key pattern: ApplicationPolicy{EnginePascal}{PolicyPascal}(Id|Arn)Output{Hash}
 */
export function parsePolicyOutputs(
  outputs: StackOutputs,
  policySpecs: { engineName: string; policyName: string }[]
): Record<string, PolicyDeployedState> {
  const policies: Record<string, PolicyDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const { engineName, policyName } of policySpecs) {
    const pascal = toPascalId('Policy', engineName, policyName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      // Use engineName/policyName as the key for unique identification
      const key = `${engineName}/${policyName}`;
      policies[key] = {
        policyId: outputs[idKey]!,
        policyArn: outputs[arnKey]!,
        engineName,
      };
    }
  }

  return policies;
}

/**
 * Parse stack outputs into deployed state for runtime endpoints.
 *
 * Output key pattern: ApplicationAgent{AgentPascal}Endpoint{AgentPascal}{EndpointPascal}(Id|Arn)Output{Hash}
 * The Agent{PascalName} prefix comes from the AgentEnvironment construct in the CDK tree.
 */
export function parseRuntimeEndpointOutputs(
  outputs: StackOutputs,
  endpointSpecs: { agentName: string; endpointName: string }[]
): Record<string, RuntimeEndpointDeployedState> {
  const endpoints: Record<string, RuntimeEndpointDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const { agentName, endpointName } of endpointSpecs) {
    const agentPascal = toPascalId(agentName);
    const endpointPascal = toPascalId('Endpoint', agentName, endpointName);
    const idPrefix = `ApplicationAgent${agentPascal}${endpointPascal}IdOutput`;
    const arnPrefix = `ApplicationAgent${agentPascal}${endpointPascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      const key = `${agentName}/${endpointName}`;
      endpoints[key] = {
        endpointId: outputs[idKey]!,
        endpointArn: outputs[arnKey]!,
      };
    }
  }

  return endpoints;
}

/**
 * Parse stack outputs into deployed state for datasets.
 *
 * Output key pattern: ApplicationDataset{PascalName}(Id|Arn)Output{Hash}
 */
export function parseDatasetOutputs(
  outputs: StackOutputs,
  datasetNames: string[]
): Record<string, DatasetDeployedState> {
  const datasets: Record<string, DatasetDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const datasetName of datasetNames) {
    const pascal = toPascalId('Dataset', datasetName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      datasets[datasetName] = {
        datasetId: outputs[idKey]!,
        datasetArn: outputs[arnKey]!,
      };
    }
  }

  return datasets;
}

/**
 * Parse stack outputs into deployed state for capacity providers.
 *
 * Output key pattern: ApplicationCapacityProvider{PascalName}(Id|Arn)Output{Hash}
 */
export function parseCapacityProviderOutputs(
  outputs: StackOutputs,
  capacityProviderNames: string[]
): Record<string, CapacityProviderDeployedState> {
  const capacityProviders: Record<string, CapacityProviderDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const capacityProviderName of capacityProviderNames) {
    const pascal = toPascalId('CapacityProvider', capacityProviderName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      capacityProviders[capacityProviderName] = {
        capacityProviderId: outputs[idKey]!,
        capacityProviderArn: outputs[arnKey]!,
      };
    }
  }

  return capacityProviders;
}

/**
 * Parse CDK stack outputs for CFN-deployed harnesses into deployed-state records.
 *
 * The L3 AgentCoreApplication emits, per harness `${name}` (pascal = toPascalId('Harness', name)):
 *   ApplicationHarness{Pascal}{Id,Arn,Status,AgentRuntimeArn}Output<hash>
 * and the execution role (AgentCoreHarnessRole) separately emits:
 *   ApplicationHarness{Pascal}RoleRoleArnOutput<hash>
 * The 'Arn' harness prefix does not collide with 'RoleRoleArn' (next segment differs).
 */
export function parseHarnessOutputs(
  outputs: StackOutputs,
  harnessNames: string[],
  onWarn: (message: string) => void = console.warn
): Record<string, HarnessDeployedState> {
  const harnesses: Record<string, HarnessDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const harnessName of harnessNames) {
    const pascal = toPascalId('Harness', harnessName);
    const idKey = outputKeys.find(k => k.startsWith(`Application${pascal}IdOutput`));
    const arnKey = outputKeys.find(k => k.startsWith(`Application${pascal}ArnOutput`));
    const statusKey = outputKeys.find(k => k.startsWith(`Application${pascal}StatusOutput`));
    const runtimeArnKey = outputKeys.find(k => k.startsWith(`Application${pascal}AgentRuntimeArnOutput`));
    const roleArnKey = outputKeys.find(k => k.startsWith(`Application${pascal}RoleRoleArnOutput`));
    // Version is OPTIONAL: stacks deployed before the config-versioning change won't emit it, so it
    // is never part of the required-set guard below — a missing Version just leaves harnessVersion unset.
    const versionKey = outputKeys.find(k => k.startsWith(`Application${pascal}VersionOutput`));
    const versionRaw = versionKey ? outputs[versionKey] : undefined;
    const harnessVersion = versionRaw !== undefined && /^[0-9]+$/.test(versionRaw) ? Number(versionRaw) : undefined;

    // Id/Arn/Status/RoleArn are required for a complete CDK-managed harness record.
    if (idKey && arnKey && statusKey && roleArnKey) {
      harnesses[harnessName] = {
        harnessId: outputs[idKey]!,
        harnessArn: outputs[arnKey]!,
        status: outputs[statusKey]!,
        roleArn: outputs[roleArnKey]!,
        ...(harnessVersion !== undefined && { harnessVersion }),
        ...(runtimeArnKey && { agentRuntimeArn: outputs[runtimeArnKey] }),
        provisioner: 'cloudformation',
      };
      continue;
    }

    // A spec'd harness that produced incomplete (or no) outputs is dropped from
    // deployed-state, which silently removes it from `status`/`invoke`. Surface
    // the gap so a partially-emitted or missing harness leaves a trace rather
    // than vanishing without explanation.
    const missing = [!idKey && 'Id', !arnKey && 'Arn', !statusKey && 'Status', !roleArnKey && 'RoleArn'].filter(
      (v): v is string => typeof v === 'string'
    );
    if (missing.length === 4) {
      onWarn(
        `Harness "${harnessName}" produced no CloudFormation outputs; it will not appear in ` +
          `\`agentcore status\` or be invocable until the next successful deploy.`
      );
    } else {
      onWarn(
        `Harness "${harnessName}" is missing CloudFormation output(s): ${missing.join(', ')}. ` +
          `Skipping it in deployed-state — it will not appear in \`agentcore status\` or be invocable. ` +
          `Re-run \`agentcore deploy\`; if this persists, the harness stack output template may be malformed.`
      );
    }
  }

  return harnesses;
}

export function parseConfigBundleOutputs(
  outputs: StackOutputs,
  bundleNames: string[]
): Record<string, ConfigBundleDeployedState> {
  const bundles: Record<string, ConfigBundleDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const bundleName of bundleNames) {
    const pascal = toPascalId('ConfigBundle', bundleName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;
    const versionPrefix = `Application${pascal}VersionIdOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));
    const versionKey = outputKeys.find(k => k.startsWith(versionPrefix));

    if (idKey && arnKey && versionKey) {
      bundles[bundleName] = {
        bundleId: outputs[idKey]!,
        bundleArn: outputs[arnKey]!,
        versionId: outputs[versionKey]!,
      };
    }
  }

  return bundles;
}

/**
 * Strip underscores from a name to produce a valid CDK logical ID segment.
 * Must match the toCdkId() function in the vended cdk-stack.ts.
 */
function toPaymentCdkId(name: string): string {
  return name.replace(/_/g, '');
}

/**
 * Parse payment-related CfnOutputs from a deployed stack.
 * Output keys follow the pattern: Payment{name}ManagerArn, Payment{name}ManagerId, etc.
 * Names have underscores stripped to produce valid CDK logical IDs.
 */
export function parsePaymentOutputs(
  outputs: StackOutputs,
  paymentSpecs: {
    name: string;
    authorizerType?: 'AWS_IAM' | 'CUSTOM_JWT';
    autoPayment?: boolean;
    paymentToolAllowlist?: string[];
    networkPreferences?: string[];
    connectors: {
      name: string;
      provisionMode?: 'MANUAL' | 'QUICK_CREATE';
      credentialProviderArn?: string;
      credentialProviderName?: string;
    }[];
  }[]
): Record<string, PaymentDeployedState> {
  const payments: Record<string, PaymentDeployedState> = {};

  for (const spec of paymentSpecs) {
    const mgrId = toPaymentCdkId(spec.name);
    const managerArn = outputs[`Payment${mgrId}ManagerArn`];
    const managerId = outputs[`Payment${mgrId}ManagerId`];
    const processPaymentRoleArn = outputs[`Payment${mgrId}ProcessPaymentRoleArn`];
    const resourceRetrievalRoleArn = outputs[`Payment${mgrId}ResourceRetrievalRoleArn`];

    if (!managerArn || !managerId || !processPaymentRoleArn || !resourceRetrievalRoleArn) continue;

    const connectors: Record<string, PaymentConnectorDeployedState> = {};
    for (const conn of spec.connectors) {
      const connId = toPaymentCdkId(conn.name);
      const connectorId = outputs[`Payment${mgrId}${connId}ConnectorId`];
      if (connectorId) {
        if (conn.provisionMode === 'QUICK_CREATE') {
          connectors[conn.name] = {
            connectorId,
            provisionMode: 'QUICK_CREATE',
            ...(conn.credentialProviderName && { credentialProviderName: conn.credentialProviderName }),
          };
        } else if (conn.credentialProviderArn) {
          connectors[conn.name] = {
            connectorId,
            ...(conn.provisionMode && { provisionMode: conn.provisionMode }),
            credentialProviderArn: conn.credentialProviderArn,
            ...(conn.credentialProviderName && { credentialProviderName: conn.credentialProviderName }),
          };
        }
      }
    }

    payments[spec.name] = {
      managerId,
      managerArn,
      connectors,
      processPaymentRoleArn,
      resourceRetrievalRoleArn,
      ...(spec.authorizerType && { authorizerType: spec.authorizerType }),
      ...(spec.autoPayment !== undefined && { autoPayment: spec.autoPayment }),
      ...(spec.paymentToolAllowlist && { paymentToolAllowlist: spec.paymentToolAllowlist }),
      ...(spec.networkPreferences && { networkPreferences: spec.networkPreferences }),
    };
  }

  return payments;
}

export interface BuildDeployedStateOptions {
  targetName: string;
  stackName: string;
  agents: Record<string, AgentCoreDeployedState>;
  gateways: Record<string, { gatewayId: string; gatewayArn: string; gatewayUrl?: string }>;
  httpGateways?: Record<
    string,
    { gatewayId: string; gatewayArn: string; gatewayUrl?: string; targets?: Record<string, { targetId: string }> }
  >;
  existingState?: DeployedState;
  identityKmsKeyArn?: string;
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }>;
  memories?: Record<string, MemoryDeployedState>;
  evaluators?: Record<string, EvaluatorDeployedState>;
  onlineEvalConfigs?: Record<string, OnlineEvalDeployedState>;
  policyEngines?: Record<string, PolicyEngineDeployedState>;
  policies?: Record<string, PolicyDeployedState>;
  runtimeEndpoints?: Record<string, RuntimeEndpointDeployedState>;
  harnesses?: Record<string, HarnessDeployedState>;
  datasets?: Record<string, DatasetDeployedState>;
  configBundles?: Record<string, ConfigBundleDeployedState>;
  knowledgeBases?: Record<string, KnowledgeBaseDeployedState>;
  payments?: Record<string, PaymentDeployedState>;
  capacityProviders?: Record<string, CapacityProviderDeployedState>;
  /**
   * Names of A/B tests currently declared in the project spec. AB test state is managed
   * post-deploy (not via CFN outputs) and carried forward across deploys; passing the
   * current spec names lets us prune entries for tests the user has since removed, so
   * stale (e.g. preview) entries self-heal instead of lingering in deployed-state.
   * If omitted, all existing AB test entries are carried forward unchanged.
   */
  abTestNames?: string[];
}

/**
 * Build deployed state from stack outputs.
 */
export function buildDeployedState(opts: BuildDeployedStateOptions): DeployedState {
  const {
    targetName,
    stackName,
    agents,
    gateways,
    httpGateways,
    existingState,
    identityKmsKeyArn,
    credentials,
    memories,
    evaluators,
    onlineEvalConfigs,
    policyEngines,
    policies,
    runtimeEndpoints,
    harnesses,
    datasets,
    configBundles,
    knowledgeBases,
    payments,
    capacityProviders,
    abTestNames,
  } = opts;
  const targetState: TargetDeployedState = {
    resources: {
      runtimes: Object.keys(agents).length > 0 ? agents : undefined,
      memories: memories && Object.keys(memories).length > 0 ? memories : undefined,
      policyEngines: policyEngines && Object.keys(policyEngines).length > 0 ? policyEngines : undefined,
      policies: policies && Object.keys(policies).length > 0 ? policies : undefined,
      stackName,
      identityKmsKeyArn,
    },
  };

  // Add MCP state if gateways exist
  if (Object.keys(gateways).length > 0) {
    targetState.resources!.mcp = {
      gateways,
    };
  }

  // Add HTTP gateway state if HTTP gateways exist
  if (httpGateways && Object.keys(httpGateways).length > 0) {
    targetState.resources!.gateways = httpGateways;
  }

  // Add credential state if credentials exist
  if (credentials && Object.keys(credentials).length > 0) {
    targetState.resources!.credentials = credentials;
  }

  // Add evaluator state if evaluators exist
  if (evaluators && Object.keys(evaluators).length > 0) {
    targetState.resources!.evaluators = evaluators;
  }

  // Add online eval config state if configs exist
  if (onlineEvalConfigs && Object.keys(onlineEvalConfigs).length > 0) {
    targetState.resources!.onlineEvalConfigs = onlineEvalConfigs;
  }

  // Add runtime endpoint state if endpoints exist
  if (runtimeEndpoints && Object.keys(runtimeEndpoints).length > 0) {
    targetState.resources!.runtimeEndpoints = runtimeEndpoints;
  }

  if (datasets && Object.keys(datasets).length > 0) {
    targetState.resources!.datasets = datasets;
  }

  if (knowledgeBases && Object.keys(knowledgeBases).length > 0) {
    targetState.resources!.knowledgeBases = knowledgeBases;
  }

  // Config bundles from CFN outputs (preferred) or carry forward from existing state (legacy)
  if (configBundles && Object.keys(configBundles).length > 0) {
    targetState.resources!.configBundles = configBundles;
  } else {
    const existingConfigBundles = existingState?.targets?.[targetName]?.resources?.configBundles;
    if (existingConfigBundles && Object.keys(existingConfigBundles).length > 0) {
      targetState.resources!.configBundles = existingConfigBundles;
    }
  }

  // Carry forward AB tests from existing state (managed post-deploy, not via CFN outputs).
  // Prune entries for tests no longer declared in the project spec so stale (e.g. preview)
  // entries self-heal. When abTestNames is undefined, carry forward everything unchanged.
  const existingABTests = existingState?.targets?.[targetName]?.resources?.abTests;
  if (existingABTests && Object.keys(existingABTests).length > 0) {
    const carriedABTests =
      abTestNames === undefined
        ? existingABTests
        : Object.fromEntries(Object.entries(existingABTests).filter(([specName]) => abTestNames.includes(specName)));
    if (Object.keys(carriedABTests).length > 0) {
      targetState.resources!.abTests = carriedABTests;
    }
  }

  // Merge harness state. CFN-sourced records (freshly parsed, stamped
  // `provisioner: 'cloudformation'`) are authoritative for every CDK-managed harness — they
  // are re-parsed in full each deploy, so a CFN harness dropped from the spec correctly
  // disappears here (CloudFormation deletes the resource). On top of that, carry forward any
  // existing *orphan* record (imperative-build harness, no marker) that the current outputs
  // don't cover, so it stays visible to detection/cleanup instead of silently vanishing.
  // Only orphans are preserved — carrying forward stale marked records would resurrect a
  // harness CloudFormation just deleted.
  const existingHarnesses = existingState?.targets?.[targetName]?.resources?.harnesses ?? {};
  const carriedOrphans: Record<string, HarnessDeployedState> = {};
  for (const [name, record] of Object.entries(existingHarnesses)) {
    if (!harnesses?.[name] && record.provisioner !== 'cloudformation') {
      carriedOrphans[name] = record;
    }
  }
  const mergedHarnesses = { ...carriedOrphans, ...harnesses };
  if (Object.keys(mergedHarnesses).length > 0) {
    targetState.resources!.harnesses = mergedHarnesses;
  }

  // Add payment state from CFN outputs (or preserve credential provider state)
  if (payments && Object.keys(payments).length > 0) {
    targetState.resources!.payments = payments;
  }

  // Add capacity provider state from CFN outputs
  if (capacityProviders && Object.keys(capacityProviders).length > 0) {
    targetState.resources!.capacityProviders = capacityProviders;
  }

  return {
    targets: {
      ...existingState?.targets,
      [targetName]: targetState,
    },
  };
}

/**
 * Get stack outputs by project name (discovers stack via tags).
 * Uses Resource Groups Tagging API to find the stack, then DescribeStacks for outputs.
 */
export async function getStackOutputsByProject(
  region: string,
  projectName: string,
  targetName = 'default'
): Promise<StackOutputs> {
  const stackName = await getStackName(region, projectName, targetName);
  if (!stackName) {
    throw new Error(`No AgentCore stack found for project "${projectName}" target "${targetName}"`);
  }
  return getStackOutputs(region, stackName);
}
