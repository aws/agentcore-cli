import { ConfigIO } from '../../../../lib';
import type { CdkToolkitWrapper, DeployMessage, SwitchableIoHost } from '../../../cdk/toolkit-lib';
import {
  buildDeployedState,
  getStackOutputs,
  parseAgentOutputs,
  parseConfigBundleOutputs,
  parseDatasetOutputs,
  parseEvaluatorOutputs,
  parseGatewayOutputs,
  parseHarnessOutputs,
  parseKnowledgeBaseOutputs,
  parseMemoryOutputs,
  parseOnlineEvalOutputs,
  parsePaymentOutputs,
  parsePolicyEngineOutputs,
  parsePolicyOutputs,
  parseRuntimeEndpointOutputs,
} from '../../../cloudformation';
import { DEFAULT_DEPLOY_ATTRS, computeDeployAttrs } from '../../../commands/deploy/utils.js';
import { getErrorMessage, isChangesetInProgressError, isExpiredTokenError } from '../../../errors';
import { ExecLogger } from '../../../logging';
import {
  MANAGED_MEMORY_DEPLOY_NOTICE,
  cleanupPaymentCredentialProviders,
  hasManagedMemoryHarness,
  performStackTeardown,
  setupTransactionSearch,
} from '../../../operations/deploy';
import { computeProjectDeployHash } from '../../../operations/deploy/change-detection';
import { getGatewayTargetStatuses } from '../../../operations/deploy/gateway-status';
import { syncDatasets } from '../../../operations/deploy/post-deploy-datasets';
import { autoIngestKnowledgeBases } from '../../../operations/deploy/post-deploy-knowledge-bases';
import { enableOnlineEvalConfigs } from '../../../operations/deploy/post-deploy-online-evals';
import { hydrateKnowledgeBaseDataSources } from '../../../operations/knowledge-base/hydrate-data-sources';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import {
  type StackDiffSummary,
  type Step,
  areStepsComplete,
  hasStepError,
  parseDiffResult,
  parseStackDiff,
} from '../../components';
import { type MissingCredential, type PreflightContext, useCdkPreflight } from '../../hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type DeployPhase =
  | 'idle'
  | 'running'
  | 'teardown-confirm'
  | 'credentials-prompt'
  | 'bootstrap-confirm'
  | 'deploying'
  | 'complete'
  | 'error';

const MAX_OUTPUT_POLL_ATTEMPTS = 10;
const OUTPUT_POLL_DELAY_MS = 1500;

/** Optional pre-synthesized context from plan command */
export interface PreSynthesized {
  cdkToolkitWrapper: CdkToolkitWrapper;
  context: PreflightContext;
  stackNames: string[];
  switchableIoHost?: SwitchableIoHost;
  identityKmsKeyArn?: string;
  allCredentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }>;
}

interface DeployFlowOptions {
  /** Skip preflight and use pre-synthesized context (from plan command) */
  preSynthesized?: PreSynthesized;
  /** Whether running in interactive TUI mode - affects error message verbosity */
  isInteractive?: boolean;
  /** Run CDK diff instead of deploy */
  diffMode?: boolean;
}

interface DeployFlowState {
  phase: DeployPhase;
  steps: Step[];
  context: PreflightContext | null;
  deployOutput: string | null;
  deployMessages: DeployMessage[];
  stackOutputs: Record<string, string>;
  targetStatuses: { name: string; status: string }[];
  hasError: boolean;
  /** True if the error is specifically due to expired/invalid AWS credentials */
  hasTokenExpiredError: boolean;
  /** True if the error is due to missing AWS credentials (not configured) */
  hasCredentialsError: boolean;
  isComplete: boolean;
  /** True if CloudFormation has started (received first resource event) */
  hasStartedCfn: boolean;
  logFilePath: string;
  /** Missing credentials that need to be provided */
  missingCredentials: MissingCredential[];
  /** Parsed diff summaries per stack */
  diffSummaries: StackDiffSummary[];
  /** Number of stacks with changes (from overall diff result) */
  numStacksWithChanges?: number;
  /** Notes to display after successful deploy (e.g., transaction search info) */
  deployNotes: string[];
  /** Managed-memory heads-up, shown while the CFN apply runs (null when not applicable) */
  managedMemoryNotice: string | null;
  /** Warnings from post-deploy steps (config bundles, AB tests) */
  postDeployWarnings: string[];
  /** True if any post-deploy sub-resource operation had errors */
  postDeployHasError: boolean;
  /** Whether an on-demand diff is currently running */
  isDiffLoading: boolean;
  /** Request an on-demand diff (lazy: runs once, caches result) */
  requestDiff: () => void;
  startDeploy: () => void;
  confirmTeardown: () => void;
  cancelTeardown: () => void;
  confirmBootstrap: () => void;
  skipBootstrap: () => void;
  /** Reset token expired state (called after user re-authenticates) */
  clearTokenExpiredError: () => void;
  /** Reset credentials error state (called after user configures credentials) */
  clearCredentialsError: () => void;
  /** Called when user chooses to use credentials from .env.local */
  useEnvLocalCredentials: () => void;
  /** Called when user enters credentials manually */
  useManualCredentials: (credentials: Record<string, string>) => void;
  /** Called when user chooses to skip credential setup */
  skipCredentials: () => void;
}

export function useDeployFlow(options: DeployFlowOptions = {}): DeployFlowState {
  const { preSynthesized, isInteractive = false, diffMode = false } = options;
  const skipPreflight = !!preSynthesized;

  // Create logger once for the entire deploy flow
  const [logger] = useState(() => new ExecLogger({ command: 'deploy' }));

  // Always call the hook (React rules), but we won't use it when preSynthesized is provided
  const preflight = useCdkPreflight({ logger, isInteractive });

  // Use pre-synthesized values when provided, otherwise use preflight values
  const cdkToolkitWrapper = preSynthesized?.cdkToolkitWrapper ?? preflight.cdkToolkitWrapper;
  const context = preSynthesized?.context ?? preflight.context;
  const stackNames = preSynthesized?.stackNames ?? preflight.stackNames;
  const switchableIoHost = preSynthesized?.switchableIoHost ?? preflight.switchableIoHost;
  const identityKmsKeyArn = preSynthesized?.identityKmsKeyArn ?? preflight.identityKmsKeyArn;
  const allCredentials = preSynthesized?.allCredentials ?? preflight.allCredentials;

  const [preDeployDiffStep, setPreDeployDiffStep] = useState<Step>({
    label: 'Computing diff changes...',
    status: 'pending',
  });
  const [publishAssetsStep, setPublishAssetsStep] = useState<Step>({ label: 'Publish assets', status: 'pending' });
  const [deployStep, setDeployStep] = useState<Step>({ label: 'Deploy to AWS', status: 'pending' });
  const [persistStateStep, setPersistStateStep] = useState<Step>({
    label: 'Persist deployment state',
    status: 'pending',
  });
  // Whether the hydrate-KB step needs to run for this deploy. False (the
  // common case) when every KB had its `dataSources[]` already populated by
  // the per-DS CFN outputs the L3 emits since #234 — the persist step did
  // the work and hydrate would be a pure no-op. We hide the step from the
  // visible list in that case so the user doesn't see a phantom phase. Set
  // by the deploy-time code right before the hydrate call (after the parse
  // step exposes which KBs came back with empty dataSources[]).
  const [needsKbHydration, setNeedsKbHydration] = useState(false);
  const [hydrateKbStep, setHydrateKbStep] = useState<Step>({
    label: 'Hydrate knowledge base data sources',
    status: 'pending',
  });
  const [autoIngestStep, setAutoIngestStep] = useState<Step>({
    label: 'Auto-ingest knowledge bases',
    status: 'pending',
  });
  const [datasetSyncStep, setDatasetSyncStep] = useState<Step>({ label: 'Sync datasets', status: 'pending' });
  const [onlineEvalStep, setOnlineEvalStep] = useState<Step>({ label: 'Enable online evaluation', status: 'pending' });
  const [diffStep, setDiffStep] = useState<Step>({ label: 'Run CDK diff', status: 'pending' });
  const [diffSummaries, setDiffSummaries] = useState<StackDiffSummary[]>([]);
  const [numStacksWithChanges, setNumStacksWithChanges] = useState<number | undefined>();
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [deployNotes, setDeployNotes] = useState<string[]>([]);
  const [postDeployWarnings, setPostDeployWarnings] = useState<string[]>([]);
  const [postDeployHasError, setPostDeployHasError] = useState(false);
  const isDiffRunningRef = useRef(false);
  const [deployOutput, setDeployOutput] = useState<string | null>(null);
  const [deployMessages, setDeployMessages] = useState<DeployMessage[]>([]);
  // Managed-memory heads-up: shown WHILE the slow CFN apply runs (not gated on success like
  // deployNotes), because explaining the 3-5 min memory provisioning is the whole point.
  const [managedMemoryNotice, setManagedMemoryNotice] = useState<string | null>(null);
  const [stackOutputs, setStackOutputs] = useState<Record<string, string>>({});
  const [targetStatuses, setTargetStatuses] = useState<{ name: string; status: string }[]>([]);
  const [shouldStartDeploy, setShouldStartDeploy] = useState(false);
  const [hasTokenExpiredError, setHasTokenExpiredError] = useState(false);
  // Track if CloudFormation has started (received first resource event)
  const [hasStartedCfn, setHasStartedCfn] = useState(false);
  // Ref version for use in callbacks (avoids stale closure issues)
  const hasReceivedCfnEvent = useRef(false);
  // Ref to capture outputs from I5900 stream message (for immediate access in persistDeployedState)
  const streamOutputsRef = useRef<Record<string, string> | null>(null);

  const startDeploy = useCallback(() => {
    setPreDeployDiffStep({ label: 'Computing diff changes...', status: 'pending' });
    setPublishAssetsStep({ label: 'Publish assets', status: 'pending' });
    setDeployStep({ label: 'Deploy to AWS', status: 'pending' });
    setPersistStateStep({ label: 'Persist deployment state', status: 'pending' });
    setHydrateKbStep({ label: 'Hydrate knowledge base data sources', status: 'pending' });
    setNeedsKbHydration(false);
    setAutoIngestStep({ label: 'Auto-ingest knowledge bases', status: 'pending' });
    setDatasetSyncStep({ label: 'Sync datasets', status: 'pending' });
    setOnlineEvalStep({ label: 'Enable online evaluation', status: 'pending' });
    setPostDeployHasError(false);
    setPostDeployWarnings([]);
    setDeployOutput(null);
    setHasTokenExpiredError(false); // Reset token expired state when retrying
    setHasStartedCfn(false);
    hasReceivedCfnEvent.current = false;
    if (skipPreflight) {
      setShouldStartDeploy(true);
    } else {
      void preflight.startPreflight();
    }
  }, [preflight, skipPreflight]);

  /** Run diff on-demand (lazy: runs once, caches result). Safe to call anytime after synth. */
  const requestDiff = useCallback(() => {
    if (diffSummaries.length > 0 || isDiffRunningRef.current) return;
    if (!cdkToolkitWrapper) return;

    isDiffRunningRef.current = true;
    setIsDiffLoading(true);

    const run = async () => {
      switchableIoHost?.setOnRawMessage((code, _level, message, data) => {
        logger.logDiff(code, message);
        if (code === 'CDK_TOOLKIT_I4002') {
          setDiffSummaries(prev => [...prev, parseStackDiff(data, message)]);
        } else if (code === 'CDK_TOOLKIT_I4001') {
          setNumStacksWithChanges(parseDiffResult(data).numStacksWithChanges);
        }
      });
      switchableIoHost?.setVerbose(true);

      try {
        await cdkToolkitWrapper.diff();
      } catch {
        setDiffSummaries([{ stackName: 'Error', sections: [], hasSecurityChanges: false, totalChanges: 0 }]);
      } finally {
        switchableIoHost?.setVerbose(false);
        switchableIoHost?.setOnRawMessage(null);
        isDiffRunningRef.current = false;
        setIsDiffLoading(false);
      }
    };

    void run();
  }, [cdkToolkitWrapper, diffSummaries.length, switchableIoHost, logger]);

  /**
   * Persist deployed state after successful deployment.
   * Uses outputs from CDK stream (I5900) if available, falls back to DescribeStacks API.
   */
  const persistDeployedState = useCallback(async () => {
    const ctx = context;
    const currentStackName = stackNames[0];
    const target = ctx?.awsTargets[0];

    if (!ctx || !currentStackName || !target) return;

    setPersistStateStep(prev => ({ ...prev, status: 'running' }));
    logger.startStep('Persist deployment state');

    const configIO = new ConfigIO();
    const agentNames = ctx.projectSpec.runtimes?.map((a: { name: string }) => a.name) || [];

    // CDK stream (I5900) only includes outputs without exportName.
    // Per-resource outputs (memory, agent, gateway) use exportName, so we
    // always need DescribeStacks for the full set. Merge stream outputs as a base.
    let outputs = { ...(streamOutputsRef.current ?? {}) };

    for (let attempt = 1; attempt <= MAX_OUTPUT_POLL_ATTEMPTS; attempt += 1) {
      logger.log(`Polling stack outputs (attempt ${attempt}/${MAX_OUTPUT_POLL_ATTEMPTS})...`);
      const apiOutputs = await getStackOutputs(target.region, currentStackName);
      if (Object.keys(apiOutputs).length > 0) {
        outputs = { ...outputs, ...apiOutputs };
        logger.log(`Retrieved ${Object.keys(apiOutputs).length} output(s) from stack`);
        break;
      }
      if (attempt < MAX_OUTPUT_POLL_ATTEMPTS) {
        logger.log(`No outputs yet, retrying in ${OUTPUT_POLL_DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, OUTPUT_POLL_DELAY_MS));
      }
    }
    if (Object.keys(outputs).length === 0) {
      throw new Error('Could not retrieve stack outputs after polling. Deployed state will not be recorded.');
    }

    const agents = parseAgentOutputs(outputs, agentNames, currentStackName);

    if (Object.keys(agents).length !== agentNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${agentNames.length - Object.keys(agents).length} agent(s).`,
        'warn'
      );
    }

    // Parse gateway outputs from CDK stack
    let gateways: Record<string, { gatewayId: string; gatewayArn: string }> = {};
    try {
      const projectForGateways = await configIO.readProjectSpec();
      const gatewaySpecs =
        projectForGateways.agentCoreGateways?.reduce(
          (acc: Record<string, unknown>, gateway: { name: string }) => {
            acc[gateway.name] = gateway;
            return acc;
          },
          {} as Record<string, unknown>
        ) ?? {};
      gateways = parseGatewayOutputs(outputs, gatewaySpecs);
    } catch (error) {
      logger.log(`Failed to read gateway configuration: ${getErrorMessage(error)}`, 'warn');
    }

    // Parse memory outputs
    const memoryNames = (ctx.projectSpec.memories ?? []).map((m: { name: string }) => m.name);
    const memories = parseMemoryOutputs(outputs, memoryNames);

    if (memoryNames.length > 0 && Object.keys(memories).length !== memoryNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${memoryNames.length - Object.keys(memories).length} memory(ies).`,
        'warn'
      );
    }

    // Parse evaluator outputs
    const evaluatorNames = (ctx.projectSpec.evaluators ?? []).map((e: { name: string }) => e.name);
    const evaluators = parseEvaluatorOutputs(outputs, evaluatorNames);

    // Parse online eval config outputs
    const onlineEvalSpecs = (ctx.projectSpec.onlineEvalConfigs ?? []).map(
      (c: { name: string; agent?: string; endpoint?: string }) => ({
        name: c.name,
        agent: c.agent,
        endpoint: c.endpoint,
      })
    );
    const onlineEvalConfigs = parseOnlineEvalOutputs(outputs, onlineEvalSpecs);

    // Parse policy engine outputs
    const policyEngineSpecs = ctx.projectSpec.policyEngines ?? [];
    const policyEngineNames = policyEngineSpecs.map((pe: { name: string }) => pe.name);
    const policyEngines = parsePolicyEngineOutputs(outputs, policyEngineNames);

    // Parse policy outputs
    const policySpecs = policyEngineSpecs.flatMap((pe: { name: string; policies: { name: string }[] }) =>
      pe.policies.map(p => ({ engineName: pe.name, policyName: p.name }))
    );
    const policies = parsePolicyOutputs(outputs, policySpecs);

    // Parse dataset outputs
    const datasetNames = (ctx.projectSpec.datasets ?? []).map((d: { name: string }) => d.name);
    const datasets = parseDatasetOutputs(outputs, datasetNames);

    // Parse config bundle outputs
    const configBundleNames = (ctx.projectSpec.configBundles ?? []).map((b: { name: string }) => b.name);
    const configBundles = parseConfigBundleOutputs(outputs, configBundleNames);

    // Parse runtime endpoint outputs
    const endpointSpecs: { agentName: string; endpointName: string }[] = [];
    for (const runtime of ctx.projectSpec.runtimes ?? []) {
      if (runtime.endpoints) {
        for (const endpointName of Object.keys(runtime.endpoints)) {
          endpointSpecs.push({ agentName: runtime.name, endpointName });
        }
      }
    }
    const runtimeEndpoints = parseRuntimeEndpointOutputs(outputs, endpointSpecs);

    // Parse knowledge base outputs (CFN emits id+arn; per-DS outputs hydrate dataSources via getAtt('DataSourceId')).
    const knowledgeBaseSpecs = ctx.projectSpec.knowledgeBases ?? [];
    const knowledgeBaseNames = knowledgeBaseSpecs.map(kb => kb.name);
    const knowledgeBases = parseKnowledgeBaseOutputs(outputs, knowledgeBaseNames);

    if (knowledgeBaseNames.length > 0 && Object.keys(knowledgeBases).length !== knowledgeBaseNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${
          knowledgeBaseNames.length - Object.keys(knowledgeBases).length
        } knowledge base(s).`,
        'warn'
      );
    }

    // Hydrate dataSources[] for any KB whose CFN per-DS outputs were absent
    // (older L3, before #234). With the current L3 the persist step has
    // already filled `dataSources[]` from per-DS outputs — the hydrate
    // function would short-circuit on every KB and the step would render as a
    // pointless "running → success" flash. Skip it (and hide it from the
    // visible step list) when nothing actually needs hydrating.
    const kbsNeedingHydration = Object.values(knowledgeBases).filter(kb => kb.dataSources.length === 0);
    if (kbsNeedingHydration.length > 0) {
      setNeedsKbHydration(true);
      setHydrateKbStep(prev => ({ ...prev, status: 'running' }));
      logger.startStep('Hydrate knowledge base data sources');
      try {
        await hydrateKnowledgeBaseDataSources({
          knowledgeBases,
          knowledgeBaseSpecs,
          region: target.region,
        });
        logger.endStep('success');
        setHydrateKbStep(prev => ({ ...prev, status: 'success' }));
      } catch (err) {
        const msg = getErrorMessage(err);
        logger.log(`Failed to hydrate knowledge base data sources: ${msg}`, 'warn');
        // Hydration failure is non-fatal — KBs are still deployed.
        logger.endStep('success');
        setHydrateKbStep(prev => ({ ...prev, status: 'warn', warn: msg }));
      }
    }

    // Expose outputs to UI
    setStackOutputs(outputs);

    // Parse payment outputs from CFN stack
    const paymentSpecs = (ctx.projectSpec.payments ?? []).map(
      (p: {
        name: string;
        authorizerType?: 'AWS_IAM' | 'CUSTOM_JWT';
        autoPayment?: boolean;
        paymentToolAllowlist?: string[];
        networkPreferences?: string[];
        connectors: { name: string; credentialName: string }[];
      }) => ({
        name: p.name,
        authorizerType: p.authorizerType,
        autoPayment: p.autoPayment,
        paymentToolAllowlist: p.paymentToolAllowlist,
        networkPreferences: p.networkPreferences,
        connectors: p.connectors.map(c => ({
          name: c.name,
          credentialProviderArn: allCredentials[c.credentialName]?.credentialProviderArn ?? '',
          credentialProviderName: c.credentialName,
        })),
      })
    );
    const payments = paymentSpecs.length > 0 ? parsePaymentOutputs(outputs, paymentSpecs) : undefined;

    const existingState = await configIO.readDeployedState().catch(() => undefined);

    // Parse harness outputs (harnesses are now part of the CloudFormation stack).
    const harnessNames = (ctx.projectSpec.harnesses ?? []).map((h: { name: string }) => h.name);
    const deployedHarnesses = parseHarnessOutputs(outputs, harnessNames);

    let deployedState = buildDeployedState({
      targetName: target.name,
      stackName: currentStackName,
      agents,
      gateways,
      existingState,
      identityKmsKeyArn,
      memories,
      evaluators,
      onlineEvalConfigs,
      credentials: Object.keys(allCredentials).length > 0 ? allCredentials : undefined,
      policyEngines,
      policies,
      datasets,
      configBundles,
      runtimeEndpoints,
      knowledgeBases,
      harnesses: deployedHarnesses,
      payments,
      abTestNames: (ctx.projectSpec.abTests ?? []).map((t: { name: string }) => t.name),
    });

    try {
      const deployHash = await computeProjectDeployHash(configIO);
      const targetState = deployedState.targets[target.name];
      if (targetState?.resources) {
        targetState.resources.deployHash = deployHash;
      }
    } catch {
      // hash computation is best-effort
    }

    await configIO.writeDeployedState(deployedState);

    logger.endStep('success');
    setPersistStateStep(prev => ({ ...prev, status: 'success' }));

    // Post-deploy: auto-trigger ingestion for any KB whose data-source URIs
    // changed since the last deploy (or has never been ingested before).
    const knowledgeBaseSpecsForIngest = ctx.projectSpec.knowledgeBases ?? [];
    if (knowledgeBaseSpecsForIngest.length > 0) {
      setAutoIngestStep(prev => ({ ...prev, status: 'running' }));
      logger.startStep('Auto-ingest knowledge bases');
      try {
        const previousKnowledgeBases = existingState?.targets?.[target.name]?.resources?.knowledgeBases;
        const ingestResult = await autoIngestKnowledgeBases({
          region: target.region,
          knowledgeBases: knowledgeBaseSpecsForIngest,
          deployedKnowledgeBases: deployedState.targets?.[target.name]?.resources?.knowledgeBases ?? {},
          previousKnowledgeBases,
          targetName: target.name,
          deployedState,
          onProgress: msg => logger.log(msg),
        });

        // Persist new sourcesHash values for KBs whose ingestion fired.
        const targetResources = deployedState.targets[target.name]?.resources;
        if (targetResources?.knowledgeBases) {
          for (const r of ingestResult.results) {
            if (r.status === 'started' && r.newSourcesHash) {
              const record = targetResources.knowledgeBases[r.knowledgeBaseName];
              if (record) record.sourcesHash = r.newSourcesHash;
            }
          }
          await configIO.writeDeployedState(deployedState);
        }

        // Log per-KB result so the user sees what happened.
        for (const r of ingestResult.results) {
          if (r.status === 'started') {
            logger.log(
              `Knowledge base "${r.knowledgeBaseName}": ingestion started for ${r.startedJobCount} data source(s)`
            );
          } else if (r.status === 'skipped') {
            logger.log(`Knowledge base "${r.knowledgeBaseName}": skipped (${r.reason})`);
          } else {
            logger.log(`Knowledge base "${r.knowledgeBaseName}": ${r.error}`, 'warn');
            setPostDeployWarnings(prev => [...prev, `Knowledge base "${r.knowledgeBaseName}": ${r.error}`]);
          }
        }

        logger.endStep(ingestResult.hasErrors ? 'error' : 'success');
        if (ingestResult.hasErrors) {
          // Don't fail the deploy — KBs and DSes are valid CFN resources even if
          // ingestion failed. The user retries via 'agentcore run ingest --name X'.
          setPostDeployHasError(true);
          setAutoIngestStep(prev => ({
            ...prev,
            status: 'error',
            error: 'One or more knowledge bases failed to ingest',
          }));
        } else {
          setAutoIngestStep(prev => ({ ...prev, status: 'success' }));
        }
      } catch (err) {
        const errMsg = getErrorMessage(err);
        logger.endStep('error', errMsg);
        setPostDeployHasError(true);
        setPostDeployWarnings(prev => [...prev, `Knowledge base auto-ingest failed: ${errMsg}`]);
        setAutoIngestStep(prev => ({ ...prev, status: 'error', error: errMsg }));
      }
    }

    // Post-deploy: Sync dataset examples from local JSONL to service DRAFT.
    const datasetSpecs = ctx.projectSpec.datasets ?? [];
    const deployedDatasetsRecord = deployedState.targets?.[target.name]?.resources?.datasets ?? {};
    if (datasetSpecs.length > 0 && Object.keys(deployedDatasetsRecord).length > 0) {
      setDatasetSyncStep(prev => ({ ...prev, status: 'running' }));
      logger.startStep('Sync datasets');
      try {
        const datasetSyncResult = await syncDatasets({
          region: target.region,
          datasets: datasetSpecs,
          deployedDatasets: deployedDatasetsRecord,
          configBaseDir: configIO.getConfigRoot(),
        });

        if (datasetSyncResult.results.some(r => r.status === 'synced')) {
          const updatedState = await configIO.readDeployedState().catch(() => deployedState);
          const targetResources = updatedState.targets[target.name]?.resources;
          if (targetResources) {
            targetResources.datasets = datasetSyncResult.updatedDatasets;
            await configIO.writeDeployedState(updatedState);
            deployedState = updatedState;
          }
        }

        if (datasetSyncResult.hasErrors) {
          const errors = datasetSyncResult.results.filter(r => r.status === 'error');
          for (const err of errors) {
            logger.log(`Dataset "${err.datasetName}" sync error: ${err.error}`, 'warn');
          }
          setPostDeployHasError(true);
          setPostDeployWarnings(prev => [...prev, ...errors.map(err => `Dataset "${err.datasetName}": ${err.error}`)]);
          logger.endStep('error', 'One or more datasets failed to sync');
          setDatasetSyncStep(prev => ({
            ...prev,
            status: 'error',
            error: 'One or more datasets failed to sync',
          }));
        } else {
          logger.endStep('success');
          setDatasetSyncStep(prev => ({ ...prev, status: 'success' }));
        }

        for (const r of datasetSyncResult.results) {
          if (r.status === 'synced') {
            logger.log(`Dataset "${r.datasetName}": +${r.added} added, ~${r.updated} updated, -${r.deleted} deleted`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.log(`Dataset sync failed: ${message}`, 'warn');
        setPostDeployHasError(true);
        setPostDeployWarnings(prev => [...prev, `Dataset sync failed: ${message}`]);
        logger.endStep('error', message);
        setDatasetSyncStep(prev => ({ ...prev, status: 'error', error: message }));
      }
    }

    // Post-deploy: Enable online eval configs that have enableOnCreate (CFN deploys them as DISABLED).
    // Only enable configs that are newly deployed — skip configs that already existed before this
    // deploy run, so we don't re-enable configs a customer intentionally disabled.
    const onlineEvalFullSpecs = ctx.projectSpec.onlineEvalConfigs ?? [];
    const deployedOnlineEvalConfigs = deployedState.targets?.[target.name]?.resources?.onlineEvalConfigs ?? {};
    const previouslyDeployedOnlineEvals = existingState?.targets?.[target.name]?.resources?.onlineEvalConfigs ?? {};
    const newOnlineEvalFullSpecs = onlineEvalFullSpecs.filter(c => !previouslyDeployedOnlineEvals[c.name]);
    if (newOnlineEvalFullSpecs.length > 0 && Object.keys(deployedOnlineEvalConfigs).length > 0) {
      setOnlineEvalStep(prev => ({ ...prev, status: 'running' }));
      logger.startStep('Enable online evaluation');
      try {
        const enableResult = await enableOnlineEvalConfigs({
          region: target.region,
          onlineEvalConfigs: newOnlineEvalFullSpecs,
          deployedOnlineEvalConfigs,
        });

        if (enableResult.hasErrors) {
          const errors = enableResult.results.filter(r => r.status === 'error');
          for (const err of errors) {
            logger.log(`Online eval enable "${err.configName}" error: ${err.error}`, 'warn');
          }
          setPostDeployHasError(true);
          setPostDeployWarnings(prev => [
            ...prev,
            ...errors.map(err => `Online eval "${err.configName}": ${err.error}`),
          ]);
          logger.endStep('error', 'One or more online eval configs failed to enable');
          setOnlineEvalStep(prev => ({
            ...prev,
            status: 'error',
            error: 'One or more online eval configs failed to enable',
          }));
        } else {
          logger.endStep('success');
          setOnlineEvalStep(prev => ({ ...prev, status: 'success' }));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.log(`Online eval enable failed: ${message}`, 'warn');
        setPostDeployHasError(true);
        setPostDeployWarnings(prev => [...prev, `Online eval enable failed: ${message}`]);
        logger.endStep('error', message);
        setOnlineEvalStep(prev => ({ ...prev, status: 'error', error: message }));
      }
    } else if (onlineEvalFullSpecs.length > 0) {
      // Step is rendered whenever onlineEvalConfigs is non-empty, but only runs for newly
      // deployed configs. With nothing new to enable, mark it terminal so the deploy completes.
      setOnlineEvalStep(prev => ({ ...prev, status: 'success' }));
    }

    // Config bundles are now managed via CloudFormation; their state is parsed
    // from stack outputs above (no post-deploy API step). AB tests are managed
    // as fire-and-forget jobs (agentcore run ab-test), not via the deploy path.

    // Query gateway target sync statuses (non-blocking)
    const allStatuses: { name: string; status: string }[] = [];
    for (const [, gateway] of Object.entries(gateways)) {
      const statuses = await getGatewayTargetStatuses(gateway.gatewayId, target.region);
      allStatuses.push(...statuses);
    }
    if (allStatuses.length > 0) {
      setTargetStatuses(allStatuses);
    }
  }, [context, stackNames, logger, identityKmsKeyArn, allCredentials]);

  // Start deploy when preflight completes OR when shouldStartDeploy is set
  useEffect(() => {
    if (diffMode) return; // Diff mode uses its own effect
    const preflightDone = preflight.phase === 'complete' || preflight.phase === 'error';
    const shouldStart = skipPreflight ? shouldStartDeploy : preflightDone;
    if (!shouldStart) return;

    // Preflight failed — emit telemetry and bail
    if (preflight.phase === 'error') {
      const error = preflight.lastError ?? new Error('Preflight failed');
      const attrs = context ? computeDeployAttrs(context.projectSpec, 'deploy') : { ...DEFAULT_DEPLOY_ATTRS };
      withCommandRunTelemetry('deploy', attrs, () => ({ success: false as const, error })).catch(() => {
        /* telemetry is best-effort */
      });
      return;
    }

    if (deployStep.status !== 'pending') return;
    if (!cdkToolkitWrapper) return;

    const attrs = context ? computeDeployAttrs(context.projectSpec, 'deploy') : { ...DEFAULT_DEPLOY_ATTRS };

    const run = async (): Promise<{ success: true } | { success: false; error: Error }> => {
      // Run diff before deploy to capture pre-deploy differences.
      // Skip for brand new stacks: CDK changeset-based diff creates a temporary stack
      // in REVIEW_IN_PROGRESS then deletes it without waiting, racing with the deploy
      // that immediately follows.
      if (!context?.isFirstDeploy && !isDiffRunningRef.current) {
        isDiffRunningRef.current = true;
        setIsDiffLoading(true);
        setPreDeployDiffStep(prev => ({ ...prev, status: 'running' }));
        logger.startStep('Computing diff changes...');
        switchableIoHost?.setOnRawMessage((code, _level, message, data) => {
          logger.logDiff(code, message);
          if (code === 'CDK_TOOLKIT_I4002') {
            setDiffSummaries(prev => [...prev, parseStackDiff(data, message)]);
          } else if (code === 'CDK_TOOLKIT_I4001') {
            setNumStacksWithChanges(parseDiffResult(data).numStacksWithChanges);
          }
        });
        switchableIoHost?.setVerbose(true);
        try {
          await cdkToolkitWrapper.diff();
        } catch {
          // Diff failure is non-fatal — deploy will proceed
        } finally {
          switchableIoHost?.setVerbose(false);
          switchableIoHost?.setOnRawMessage(null);
          isDiffRunningRef.current = false;
          setIsDiffLoading(false);
          logger.endStep('success');
          setPreDeployDiffStep(prev => ({ ...prev, status: 'success' }));
        }
      } else if (context?.isFirstDeploy) {
        setPreDeployDiffStep(prev => ({ ...prev, status: 'success', label: 'Skip diff (new stack)' }));
      }

      // Managed-memory heads-up: surface BEFORE the slow CFN apply so the 3-5 min memory
      // provisioning wait is explained while it happens. Mirrors the CLI command path; both
      // read the same shared detection + notice text so the wording can't drift.
      if (!context?.isTeardownDeploy) {
        const noticeConfigIO = new ConfigIO();
        if (await hasManagedMemoryHarness(noticeConfigIO, context?.projectSpec.harnesses)) {
          logger.log(MANAGED_MEMORY_DEPLOY_NOTICE);
          setManagedMemoryNotice(MANAGED_MEMORY_DEPLOY_NOTICE);
        }
      }

      setPublishAssetsStep(prev => ({ ...prev, status: 'running' }));
      setShouldStartDeploy(false);
      setDeployMessages([]); // Clear previous messages
      streamOutputsRef.current = null; // Clear previous stream outputs
      logger.startStep('Publish assets');

      // Set up raw message callback to log ALL CDK output
      switchableIoHost?.setOnRawMessage((code, level, message) => {
        logger.log(`[${level}] ${code}: ${message}`);
      });

      // Set up filtered message callback for TUI display
      switchableIoHost?.setOnMessage(msg => {
        setDeployMessages(prev => [...prev, msg]);
        // When we receive the first CloudFormation event with progress, mark assets as published
        if (!hasReceivedCfnEvent.current && msg.progress) {
          hasReceivedCfnEvent.current = true;
          setHasStartedCfn(true);
          logger.endStep('success');
          logger.startStep('Deploy to AWS');
          setPublishAssetsStep(prev => ({ ...prev, status: 'success' }));
          setDeployStep(prev => ({ ...prev, status: 'running' }));
        }
        // Capture outputs from I5900 for immediate use in persistDeployedState
        if (msg.code === 'CDK_TOOLKIT_I5900' && msg.outputs) {
          streamOutputsRef.current = msg.outputs;
        }
      });

      // Enable verbose output for deploy - this captures CDK progress messages
      switchableIoHost?.setVerbose(true);

      try {
        // Run deploy - toolkit-lib handles CloudFormation orchestration
        // Output goes to stdout via the switchable ioHost
        await cdkToolkitWrapper.deploy();

        // CDK deploy itself is done. Mark "Deploy to AWS" success and let post-deploy
        // phases (persist, hydrate KBs, auto-ingest, dataset sync, online evals,
        // config bundles, HTTP gateways, AB tests) advance their own visible steps.
        //
        // No-change deploys never receive a progress-bearing CloudFormation event, so
        // the message handler above never flips Publish assets out of 'running'. Catch
        // both 'pending' and 'running' here so the step never gets stranded — without
        // this the UI shows "stuck on Publish assets" during a 2m+ post-deploy ingest
        // even though the underlying deploy had completed seconds in.
        logger.endStep('success');
        setPublishAssetsStep(prev =>
          prev.status === 'success' || prev.status === 'error' ? prev : { ...prev, status: 'success' }
        );
        setDeployStep(prev => ({ ...prev, status: 'success' }));

        if (context?.isTeardownDeploy) {
          // After deploying the empty spec, destroy the stack entirely.
          // Harnesses are part of the CloudFormation stack, so stack destroy handles them.
          // Clean up imperative payment credential providers before stack teardown.
          const targetName = context.awsTargets[0]?.name;
          if (targetName) {
            try {
              const configIO = new ConfigIO();
              const deployedState = await configIO.readDeployedState();
              const existingPayments = deployedState?.targets?.[targetName]?.resources?.payments;
              if (existingPayments && Object.keys(existingPayments).length > 0) {
                const target = context.awsTargets[0]!;
                await cleanupPaymentCredentialProviders({ region: target.region, payments: existingPayments });
              }
            } catch {
              // Best-effort: continue with teardown even if credential cleanup fails
            }

            const teardown = await performStackTeardown(targetName);
            if (!teardown.success) {
              throw new Error(`Stack teardown failed: ${teardown.error.message}`);
            }
          }
        } else {
          // Deploy succeeded - persist state
          try {
            await persistDeployedState();
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.log(`Failed to persist deployed state: ${message}`, 'warn');
            // Mark whichever post-deploy step was running as errored so the visible
            // step list resolves (areStepsComplete requires every step terminal).
            // Only the persist step is reachable here without local handling.
            setPersistStateStep(prev =>
              prev.status === 'running' ? { ...prev, status: 'error', error: message } : prev
            );
            setHydrateKbStep(prev => (prev.status === 'running' ? { ...prev, status: 'error', error: message } : prev));
            setPostDeployHasError(true);
            setPostDeployWarnings(p => [...p, `Persist deployed state failed: ${message}`]);
          }

          // Post-deploy: Enable CloudWatch Transaction Search (non-blocking, silent)
          const agentNames = context?.projectSpec.runtimes?.map((a: { name: string }) => a.name) ?? [];
          const targetRegion = context?.awsTargets[0]?.region;
          const targetAccount = context?.awsTargets[0]?.account;
          const hasGateways = (context?.projectSpec.agentCoreGateways?.length ?? 0) > 0;
          const hasPythonAgent =
            context?.projectSpec.runtimes?.some(
              (a: { entrypoint?: string }) =>
                (a.entrypoint?.endsWith('.py') ?? false) || (a.entrypoint?.includes('.py:') ?? false)
            ) ?? false;
          if ((agentNames.length > 0 || hasGateways) && hasPythonAgent && targetRegion && targetAccount) {
            try {
              const tsResult = await setupTransactionSearch({
                region: targetRegion,
                accountId: targetAccount,
                agentNames,
                hasGateways,
              });
              if (!tsResult.success) {
                logger.log(`Transaction search setup warning: ${tsResult.error.message}`, 'warn');
              } else {
                setDeployNotes(prev => [
                  ...prev,
                  'Transaction search enabled. It takes ~10 minutes for transaction search to be fully active and for traces from invocations to be indexed.',
                ]);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown error';
              logger.log(`Transaction search setup failed: ${message}`, 'warn');
            }
          }
        }

        // Close any still-open logger step (defensive — post-deploy phases manage
        // their own start/end pairs, so this usually no-ops).
        logger.endStep('success');
        logger.finalize(true);
        setDeployOutput(`Deployed ${stackNames.length} stack(s): ${stackNames.join(', ')}`);
        return { success: true } as const;
      } catch (err) {
        const errorMsg = getErrorMessage(err);

        // Log additional context for changeset errors
        if (isChangesetInProgressError(err)) {
          logger.log('Changeset conflict detected - another deployment may be in progress', 'warn');
          logger.log('The CDK wrapper will retry automatically with exponential backoff', 'info');
        }

        logger.endStep('error', errorMsg);
        logger.finalize(false);

        // Check if the error is due to expired/invalid credentials
        if (isExpiredTokenError(err)) {
          setHasTokenExpiredError(true);
        }

        // Mark the appropriate step as error based on whether CFn started
        if (hasReceivedCfnEvent.current) {
          setDeployStep(prev => ({
            ...prev,
            status: 'error',
            error: logger.getFailureMessage('Deploy to AWS'),
          }));
        } else {
          setPublishAssetsStep(prev => ({
            ...prev,
            status: 'error',
            error: logger.getFailureMessage('Publish assets'),
          }));
        }
        return { success: false, error: err instanceof Error ? err : new Error(errorMsg) } as const;
      } finally {
        // Disable verbose output and clear callback after deploy
        switchableIoHost?.setVerbose(false);
        switchableIoHost?.setOnMessage(null);
        // Dispose CDK toolkit to release lock files
        void cdkToolkitWrapper.dispose();
      }
    };

    void withCommandRunTelemetry('deploy', attrs, run);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preflight.lastError and context are read only on error path
  }, [
    preflight.phase,
    cdkToolkitWrapper,
    stackNames,
    deployStep.status,
    logger,
    skipPreflight,
    shouldStartDeploy,
    persistDeployedState,
    switchableIoHost,
    context?.isTeardownDeploy,
    context?.awsTargets,
    context?.projectSpec.runtimes,
    diffMode,
  ]);

  // Start diff when preflight completes (diff mode only)
  useEffect(() => {
    if (!diffMode) return;
    const preflightDone = preflight.phase === 'complete' || preflight.phase === 'error';
    const shouldStart = skipPreflight ? shouldStartDeploy : preflightDone;
    if (!shouldStart) return;

    // Preflight failed — emit telemetry and bail
    if (preflight.phase === 'error') {
      const error = preflight.lastError ?? new Error('Preflight failed');
      const attrs = context
        ? computeDeployAttrs(context.projectSpec, 'diff')
        : { ...DEFAULT_DEPLOY_ATTRS, deploy_mode: 'diff' as const };
      withCommandRunTelemetry('deploy', attrs, () => ({ success: false as const, error })).catch(() => {
        /* telemetry is best-effort */
      });
      return;
    }

    if (diffStep.status !== 'pending') return;
    if (!cdkToolkitWrapper) return;

    const attrs = context
      ? computeDeployAttrs(context.projectSpec, 'diff')
      : { ...DEFAULT_DEPLOY_ATTRS, deploy_mode: 'diff' as const };

    const run = async (): Promise<{ success: true } | { success: false; error: Error }> => {
      setDiffStep(prev => ({ ...prev, status: 'running' }));
      setShouldStartDeploy(false);
      setDiffSummaries([]);
      logger.startStep('Run CDK diff');

      switchableIoHost?.setOnRawMessage((code, _level, message, data) => {
        logger.logDiff(code, message);
        if (code === 'CDK_TOOLKIT_I4002') {
          setDiffSummaries(prev => [...prev, parseStackDiff(data, message)]);
        } else if (code === 'CDK_TOOLKIT_I4001') {
          setNumStacksWithChanges(parseDiffResult(data).numStacksWithChanges);
        }
      });
      switchableIoHost?.setVerbose(true);

      try {
        await cdkToolkitWrapper.diff();
        logger.endStep('success');
        logger.finalize(true);
        setDiffStep(prev => ({ ...prev, status: 'success' }));
        return { success: true };
      } catch (err) {
        const errorMsg = getErrorMessage(err);
        logger.endStep('error', errorMsg);
        logger.finalize(false);

        if (isExpiredTokenError(err)) {
          setHasTokenExpiredError(true);
        }

        setDiffStep(prev => ({
          ...prev,
          status: 'error',
          error: logger.getFailureMessage('Run CDK diff'),
        }));
        return { success: false, error: err instanceof Error ? err : new Error(errorMsg) };
      } finally {
        switchableIoHost?.setVerbose(false);
        switchableIoHost?.setOnRawMessage(null);
        void cdkToolkitWrapper.dispose();
      }
    };

    void withCommandRunTelemetry('deploy', attrs, run);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preflight.lastError and context are read only on error path
  }, [
    diffMode,
    preflight.phase,
    cdkToolkitWrapper,
    diffStep.status,
    logger,
    skipPreflight,
    shouldStartDeploy,
    switchableIoHost,
  ]);

  // Finalize logger and dispose toolkit when preflight fails
  useEffect(() => {
    if (skipPreflight) return;
    if (preflight.phase === 'error') {
      logger.finalize(false);
      void preflight.cdkToolkitWrapper?.dispose();
    }
  }, [preflight.phase, preflight.cdkToolkitWrapper, logger, skipPreflight]);

  // Project-content-driven inclusion: only show post-deploy steps that will actually run.
  const projectSpec = context?.projectSpec;
  const hasKnowledgeBases = (projectSpec?.knowledgeBases?.length ?? 0) > 0;
  const hasDatasets = (projectSpec?.datasets?.length ?? 0) > 0;
  const hasOnlineEvalConfigs = (projectSpec?.onlineEvalConfigs?.length ?? 0) > 0;

  const steps = useMemo(() => {
    if (diffMode) {
      return skipPreflight ? [diffStep] : [...preflight.steps, diffStep];
    }
    const preflightSteps = skipPreflight ? [] : preflight.steps;
    const isTeardown = projectSpec ? !!context?.isTeardownDeploy : false;

    const postDeploySteps: Step[] = isTeardown
      ? []
      : [
          persistStateStep,
          ...(hasKnowledgeBases && needsKbHydration ? [hydrateKbStep] : []),
          ...(hasKnowledgeBases ? [autoIngestStep] : []),
          ...(hasDatasets ? [datasetSyncStep] : []),
          ...(hasOnlineEvalConfigs ? [onlineEvalStep] : []),
        ];

    return [...preflightSteps, preDeployDiffStep, publishAssetsStep, deployStep, ...postDeploySteps];
  }, [
    preflight.steps,
    preDeployDiffStep,
    publishAssetsStep,
    deployStep,
    persistStateStep,
    hydrateKbStep,
    autoIngestStep,
    datasetSyncStep,
    onlineEvalStep,
    diffStep,
    skipPreflight,
    diffMode,
    hasKnowledgeBases,
    needsKbHydration,
    hasDatasets,
    hasOnlineEvalConfigs,
    context?.isTeardownDeploy,
    projectSpec,
  ]);

  const hasError = hasStepError(steps);
  const isComplete = areStepsComplete(steps);

  const phase: DeployPhase = useMemo(() => {
    if (diffMode) {
      const activeStep = diffStep;
      if (skipPreflight) {
        if (!shouldStartDeploy && activeStep.status === 'pending') {
          return 'idle';
        }
        if (activeStep.status === 'error') {
          return 'error';
        }
        if (activeStep.status === 'success') {
          return 'complete';
        }
        return 'deploying';
      }

      if (preflight.phase === 'idle') return 'idle';
      if (preflight.phase === 'error') return 'error';
      if (preflight.phase === 'teardown-confirm') return 'teardown-confirm';
      if (preflight.phase === 'credentials-prompt') return 'credentials-prompt';
      if (preflight.phase === 'bootstrap-confirm') return 'bootstrap-confirm';
      if (
        preflight.phase === 'running' ||
        preflight.phase === 'bootstrapping' ||
        preflight.phase === 'identity-setup'
      ) {
        return 'running';
      }
      if (activeStep.status === 'error') return 'error';
      if (activeStep.status === 'success') return 'complete';
      return 'deploying';
    }

    // Deploy mode: derive from the full visible step list so post-CDK phases can
    // hold the flow in 'deploying' until they all settle.
    if (skipPreflight) {
      if (!shouldStartDeploy && deployStep.status === 'pending') {
        return 'idle';
      }
      if (hasError) return 'error';
      if (isComplete) return 'complete';
      return 'deploying';
    }

    if (preflight.phase === 'idle') return 'idle';
    if (preflight.phase === 'error') return 'error';
    if (preflight.phase === 'teardown-confirm') return 'teardown-confirm';
    if (preflight.phase === 'credentials-prompt') return 'credentials-prompt';
    if (preflight.phase === 'bootstrap-confirm') return 'bootstrap-confirm';
    if (preflight.phase === 'running' || preflight.phase === 'bootstrapping' || preflight.phase === 'identity-setup') {
      return 'running';
    }
    if (hasError) return 'error';
    if (isComplete) return 'complete';
    return 'deploying';
  }, [preflight.phase, deployStep, diffStep, skipPreflight, shouldStartDeploy, diffMode, hasError, isComplete]);

  // Combine token expired errors from both preflight and deploy phases
  const combinedTokenExpiredError = hasTokenExpiredError || preflight.hasTokenExpiredError;

  const clearAllTokenExpiredErrors = useCallback(() => {
    setHasTokenExpiredError(false);
    preflight.clearTokenExpiredError();
  }, [preflight]);

  const clearAllCredentialsErrors = useCallback(() => {
    preflight.clearCredentialsError();
  }, [preflight]);

  return {
    phase,
    steps,
    context,
    deployOutput,
    deployMessages,
    diffSummaries,
    numStacksWithChanges,
    deployNotes,
    managedMemoryNotice,
    postDeployWarnings,
    postDeployHasError,
    isDiffLoading,
    requestDiff,
    stackOutputs,
    targetStatuses,
    hasError,
    hasTokenExpiredError: combinedTokenExpiredError,
    hasCredentialsError: preflight.hasCredentialsError,
    isComplete,
    hasStartedCfn,
    logFilePath: logger.logFilePath,
    missingCredentials: preflight.missingCredentials,
    startDeploy,
    confirmTeardown: preflight.confirmTeardown,
    cancelTeardown: preflight.cancelTeardown,
    confirmBootstrap: preflight.confirmBootstrap,
    skipBootstrap: preflight.skipBootstrap,
    clearTokenExpiredError: clearAllTokenExpiredErrors,
    clearCredentialsError: clearAllCredentialsErrors,
    useEnvLocalCredentials: preflight.useEnvLocalCredentials,
    useManualCredentials: preflight.useManualCredentials,
    skipCredentials: preflight.skipCredentials,
  };
}
