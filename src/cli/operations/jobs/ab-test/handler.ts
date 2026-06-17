/**
 * AB-test job handler — composes Startable, Refreshable, Stoppable, Pausable, Promotable, Archivable.
 *
 *  - create():  resolve region + gateway ARN (gateway must already be deployed), build variants +
 *               eval config, create (or reuse) the execution role, make ONE CreateABTest call
 *               (with AccessDenied retry while IAM propagates), persist the record. The role is
 *               cleaned up if the create call ultimately fails.
 *  - refresh(): GET latest state; map 404 → NOT_FOUND. Store executionStatus in `status` and the
 *               lifecycle `status` in `lifecycleStatus`; carry results / failureReason / expiry.
 *  - stop/pause/resume(): UpdateABTest executionStatus = STOPPED / PAUSED / RUNNING.
 *  - promote(): wait until RUNNING, stop, then apply the winning variant to agentcore.json.
 *  - archive(): stop → poll STOPPED → DeleteABTest → delete the role if the CLI created it.
 */
import { ConfigIO, JobNotFoundError, ResourceNotFoundError, toError } from '../../../../lib';
import type { Result } from '../../../../lib/result';
import type { DeployedResourceState, DeployedState } from '../../../../schema';
import { getCredentialProvider } from '../../../aws/account';
import { createABTest, deleteABTest, getABTest, listABTests, updateABTest } from '../../../aws/agentcore-ab-tests';
import { getGatewayDetail, getOnlineEvaluationConfig } from '../../../aws/agentcore-control';
import { detectRegion } from '../../../aws/region';
import { getErrorMessage } from '../../../errors';
import { ExecLogger } from '../../../logging/exec-logger';
import { NOT_FOUND_STATUS } from '../shared/constants';
import { regionFromArn, resolveJobRegion } from '../shared/region';
import type { ABTestHandler, ABTestJobRecord, DebugCheckResult, StartABTestJobOptions } from '../shared/types';
import { buildABTestRequest } from './build-options';
import { promoteABTestConfig } from './promote';
import { deleteABTestRole, getOrCreateABTestRole, resolveGatewayArn } from './resolve';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

/** AB-test create retries while the freshly-created IAM role propagates (gateway/eval AccessDenied). */
const MAX_CREATE_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 5_000;

/** Merge per-target deployed resources into one view (AB tests resolve names across all targets). */
function mergeDeployedResources(deployedState: DeployedState): DeployedResourceState {
  const merged: DeployedResourceState = {};
  for (const target of Object.values(deployedState.targets)) {
    const r = target.resources;
    if (!r) continue;
    Object.assign(merged, {
      mcp: { ...merged.mcp, ...r.mcp },
      gateways: { ...merged.gateways, ...r.gateways },
      configBundles: { ...merged.configBundles, ...r.configBundles },
      onlineEvalConfigs: { ...merged.onlineEvalConfigs, ...r.onlineEvalConfigs },
    });
  }
  return merged;
}

/** Poll executionStatus until STOPPED (best-effort, bounded). */
async function pollUntilStopped(region: string, abTestId: string, attempts = 20, delayMs = 3_000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const test = await getABTest({ region, abTestId });
      if (test.executionStatus === 'STOPPED') return true;
    } catch (err) {
      if (err instanceof JobNotFoundError) return true; // already gone
      // transient — keep polling
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

/**
 * Wait until the test reaches RUNNING (a just-created test may still be enabling), then stop it.
 * Throws if it never reaches RUNNING — promotion of a never-started test is not meaningful.
 */
async function waitForRunningThenStop(
  region: string,
  abTestId: string,
  attempts = 12,
  delayMs = 10_000
): Promise<void> {
  let status: string | undefined;
  for (let i = 0; i < attempts; i++) {
    const current = await getABTest({ region, abTestId });
    status = current.executionStatus;
    if (status === 'RUNNING') break;
    if (status === 'STOPPED') return; // already stopped — nothing more to do
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (status !== 'RUNNING') {
    throw new Error(`A/B test "${abTestId}" did not reach RUNNING (current: ${status}); cannot promote.`);
  }
  await updateABTest({ region, abTestId, executionStatus: 'STOPPED' });
}

export const abTestHandler: ABTestHandler = {
  async create(opts: StartABTestJobOptions, configIO: ConfigIO): Promise<Result<{ record: ABTestJobRecord }>> {
    let logger: ExecLogger | undefined;
    try {
      logger = new ExecLogger({ command: 'ab-test' });
    } catch {
      // non-fatal
    }

    let region = '';
    let roleArn: string | undefined;
    let roleCreatedByCli = false;
    try {
      logger?.startStep('Load project config');
      const [projectSpec, deployedState, awsTargets] = await Promise.all([
        configIO.readProjectSpec(),
        configIO.readDeployedState(),
        configIO.resolveAWSDeploymentTargets(),
      ]);
      region = await resolveJobRegion(opts.region, awsTargets);
      const deployedResources = mergeDeployedResources(deployedState);
      logger?.endStep('success');

      // Gateway must already be deployed — we never auto-create it.
      logger?.startStep('Resolve gateway');
      const gatewayArn = resolveGatewayArn(opts.gateway, deployedResources);
      if (!gatewayArn || !gatewayArn.startsWith('arn:') || gatewayArn.split(':').length < 6) {
        const err = new ResourceNotFoundError(
          `Gateway "${opts.gateway}" is not deployed. Run \`agentcore add gateway\` and \`agentcore deploy\` first.`
        );
        logger?.endStep('error', err.message);
        logger?.finalize(false);
        return { success: false, error: err };
      }
      logger?.log(`Gateway ARN: ${gatewayArn}`);
      logger?.endStep('success');

      // Build variants + eval config (throws ValidationError on missing mode inputs).
      const built = buildABTestRequest(opts, deployedResources);

      // Resolve (or create) the execution role.
      logger?.startStep('Resolve execution role');
      if (opts.roleArn) {
        roleArn = opts.roleArn;
      } else {
        opts.onProgress?.('role', 'Creating execution role (waiting for IAM propagation)...');
        roleArn = await getOrCreateABTestRole({
          region,
          projectName: projectSpec.name,
          testName: opts.name,
          gatewayArn,
        });
        roleCreatedByCli = true;
      }
      logger?.log(`Role ARN: ${roleArn}`);
      logger?.endStep('success');

      // ONE create call, with AccessDenied retry while IAM propagates.
      logger?.startStep('Create A/B test');
      opts.onProgress?.('starting', `Creating A/B test "${opts.name}"...`);
      const createOptions = {
        region,
        name: `${projectSpec.name}_${opts.name}`,
        description: opts.description,
        gatewayArn,
        roleArn,
        variants: built.variants,
        evaluationConfig: built.evaluationConfig,
        gatewayFilter: built.gatewayFilter,
        enableOnCreate: opts.enableOnCreate,
      };

      let createResult;
      for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
        try {
          createResult = await createABTest(createOptions);
          break;
        } catch (err: unknown) {
          const errCode = (err as { name?: string }).name;
          const errStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
          const msg = err instanceof Error ? err.message : String(err);
          const isRetryable =
            errCode === 'AccessDeniedException' ||
            errStatus === 403 ||
            msg.includes('Access denied') ||
            msg.includes('Gateway validation error');
          if (isRetryable && attempt < MAX_CREATE_RETRIES - 1) {
            const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            opts.onProgress?.('retry', `Access not yet propagated; retrying (attempt ${attempt + 2})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
      if (!createResult) {
        throw new Error('A/B test creation failed after retries.');
      }
      logger?.log(`Response: ${JSON.stringify(createResult, null, 2)}`);
      logger?.endStep('success');
      opts.onProgress?.('started', `A/B test created: ${createResult.abTestId} (${createResult.executionStatus})`);
      logger?.finalize(true);

      const record: ABTestJobRecord = {
        type: 'ab-test',
        id: createResult.abTestId,
        arn: createResult.abTestArn,
        status: createResult.status,
        lifecycleStatus: createResult.executionStatus,
        createdAt: createResult.createdAt ?? new Date().toISOString(),
        agent: opts.agent ?? opts.runtime ?? opts.name,
        logFilePath: logger?.logFilePath,
        name: opts.name,
        mode: opts.mode,
        gatewayArn,
        gatewayName: opts.gateway,
        roleArn,
        roleCreatedByCli,
        variants: built.variantSummaries,
        evaluationConfig: built.evaluationConfig,
        gatewayFilter: built.gatewayFilter,
      };
      return { success: true, record };
    } catch (err) {
      // Clean up an auto-created role so a failed create doesn't orphan IAM resources.
      if (roleCreatedByCli && roleArn && region) {
        try {
          await deleteABTestRole(region, roleArn);
        } catch {
          // best-effort
        }
      }
      logger?.finalize(false);
      return { success: false, error: toError(err) };
    }
  },

  async refresh(record: ABTestJobRecord): Promise<Result<{ record: ABTestJobRecord }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    let response;
    try {
      response = await getABTest({ region, abTestId: record.id });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        return { success: true, record: { ...record, status: NOT_FOUND_STATUS, lifecycleStatus: NOT_FOUND_STATUS } };
      }
      return { success: false, error: toError(err) };
    }

    const failureReason = response.failureReason ?? response.errorDetails?.join('; ') ?? record.failureReason;

    return {
      success: true,
      record: {
        ...record,
        status: response.status,
        lifecycleStatus: response.executionStatus,
        completedAt: response.stoppedAt ?? record.completedAt,
        maxDurationExpiresAt: response.maxDurationExpiresAt ?? record.maxDurationExpiresAt,
        results: response.results ?? record.results,
        failureReason,
      },
    };
  },

  async stop(record: ABTestJobRecord): Promise<Result> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      await updateABTest({ region, abTestId: record.id, executionStatus: 'STOPPED' });
      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  },

  async pause(record: ABTestJobRecord): Promise<Result<{ record: ABTestJobRecord }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      await updateABTest({ region, abTestId: record.id, executionStatus: 'PAUSED' });
      return { success: true, record: { ...record, lifecycleStatus: 'PAUSED' } };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  },

  async resume(record: ABTestJobRecord): Promise<Result<{ record: ABTestJobRecord }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      await updateABTest({ region, abTestId: record.id, executionStatus: 'RUNNING' });
      return { success: true, record: { ...record, lifecycleStatus: 'RUNNING' } };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  },

  async promote(record: ABTestJobRecord, _configIO: ConfigIO): Promise<Result<{ record: ABTestJobRecord }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      // Validate the winning variant is applicable to agentcore.json BEFORE stopping the test
      // (dry run, no writes). This avoids the trap where promote stops a running test and only
      // then discovers it can't apply the winner — e.g. target-based with no named runtime
      // endpoint — leaving the test stopped but config unchanged.
      const preflight = await promoteABTestConfig(record, true);
      if (!preflight.promoted) {
        return {
          success: false,
          error: new Error(
            `Cannot promote A/B test "${record.id}": ${preflight.promotionDetail} ` +
              `The test was left running (not stopped).`
          ),
        };
      }

      // Promotion stops the test first (running tests apply continuously), then mutates config.
      await waitForRunningThenStop(region, record.id);
      const promotion = await promoteABTestConfig(record);
      if (!promotion.promoted) {
        // The test was stopped, but applying the winning variant to agentcore.json failed.
        // Surface the failure so the user knows config wasn't updated (test is already STOPPED).
        return {
          success: false,
          error: new Error(
            `A/B test "${record.id}" was stopped, but the winning variant could not be applied to agentcore.json: ${promotion.promotionDetail}`
          ),
        };
      }
      return { success: true, record: { ...record, lifecycleStatus: 'STOPPED' } };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  },

  async archive(record: ABTestJobRecord): Promise<Result> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      // Running tests can't be deleted — stop and wait for STOPPED first (best-effort).
      try {
        await updateABTest({ region, abTestId: record.id, executionStatus: 'STOPPED' });
        await pollUntilStopped(region, record.id);
      } catch (err) {
        if (!(err instanceof JobNotFoundError)) {
          // already-stopped / transient — proceed to delete
        }
      }
      const deleteResult = await deleteABTest({ region, abTestId: record.id });
      if (!deleteResult.success && !deleteResult.error?.includes('404')) {
        return { success: false, error: new Error(deleteResult.error ?? 'Failed to delete A/B test.') };
      }
      if (record.roleCreatedByCli && record.roleArn) {
        try {
          const allTests = await listABTests({ region, maxResults: 100 });
          const activeTests = allTests.abTests.filter(
            t => t.abTestId !== record.id && !['STOPPED', 'CREATE_FAILED', 'DELETE_FAILED'].includes(t.status)
          );
          let roleInUse = false;
          for (const test of activeTests) {
            const detail = await getABTest({ region, abTestId: test.abTestId });
            if (detail.roleArn === record.roleArn) {
              roleInUse = true;
              break;
            }
          }
          if (!roleInUse) {
            await deleteABTestRole(region, record.roleArn);
          }
        } catch {
          // Best-effort: if we can't verify, skip deletion (safe side — don't orphan other tests)
        }
      }
      return { success: true };
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        return { success: true };
      }
      return { success: false, error: toError(err) };
    }
  },

  async debug(record: ABTestJobRecord): Promise<Result<{ checks: DebugCheckResult[] }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    const results: DebugCheckResult[] = [];

    // 1. Fetch fresh state from the API
    let test;
    try {
      test = await getABTest({ region, abTestId: record.id });
      results.push({
        label: 'AB Test Status',
        status: test.status === 'ACTIVE' && test.executionStatus === 'RUNNING' ? 'pass' : 'warn',
        detail: `${test.status} / ${test.executionStatus}`,
      });
    } catch (err) {
      results.push({ label: 'AB Test Status', status: 'fail', detail: getErrorMessage(err) });
      return { success: true, checks: results };
    }

    // 2. Role
    results.push({
      label: 'AB Test Role',
      status: test.roleArn ? 'pass' : 'warn',
      detail: test.roleArn ?? 'No role ARN',
    });

    // 3. Online Eval Config(s)
    const evalConfigArns: { name: string; arn: string }[] =
      'perVariantOnlineEvaluationConfig' in test.evaluationConfig
        ? test.evaluationConfig.perVariantOnlineEvaluationConfig.map(v => ({
            name: v.name,
            arn: v.onlineEvaluationConfigArn,
          }))
        : [{ name: '', arn: test.evaluationConfig.onlineEvaluationConfigArn }];

    for (const { name: variantName, arn: evalArn } of evalConfigArns) {
      const evalConfigId = evalArn.split('/').pop() ?? evalArn;
      const labelSuffix = variantName ? ` (${variantName})` : '';
      try {
        const evalConfig = await getOnlineEvaluationConfig({ region, configId: evalConfigId });
        results.push({
          label: `Online Eval Config${labelSuffix}`,
          status: evalConfig.executionStatus === 'ENABLED' ? 'pass' : 'fail',
          detail: `${evalConfig.configName} — ${evalConfig.executionStatus}`,
        });
      } catch (err) {
        results.push({ label: `Online Eval Config${labelSuffix}`, status: 'fail', detail: getErrorMessage(err) });
      }
    }

    // 4. Gateway role
    const gatewayId = test.gatewayArn.split('/').pop() ?? '';
    try {
      const gateway = await getGatewayDetail({ region, gatewayId });
      results.push({
        label: 'Gateway Role',
        status: gateway.roleArn ? 'pass' : 'warn',
        detail: gateway.roleArn ?? 'No role ARN',
      });
    } catch (err) {
      results.push({ label: 'Gateway Role', status: 'fail', detail: getErrorMessage(err) });
    }

    // 5. Runtime experiment spans (last 2h)
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const logsClient = new CloudWatchLogsClient({ region, credentials: getCredentialProvider() });
    const variantNames = test.variants.map(v => v.name);

    try {
      // Check for spans tagged with the AB test ARN per variant
      for (const name of variantNames) {
        try {
          const response = await logsClient.send(
            new FilterLogEventsCommand({
              logGroupName: 'aws/spans',
              startTime: twoHoursAgo,
              filterPattern: `"${test.abTestArn}" "${name}"`,
              limit: 5,
            })
          );
          const count = response.events?.length ?? 0;
          results.push({
            label: `Experiment Spans — ${name} (2h)`,
            status: count > 0 ? 'pass' : 'warn',
            detail:
              count > 0
                ? `${count}+ spans with experiment metadata`
                : 'No spans found — traffic may not be reaching this variant',
          });
        } catch (err) {
          results.push({ label: `Experiment Spans — ${name}`, status: 'warn', detail: getErrorMessage(err) });
        }
      }
    } catch (err) {
      results.push({ label: 'Experiment Spans', status: 'warn', detail: getErrorMessage(err) });
    }

    return { success: true, checks: results };
  },
};
