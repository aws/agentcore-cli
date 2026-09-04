import {
  CreateConfigurationBundleCommand,
  AddDatasetExamplesCommand,
  CreateDatasetCommand,
  CreateDatasetVersionCommand,
  CreateEvaluatorCommand,
  CreateOnlineEvaluationConfigCommand,
  DeleteConfigurationBundleCommand,
  DeleteDatasetCommand,
  DeleteDatasetExamplesCommand,
  DeleteEvaluatorCommand,
  DeleteOnlineEvaluationConfigCommand,
  GetConfigurationBundleCommand,
  GetConfigurationBundleVersionCommand,
  GetAgentRuntimeCommand,
  GetDatasetCommand,
  GetEvaluatorCommand,
  GetHarnessCommand,
  GetGatewayCommand,
  GetOnlineEvaluationConfigCommand,
  ListConfigurationBundlesCommand,
  ListConfigurationBundleVersionsCommand,
  ListDatasetsCommand,
  ListEvaluatorsCommand,
  ListOnlineEvaluationConfigsCommand,
  UpdateConfigurationBundleCommand,
  UpdateDatasetExamplesCommand,
  UpdateEvaluatorCommand,
  UpdateOnlineEvaluationConfigCommand,
  type CreateConfigurationBundleResponse,
  type AddDatasetExamplesResponse,
  type BedrockAgentCoreControlClient,
  type CreateDatasetResponse,
  type CreateDatasetVersionResponse,
  type CreateEvaluatorRequest,
  type CreateEvaluatorResponse,
  type CreateOnlineEvaluationConfigResponse,
  type DeleteConfigurationBundleResponse,
  type DeleteDatasetResponse,
  type DeleteEvaluatorResponse,
  type DeleteOnlineEvaluationConfigResponse,
  type DatasetStatus,
  type EvaluatorConfig,
  type GetConfigurationBundleResponse,
  type GetConfigurationBundleVersionResponse,
  type GetDatasetResponse,
  type GetEvaluatorResponse,
  type GetOnlineEvaluationConfigResponse,
  type ListConfigurationBundlesResponse,
  type ListConfigurationBundleVersionsResponse,
  type ListDatasetsResponse,
  type ListEvaluatorsResponse,
  type DataSourceConfig,
  type ListOnlineEvaluationConfigsResponse,
  type Rule,
  type EvaluatorLevel,
  type UpdateConfigurationBundleResponse,
  type UpdateEvaluatorResponse,
  type UpdateOnlineEvaluationConfigResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  DeleteRecommendationCommand,
  EvaluateCommand,
  CreateABTestCommand,
  GetABTestCommand,
  ListABTestsCommand,
  UpdateABTestCommand,
  DeleteABTestCommand,
  GetBatchEvaluationCommand,
  GetRecommendationCommand,
  ListBatchEvaluationsCommand,
  ListRecommendationsCommand,
  StartBatchEvaluationCommand,
  StartRecommendationCommand,
  type DeleteRecommendationResponse,
  type EvaluationReferenceInput,
  type EvaluationResultContent,
  type EvaluationTarget,
  type CreateABTestRequest,
  type CreateABTestResponse,
  type GetABTestResponse,
  type ListABTestsResponse,
  type ABTestExecutionStatus,
  type UpdateABTestResponse,
  type DeleteABTestResponse,
  type GetRecommendationResponse,
  type ListBatchEvaluationsResponse,
  type ListRecommendationsResponse,
  type RecommendationStatus,
  type StartBatchEvaluationResponse,
  type StartRecommendationResponse,
  type DataSourceConfig as DataPlaneDataSourceConfig,
  type CloudWatchFilterConfig,
} from "@aws-sdk/client-bedrock-agentcore";
import { ResourceNotFoundException, type ResultField } from "@aws-sdk/client-cloudwatch-logs";
import type { DocumentType } from "@smithy/types";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { Transform } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  FileWriteError,
  InputValidationError,
  NetworkingError,
  ResourceNotFoundError,
} from "../errors";
import {
  DEFAULT_ENDPOINT_QUALIFIER,
  INSIGHTS_MAX_ROWS,
  runInsightsQuery,
  runtimeLogGroup,
  sanitizeQueryValue,
  type InsightsRowLimit,
} from "./observability";
import { CloudWatchClient } from "./observability/index";
import type {
  BatchEvaluationDetail,
  CodeBasedUpdate,
  DatasetUpdateProgressEvent,
  DatasetUpdateResult,
  RoleScopeWarning,
  CoreEvalClient,
  CreateConfigurationBundleInput,
  CreateConfigBasedABTestInput,
  CreateTargetBasedABTestInput,
  CreateDatasetInput,
  CreateOnlineEvalInput,
  CreateOnlineInsightInput,
  CreateOnlineInsightResponse,
  UpdateOnlineInsightInput,
  GetOnlineInsightResponse,
  ListOnlineInsightsResponse,
  UpdateOnlineInsightResponse,
  DeleteOnlineInsightResponse,
  EvaluateInput,
  EvaluateResult,
  GetBatchEvaluationResult,
  GetTracesInput,
  LlmAsAJudgeUpdate,
  SessionSourceValue,
  SessionTrace,
  InvokeDatasetInput,
  InvokeDatasetResult,
  SpanRecord,
  StartBatchInsightsInput,
  StartBatchEvaluationInput,
  StartRecommendationInput,
  UpdateConfigurationBundleInput,
  UpdateOnlineEvalInput,
} from "../handlers/eval/types";
import { atomicWrite, atomicWriteStream, readTextFile } from "../io";
import { accountIdFromRuntimeArn, invokeRuntime } from "./invokeRuntime";
import { isFile } from "./dev/path";
import { DatasetLoader } from "./eval/invokeDataset/load";
import { runExamples } from "./eval/invokeDataset/run";
import { renderJsonTemplate } from "./eval/invokeDataset/template";
import type { RunContext } from "./eval/invokeDataset/example/types";
import { isTerminalStatus, readEvaluationResults } from "./batchEvaluationResults";
import { applyExampleIds, diffExamples, indexRemoteById, parseJsonl } from "./datasetDiff";
import type { Addition } from "./datasetDiff";
import type { AwsClients, CoreFetch, CoreOptions } from "./types";
import type { Logger } from "../logging";
import { FilteredPaginator } from "./filteredPaginator";
import { toClientConfig } from "./utils";
import {
  accountIdFromRoleArn,
  executionPolicy,
  grantOnlineEvalScope,
  isManagedOnlineEvalRole,
  revokeOnlineEvalScope,
  roleNameFromArn,
  scopePolicyName,
} from "./onlineEvalExecutionRole";
import { accountIdFromArn, deleteAbTestRole, provisionAbTestRole } from "./abTestExecutionRole";
import { harnessRuntimeFromResponse } from "./harness";

const DEFAULT_INGESTION_WAIT_MS = 180_000;
const DATASET_EXAMPLES_BATCH_LIMIT = 1000;
const DATASET_MUTATION_PAYLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
const DATASET_ACTIVE_TIMEOUT_MS = 60_000;
const DATASET_ACTIVE_POLL_MS = 2_000;
// Service permits modifications to following dataset statuses
const ALLOWED_DATASET_STATUSES: ReadonlySet<DatasetStatus> = new Set([
  "ACTIVE",
  "CREATE_FAILED",
  "UPDATE_FAILED",
]);
const RETRYABLE_DATASET_STATUSES: ReadonlySet<DatasetStatus> = new Set(["CREATING", "UPDATING"]);

// The shared, account-level OTel span log group.
const SPANS_LOG_GROUP = "aws/spans";

// Default discovery window when no explicit --start/--end or --lookback-days is
// given. Mirrors the batch service's now-7d default.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// A hard Evaluate limit: at most 10 trace/span ids per request.
const EVALUATE_TARGET_BATCH = 10;

// Eval's row-ceiling policy for the shared Insights runner: overflowing the
// CloudWatch hard ceiling means a partial conversation would be scored, so the
// remedy is eval-specific (narrow the session scope or go through batch).
const EVAL_INSIGHTS_ROW_LIMIT: InsightsRowLimit = {
  maxRows: INSIGHTS_MAX_ROWS,
  buildError: (maxRows) =>
    new InputValidationError(
      `Too many spans in scope (>= ${maxRows}). Narrow --session-ids or the time ` +
        `window, or use 'eval batch-evaluation' for large jobs.`,
    ),
};

const DEFAULT_BATCH_INSIGHTS_PAGE_SIZE = 50;
const BATCH_EVALUATION_RESULT_MAX_PAGES = 100;

// noopLogger is the default for the optional logger arg so callers that don't
// need batch-evaluation result-log diagnostics (e.g. dataset-only tests) can
// omit it. Production (src/core/index.tsx) injects a real child logger.
const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

const DEFAULT_ONLINE_INSIGHT_PAGE_SIZE = 100;

export class EvalClient implements CoreEvalClient {
  constructor(
    private readonly clients: AwsClients,
    // HTTP client for datasets presigned S3 URL
    private readonly fetch: CoreFetch = globalThis.fetch,
    // logger for batch-evaluation result-log diagnostics
    private readonly logger: Logger = noopLogger,
    private readonly newSessionId: () => string = randomUUID,
    private readonly now: () => number = () => Date.now(),
    private readonly cloudWatch: CloudWatchClient = new CloudWatchClient(clients),
  ) {}

  async createEvaluator(
    request: CreateEvaluatorRequest,
    options: CoreOptions,
  ): Promise<CreateEvaluatorResponse> {
    return this.clients.control(toClientConfig(options)).send(new CreateEvaluatorCommand(request));
  }

  // updateLlmAsAJudgeEvaluator rebuilds the full llmAsAJudge config from the
  // current evaluator, overlays the provided fields, and sends it. UpdateEvaluator
  // replaces the entire evaluatorConfig union, and the llmAsAJudge arm requires
  // instructions + ratingScale + modelConfig together, so a partial update would
  // otherwise drop the fields the caller didn't pass.
  async updateLlmAsAJudgeEvaluator(
    id: string,
    update: LlmAsAJudgeUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(new GetEvaluatorCommand({ evaluatorId: id }));

    // Reject a type mismatch before merging: UpdateEvaluator replaces the whole
    // evaluatorConfig union, so merging into the wrong arm would silently convert
    // a code-based evaluator into an LLM-as-a-Judge one.
    if (!current.evaluatorConfig || !("llmAsAJudge" in current.evaluatorConfig)) {
      throw new InputValidationError(`Evaluator "${id}" is not an LLM-as-a-Judge evaluator`, {
        meta: { evaluatorId: id },
      });
    }
    const existing = current.evaluatorConfig.llmAsAJudge;

    const instructions = update.instructions ?? existing?.instructions;
    const ratingScale = update.ratingScale ?? existing?.ratingScale;
    // Preserve the existing Bedrock model config (inferenceConfig,
    // additionalModelRequestFields, ...) and override only the model id, so an
    // update that touches other fields does not drop model tuning.
    const existingModel =
      existing?.modelConfig && "bedrockEvaluatorModelConfig" in existing.modelConfig
        ? existing.modelConfig.bedrockEvaluatorModelConfig
        : undefined;
    const modelId = update.model ?? existingModel?.modelId;

    if (!instructions || !ratingScale || !modelId) {
      throw new InputValidationError(
        `Evaluator "${id}" is missing configuration required to update it: ` +
          `instructions, rating scale, and model are all required`,
        { meta: { evaluatorId: id } },
      );
    }

    const evaluatorConfig: EvaluatorConfig = {
      llmAsAJudge: {
        instructions,
        ratingScale,
        modelConfig: { bedrockEvaluatorModelConfig: { ...existingModel, modelId } },
      },
    };

    return control.send(
      new UpdateEvaluatorCommand({
        evaluatorId: id,
        evaluatorConfig,
        kmsKeyArn: update.kmsKeyArn,
      }),
    );
  }

  // updateCodeBasedEvaluator mirrors updateLlmAsAJudgeEvaluator: it merges the
  // provided lambda ARN / timeout over the current codeBased config so unset
  // fields are preserved across the union-replacing UpdateEvaluator call.
  async updateCodeBasedEvaluator(
    id: string,
    update: CodeBasedUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(new GetEvaluatorCommand({ evaluatorId: id }));

    // Same union-replacement hazard as updateLlmAsAJudgeEvaluator: reject a type
    // mismatch instead of converting the evaluator to code-based.
    if (!current.evaluatorConfig || !("codeBased" in current.evaluatorConfig)) {
      throw new InputValidationError(`Evaluator "${id}" is not a code-based evaluator`, {
        meta: { evaluatorId: id },
      });
    }
    const existing = current.evaluatorConfig.codeBased;
    const existingLambda =
      existing && "lambdaConfig" in existing ? existing.lambdaConfig : undefined;

    const lambdaArn = update.lambdaArn ?? existingLambda?.lambdaArn;
    if (!lambdaArn) {
      throw new InputValidationError(
        `Evaluator "${id}" is missing configuration required to update it: a Lambda ARN is required`,
        { meta: { evaluatorId: id } },
      );
    }
    const lambdaTimeoutInSeconds = update.timeout ?? existingLambda?.lambdaTimeoutInSeconds;

    const evaluatorConfig: EvaluatorConfig = {
      codeBased: { lambdaConfig: { ...existingLambda, lambdaArn, lambdaTimeoutInSeconds } },
    };

    return control.send(
      new UpdateEvaluatorCommand({
        evaluatorId: id,
        evaluatorConfig,
        kmsKeyArn: update.kmsKeyArn,
      }),
    );
  }

  async getEvaluator(id: string, options: CoreOptions): Promise<GetEvaluatorResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetEvaluatorCommand({ evaluatorId: id }));
  }

  async listEvaluators(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListEvaluatorsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListEvaluatorsCommand({ nextToken, maxResults }));
  }

  async deleteEvaluator(id: string, options: CoreOptions): Promise<DeleteEvaluatorResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteEvaluatorCommand({ evaluatorId: id }));
  }

  async startRecommendation(
    input: StartRecommendationInput,
    options: CoreOptions,
  ): Promise<StartRecommendationResponse> {
    return this.clients.data(toClientConfig(options)).send(new StartRecommendationCommand(input));
  }

  async getRecommendation(id: string, options: CoreOptions): Promise<GetRecommendationResponse> {
    return this.clients
      .data(toClientConfig(options))
      .send(new GetRecommendationCommand({ recommendationId: id }));
  }

  async listRecommendations(
    nextToken: string | undefined,
    maxResults: number | undefined,
    statusFilter: RecommendationStatus | undefined,
    options: CoreOptions,
  ): Promise<ListRecommendationsResponse> {
    return this.clients
      .data(toClientConfig(options))
      .send(new ListRecommendationsCommand({ nextToken, maxResults, statusFilter }));
  }

  async deleteRecommendation(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteRecommendationResponse> {
    return this.clients
      .data(toClientConfig(options))
      .send(new DeleteRecommendationCommand({ recommendationId: id }));
  }

  // getBatchEvaluation returns the service-side job (status + evaluator summaries
  // + CloudWatch output config) and, by default, the per-session results read from
  // the job's CloudWatch stream once it is terminal. Batch evaluation lives on the
  // data plane, not control.
  //
  // Returns `{ detail, resultsError? }` rather than merging silently: a CloudWatch
  // read failure must never hide the job status, and Core has no stderr to warn on,
  // so it surfaces the error to the caller (the handler warns; the TUI ignores it).
  // `includeResults: false` (the CLI's --disable-cw-results) skips the CloudWatch
  // read entirely and returns metadata only.
  async getBatchEvaluation(
    id: string,
    options: CoreOptions,
    { includeResults = true }: { includeResults?: boolean } = {},
  ): Promise<GetBatchEvaluationResult> {
    const job = await this.clients
      .data(toClientConfig(options))
      .send(new GetBatchEvaluationCommand({ batchEvaluationId: id }));

    const detail: BatchEvaluationDetail = { ...job };
    const cw = job.outputConfig?.cloudWatchConfig;
    if (
      !includeResults ||
      !isTerminalStatus(job.status) ||
      !cw?.logGroupName ||
      !cw.logStreamName
    ) {
      return { detail };
    }

    try {
      detail.results = await readEvaluationResults(
        this.cloudWatch.readLogStream(
          {
            logGroupName: cw.logGroupName,
            logStreamName: cw.logStreamName,
          },
          {
            maxPages: BATCH_EVALUATION_RESULT_MAX_PAGES,
          },
          options,
        ),
        this.logger,
      );
      return { detail };
    } catch (resultsError) {
      // Return the metadata regardless — the caller decides how to surface the
      // CloudWatch failure (stderr warning in the CLI, ignored in the TUI).
      return { detail, resultsError };
    }
  }

  async getBatchInsights(id: string, options: CoreOptions): Promise<BatchEvaluationDetail> {
    const { detail } = await this.getBatchEvaluation(id, options, { includeResults: false });
    if (!EvalClient.isBatchInsights(detail)) {
      throw new InputValidationError(`batch evaluation "${id}" is not a batch insights run`);
    }
    return detail;
  }

  async listBatchEvaluations(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListBatchEvaluationsResponse> {
    return this.clients
      .data(toClientConfig(options))
      .send(new ListBatchEvaluationsCommand({ nextToken, maxResults }));
  }

  async getABTest(id: string, options: CoreOptions): Promise<GetABTestResponse> {
    return this.clients.data(toClientConfig(options)).send(new GetABTestCommand({ abTestId: id }));
  }

  async listABTests(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListABTestsResponse> {
    return this.clients
      .data(toClientConfig(options))
      .send(new ListABTestsCommand({ nextToken, maxResults }));
  }

  async setABTestExecutionStatus(
    id: string,
    executionStatus: ABTestExecutionStatus,
    options: CoreOptions,
  ): Promise<UpdateABTestResponse> {
    return this.clients
      .data(toClientConfig(options))
      .send(new UpdateABTestCommand({ abTestId: id, executionStatus }));
  }

  async deleteABTest(id: string, options: CoreOptions): Promise<DeleteABTestResponse> {
    return this.clients
      .data(toClientConfig(options))
      .send(new DeleteABTestCommand({ abTestId: id }));
  }

  private async createABTest(
    name: string,
    gateway: string,
    callerRoleArn: string | undefined,
    build: (context: {
      gatewayArn: string;
      accountId: string;
      roleArn: string;
    }) => CreateABTestRequest,
    options: CoreOptions,
  ): Promise<CreateABTestResponse> {
    const control = this.clients.control(toClientConfig(options));
    const gatewayArn = (await control.send(new GetGatewayCommand({ gatewayIdentifier: gateway })))
      .gatewayArn!;
    const accountId = accountIdFromArn(gatewayArn);

    let roleArn = callerRoleArn;
    let provisionedRoleArn: string | undefined;
    if (!roleArn) {
      const provisioned = await provisionAbTestRole(
        this.clients.iam({ region: options.region }),
        name,
        gatewayArn,
        options.region,
      );
      roleArn = provisioned.roleArn;
      if (provisioned.created) provisionedRoleArn = provisioned.roleArn;
    }

    const command = new CreateABTestCommand(build({ gatewayArn, accountId, roleArn }));
    try {
      return callerRoleArn
        ? await this.clients.data(toClientConfig(options)).send(command)
        : await retryWhileRolePropagates(() =>
            this.clients.data(toClientConfig(options)).send(command),
          );
    } catch (error) {
      if (provisionedRoleArn) {
        try {
          await deleteAbTestRole(this.clients.iam({ region: options.region }), provisionedRoleArn);
        } catch {
          void 0;
        }
      }
      throw error;
    }
  }

  async createConfigBasedABTest(
    input: CreateConfigBasedABTestInput,
    options: CoreOptions,
  ): Promise<CreateABTestResponse> {
    const treatmentWeight = input.treatmentWeight ?? 50;
    return this.createABTest(
      input.name,
      input.gateway,
      input.roleArn,
      ({ gatewayArn, accountId, roleArn }) => {
        const bundleArn = (id: string) =>
          `arn:aws:bedrock-agentcore:${options.region}:${accountId}:configuration-bundle/${id}`;
        return {
          name: input.name,
          gatewayArn,
          variants: [
            {
              name: "C",
              weight: 100 - treatmentWeight,
              variantConfiguration: {
                configurationBundle: {
                  bundleArn: bundleArn(input.control.configBundle),
                  bundleVersion: input.control.bundleVersion,
                },
              },
            },
            {
              name: "T1",
              weight: treatmentWeight,
              variantConfiguration: {
                configurationBundle: {
                  bundleArn: bundleArn(input.treatment.configBundle),
                  bundleVersion: input.treatment.bundleVersion,
                },
              },
            },
          ],
          evaluationConfig: {
            onlineEvaluationConfigArn: `arn:aws:bedrock-agentcore:${options.region}:${accountId}:online-evaluation-config/${input.onlineEval}`,
          },
          roleArn,
          gatewayFilter: input.gatewayFilter,
          enableOnCreate: input.enableOnCreate ?? true,
          clientToken: randomUUID(),
        };
      },
      options,
    );
  }

  async createTargetBasedABTest(
    input: CreateTargetBasedABTestInput,
    options: CoreOptions,
  ): Promise<CreateABTestResponse> {
    const treatmentWeight = input.treatmentWeight ?? 50;
    return this.createABTest(
      input.name,
      input.gateway,
      input.roleArn,
      ({ gatewayArn, accountId, roleArn }) => {
        const evalArn = (id: string) =>
          `arn:aws:bedrock-agentcore:${options.region}:${accountId}:online-evaluation-config/${id}`;
        return {
          name: input.name,
          gatewayArn,
          variants: [
            {
              name: "C",
              weight: 100 - treatmentWeight,
              variantConfiguration: { target: { name: input.control.gatewayTarget } },
            },
            {
              name: "T1",
              weight: treatmentWeight,
              variantConfiguration: { target: { name: input.treatment.gatewayTarget } },
            },
          ],
          evaluationConfig: {
            perVariantOnlineEvaluationConfig: [
              { name: "C", onlineEvaluationConfigArn: evalArn(input.control.onlineEval) },
              { name: "T1", onlineEvaluationConfigArn: evalArn(input.treatment.onlineEval) },
            ],
          },
          roleArn,
          gatewayFilter: input.gatewayFilter,
          enableOnCreate: input.enableOnCreate ?? true,
          clientToken: randomUUID(),
        };
      },
      options,
    );
  }

  async listBatchInsights(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListBatchEvaluationsResponse> {
    const page = await FilteredPaginator.paginate({
      fetchPage: async (token, size) => {
        const r = await this.listBatchEvaluations(token, size, options);
        return { items: r.batchEvaluations ?? [], nextToken: r.nextToken };
      },
      predicate: EvalClient.isBatchInsights,
      nextToken,
      maxResults,
      defaultPageSize: DEFAULT_BATCH_INSIGHTS_PAGE_SIZE,
      resourceLabel: "Batch Insights",
    });
    return { batchEvaluations: page.items, nextToken: page.nextToken };
  }

  async startBatchEvaluation(
    input: StartBatchEvaluationInput,
    options: CoreOptions,
  ): Promise<StartBatchEvaluationResponse> {
    const dataSourceConfig = await this.dataSourceConfigForSource(input.source, options);
    return this.clients.data(toClientConfig(options)).send(
      new StartBatchEvaluationCommand({
        batchEvaluationName: input.name,
        description: input.description,
        evaluators: input.evaluatorIds.map((evaluatorId) => ({ evaluatorId })),
        dataSourceConfig,
        evaluationMetadata: input.groundTruth ? { sessionMetadata: input.groundTruth } : undefined,
        kmsKeyArn: input.kmsKeyArn,
      }),
    );
  }

  async startBatchInsights(
    input: StartBatchInsightsInput,
    options: CoreOptions,
  ): Promise<StartBatchEvaluationResponse> {
    const dataSourceConfig = await this.dataSourceConfigForSource(input.source, options);
    return this.clients.data(toClientConfig(options)).send(
      new StartBatchEvaluationCommand({
        batchEvaluationName: input.name,
        description: input.description,
        insights: input.insightIds.map((insightId) => ({ insightId })),
        evaluators: input.evaluatorIds?.map((evaluatorId) => ({ evaluatorId })),
        dataSourceConfig,
        kmsKeyArn: input.kmsKeyArn,
      }),
    );
  }

  // dataSourceConfigForSource maps a resolved SessionSourceValue to the data-plane
  // dataSourceConfig union. The agent arm reuses the same runtime resolution +
  // log-group derivation the control-plane agentDataSource uses, then attaches the
  // session-id / time-range filters; the raw arm is returned verbatim.
  private async dataSourceConfigForSource(
    source: SessionSourceValue,
    options: CoreOptions,
  ): Promise<DataPlaneDataSourceConfig> {
    if (source.origin === "raw") return source.dataSourceConfig;

    const timeRange = source.window;

    if (source.origin === "online-eval") {
      return {
        onlineEvaluationConfigSource: {
          onlineEvaluationConfigArn: source.onlineEvaluationConfigId,
          timeRange,
        },
      };
    }

    const qualifier = source.endpoint ?? DEFAULT_ENDPOINT_QUALIFIER;
    const { runtimeId, runtimeName } = await resolveAgentToNameAndId(
      source.agent,
      this.clients,
      options,
    );
    const filterConfig: CloudWatchFilterConfig | undefined =
      source.sessionIds || timeRange ? { sessionIds: source.sessionIds, timeRange } : undefined;
    return {
      cloudWatchLogs: {
        logGroupNames: [runtimeLogGroup(runtimeId, qualifier)],
        serviceNames: [runtimeServiceName(runtimeName, qualifier)],
        filterConfig,
      },
    };
  }

  private static isBatchInsights(job: { insights?: unknown[] }): boolean {
    return Boolean(job.insights?.length);
  }

  async getTracesForAgent(input: GetTracesInput, options: CoreOptions): Promise<SessionTrace[]> {
    const qualifier = input.endpoint ?? DEFAULT_ENDPOINT_QUALIFIER;

    const { runtimeId, runtimeName } = await resolveAgentToNameAndId(
      input.agent,
      this.clients,
      options,
    );
    const logGroupName = runtimeLogGroup(runtimeId, qualifier);
    const serviceName = runtimeServiceName(runtimeName, qualifier);

    const endMs = input.window ? +input.window.endTime : this.now();
    const startMs = input.window ? +input.window.startTime : endMs - SEVEN_DAYS_MS;
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);

    const logs = this.clients.logs(toClientConfig(options));
    const queryString = buildSpanQuery(serviceName, input.sessionIds, input.traceId);

    // Runtime group required (missing = agent has no traces); aws/spans optional now
    // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html#observability-configure-unified-traces
    const [runtimeRows, sharedRows] = await Promise.all([
      runInsightsQuery(
        logs,
        [logGroupName],
        queryString,
        startSec,
        endSec,
        EVAL_INSIGHTS_ROW_LIMIT,
      ).catch((error) => {
        if (error instanceof ResourceNotFoundException) {
          throw new ResourceNotFoundError(
            `No telemetry found for agent "${input.agent}": its runtime log group ${logGroupName} ` +
              `does not exist. Ensure the agent has been invoked and emits traces.`,
            { cause: error, meta: { agent: input.agent, logGroupName } },
          );
        }
        throw error;
      }),
      runInsightsQuery(
        logs,
        [SPANS_LOG_GROUP],
        queryString,
        startSec,
        endSec,
        EVAL_INSIGHTS_ROW_LIMIT,
      ).catch((error) => {
        if (error instanceof ResourceNotFoundException) return [];
        throw error;
      }),
    ]);
    const traces = groupSpansBySession([...sharedRows, ...runtimeRows], this.logger);

    // Warn when explicitly requested sessions never showed up in the logs (aged
    // out, wrong id, or never emitted) so a caller isn't misled by a partial run.
    if (input.sessionIds?.length) {
      const found = new Set(traces.map((t) => t.sessionId));
      const missing = input.sessionIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        this.logger.warn(`requested sessions not found in logs: ${missing.join(", ")}`);
      }
    }
    return traces;
  }

  async evaluate(input: EvaluateInput, options: CoreOptions): Promise<EvaluateResult> {
    const data = this.clients.data(toClientConfig(options));
    const control = this.clients.control(toClientConfig(options));
    const levels = await resolveEvaluatorLevels(input.evaluatorIds, control, options);
    const refsBySession = groupRefsBySession(input.groundTruth);

    const results: EvaluationResultContent[] = [];
    // Sessions that actually produced Evaluate results — distinct from the sessions
    // handed in, since a TRACE/TOOL_CALL session with no matching ids makes no call.
    const evaluatedSessions = new Set<string>();
    for (const evaluatorId of input.evaluatorIds) {
      const level = levels.get(evaluatorId) ?? "SESSION";
      for (const trace of input.traces) {
        // TRACE/TOOL_CALL sessions with no ids at that level contribute no calls
        // (empty batch list); SESSION always makes one call with no target.
        for (const target of targetBatches(level, trace)) {
          const response = await data.send(
            new EvaluateCommand({
              evaluatorId,
              // SpanRecord is Record<string, unknown> for ergonomic reads; the API
              // wants DocumentType[] (assignable to it, so a single cast suffices).
              evaluationInput: { sessionSpans: trace.spans as DocumentType[] },
              evaluationTarget: target,
              evaluationReferenceInputs: refsBySession.get(trace.sessionId),
            }),
          );
          const evaluationResults = response.evaluationResults ?? [];
          if (evaluationResults.length > 0) evaluatedSessions.add(trace.sessionId);
          results.push(...evaluationResults);
        }
      }
    }
    return {
      sessionsRequested: input.traces.length,
      sessionsEvaluated: evaluatedSessions.size,
      results,
    };
  }

  async invokeDataset(
    input: InvokeDatasetInput,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InvokeDatasetResult> {
    // A template with no {input} sends the same payload for every turn, ignoring the
    // scenario — always a mistake. Fail before reading the dataset or invoking anything.
    if (!input.payloadTemplate.includes("{input}")) {
      throw new InputValidationError("--payload-template must contain the {input} placeholder");
    }
    const examples = DatasetLoader.load(
      await this.readDatasetText(input.dataset, input.datasetVersion, options, signal),
    );

    // Resolve the runtime once, reused for every session.
    const runtime = await this.clients
      .control(toClientConfig(options))
      .send(new GetAgentRuntimeCommand({ agentRuntimeId: input.runtimeId }), {
        abortSignal: signal,
      });
    const deps = { clients: this.clients, fetch: this.fetch, logger: this.logger };
    const accountId = accountIdFromRuntimeArn(runtime.agentRuntimeArn);

    const { ok, failures } = await runExamples(examples, async (example) => {
      // One session per example; the id is a client-owned input per the AgentCore docs,
      // reused across turns so the conversation and its per-turn traces stay in order.
      const sessionId = this.newSessionId();
      const ctx: RunContext = {
        invokeOnce: async (payload) => {
          const response = await invokeRuntime(
            deps,
            {
              runtimeId: input.runtimeId,
              accountId,
              qualifier: input.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER,
              payload: renderJsonTemplate(input.payloadTemplate, { input: payload }),
              contentType: "application/json",
              accept: "application/json",
              ...(input.headers?.length ? { applicationHeaders: input.headers } : {}),
              ...(input.bearerToken !== undefined ? { bearerToken: input.bearerToken } : {}),
              runtimeSessionId: sessionId,
              runtimeUserId: input.userId,
            },
            options,
            signal,
          );
          // Read to completion to free the socket; a scripted example ignores the text.
          let text = "";
          const decoder = new TextDecoder();
          for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true });
          text += decoder.decode();
          return { text };
        },
      };
      const groundTruth = await example.run(ctx);
      return { exampleId: example.exampleId, sessionId, groundTruth };
    });

    const invokeFailures = failures.map((f) => ({
      exampleId: f.item.exampleId,
      error: f.error.message,
    }));
    if (invokeFailures.length > 0) {
      this.logger.warn(
        `invokeDataset: ${invokeFailures.length} example(s) failed to invoke and were dropped` +
          `; first: ${invokeFailures[0]!.exampleId} — ${invokeFailures[0]!.error}`,
      );
    }

    const waitMs = input.waitIngestionMs ?? DEFAULT_INGESTION_WAIT_MS;
    if (ok.length > 0 && waitMs > 0) {
      this.logger.info(
        `waiting ${Math.round(waitMs / 1000)}s for span ingestion before evaluating`,
      );
      await sleep(waitMs, undefined, { signal });
    }

    return {
      sessions: ok,
      invoked: ok.length,
      failed: invokeFailures.length,
      failures: invokeFailures,
    };
  }

  // Resolve a dataset ref to JSONL text: a local path directly, else download the id to a
  // temp file (cleaned up here). Reuses readLocalDatasetFile so replay reads like update.
  private async readDatasetText(
    ref: string,
    version: string | undefined,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    if (isFile(ref)) return readLocalDatasetFile(ref, signal);
    const path = await this.downloadDatasetToTemp(ref, version, options, signal);
    try {
      return await readLocalDatasetFile(path, signal);
    } finally {
      await unlink(path).catch(() => {});
    }
  }

  // downloadDatasetToTemp streams a dataset version's JSONL to a temp file so
  // readDatasetText can read it — reuses downloadDataset rather than re-fetching.
  private async downloadDatasetToTemp(
    id: string,
    version: string | undefined,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const path = join(tmpdir(), `agentcore-dataset-${randomUUID()}.jsonl`);
    await this.downloadDataset(id, version, path, options, signal);
    return path;
  }

  async createOnlineEvaluationConfig(
    input: CreateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<CreateOnlineEvaluationConfigResponse> {
    // `--agent` derives the CloudWatch source from the agent's default trace
    // path; an explicit dataSourceConfig passes straight through, which is how an
    // agent emitting under a custom OTel service name is pointed at its log groups.
    const dataSourceConfig =
      input.agent !== undefined
        ? await agentDataSource(input.agent, input.endpoint, this.clients, options)
        : input.dataSourceConfig;
    const control = this.clients.control(toClientConfig(options));

    // The service validates at create time that the role can query the log groups
    // it was pointed at, and the required policy is not obvious, so provision a
    // default role scoped to them unless the caller brought their own.
    const evaluationExecutionRoleArn =
      input.evaluationExecutionRoleArn ??
      (
        await grantOnlineEvalScope(
          // IAM is a global service; the region only selects the endpoint, and the
          // agentcore endpoint override must not leak onto it.
          this.clients.iam({ region: options.region }),
          input.name,
          options.region,
          logGroupNamesOf(dataSourceConfig),
          await evaluatorKmsKeys(input.evaluatorIds ?? [], control),
        )
      ).roleArn;

    const command = new CreateOnlineEvaluationConfigCommand({
      onlineEvaluationConfigName: input.name,
      description: input.description,
      rule: toRule(input.samplingRate, input.sessionTimeoutMinutes, input.filters),
      dataSourceConfig,
      evaluators: input.evaluatorIds?.map((evaluatorId) => ({ evaluatorId })),
      evaluationExecutionRoleArn,
      enableOnCreate: input.enableOnCreate ?? true,
    });

    // A role provisioned moments ago may not be assumable yet (IAM is eventually
    // consistent), and the service rejects the create rather than retrying. Only
    // worth retrying when we just created the role; a caller-supplied one that
    // cannot be assumed is a real misconfiguration and fails immediately.
    return input.evaluationExecutionRoleArn
      ? control.send(command)
      : retryWhileRolePropagates(() => control.send(command));
  }

  async createOnlineInsight(
    input: CreateOnlineInsightInput,
    options: CoreOptions,
  ): Promise<CreateOnlineInsightResponse> {
    const dataSourceConfig =
      input.agent !== undefined
        ? await agentDataSource(input.agent, input.endpoint, this.clients, options)
        : input.dataSourceConfig;
    const control = this.clients.control(toClientConfig(options));

    const command = new CreateOnlineEvaluationConfigCommand({
      onlineEvaluationConfigName: input.name,
      description: input.description,
      rule: toRule(input.samplingRate, input.sessionTimeoutMinutes, input.filters),
      dataSourceConfig,
      insights: input.insightIds.map((insightId) => ({ insightId })),
      clusteringConfig: input.clusteringConfig,
      evaluationExecutionRoleArn: input.evaluationExecutionRoleArn,
      enableOnCreate: input.enableOnCreate ?? true,
    });

    return control.send(command);
  }

  async updateOnlineInsight(
    id: string,
    update: UpdateOnlineInsightInput,
    options: CoreOptions,
  ): Promise<UpdateOnlineInsightResponse> {
    const control = this.clients.control(toClientConfig(options));
    // This GET is both the merge base (UpdateOnlineEvaluationConfig replaces the
    // whole rule/insights, so unset fields must be carried over) and the guard
    // that rejects a plain online-EVAL config, which carries no insights.
    const current = await control.send(
      new GetOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id }),
    );
    if ((current.insights?.length ?? 0) === 0)
      throw new InputValidationError(`"${id}" is not an online-insight config`, {
        meta: { onlineEvaluationConfigId: id },
      });

    const samplingPercentage =
      update.samplingRate ?? current.rule?.samplingConfig?.samplingPercentage;
    const sessionTimeoutMinutes =
      update.sessionTimeoutMinutes ?? current.rule?.sessionConfig?.sessionTimeoutMinutes;
    const filters = update.filters ?? current.rule?.filters;

    const insights =
      update.insightIds !== undefined
        ? update.insightIds.map((insightId) => ({ insightId }))
        : current.insights;
    const clusteringConfig = update.clusteringConfig ?? current.clusteringConfig;

    let dataSourceConfig = current.dataSourceConfig;
    if (update.dataSourceConfig !== undefined) {
      dataSourceConfig = update.dataSourceConfig;
    } else if (update.agent !== undefined) {
      dataSourceConfig = await agentDataSource(
        update.agent,
        update.clearEndpoint ? DEFAULT_ENDPOINT_QUALIFIER : update.endpoint,
        this.clients,
        options,
      );
    } else if (update.clearEndpoint || update.endpoint !== undefined) {
      const currentLogGroup =
        current.dataSourceConfig && "cloudWatchLogs" in current.dataSourceConfig
          ? current.dataSourceConfig.cloudWatchLogs?.logGroupNames?.[0]
          : undefined;
      const runtimeId = currentLogGroup ? runtimeIdFromLogGroup(currentLogGroup) : undefined;
      if (!runtimeId) {
        throw new InputValidationError(
          `Online insight config "${id}" was not created from an agent; ` +
            `pass --agent or --data-source-config to repoint it`,
          { meta: { onlineEvaluationConfigId: id } },
        );
      }
      const endpoint = update.clearEndpoint ? DEFAULT_ENDPOINT_QUALIFIER : update.endpoint;
      dataSourceConfig = await agentDataSource(runtimeId, endpoint, this.clients, options);
    }

    return control.send(
      new UpdateOnlineEvaluationConfigCommand({
        onlineEvaluationConfigId: id,
        rule: toRule(samplingPercentage, sessionTimeoutMinutes, filters),
        dataSourceConfig,
        insights,
        clusteringConfig,
        evaluationExecutionRoleArn: update.evaluationExecutionRoleArn,
      }),
    );
  }

  async getOnlineInsight(id: string, options: CoreOptions): Promise<GetOnlineInsightResponse> {
    const control = this.clients.control(toClientConfig(options));
    const config = await control.send(
      new GetOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id }),
    );
    if ((config.insights?.length ?? 0) === 0)
      throw new InputValidationError(`"${id}" is not an online-insight config`, {
        meta: { onlineEvaluationConfigId: id },
      });
    return config;
  }

  async listOnlineInsights(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOnlineInsightsResponse> {
    const page = await FilteredPaginator.paginate({
      fetchPage: async (token, size) => {
        const r = await this.listOnlineEvaluationConfigs(token, size, options);
        return { items: r.onlineEvaluationConfigs ?? [], nextToken: r.nextToken };
      },
      predicate: (c) => (c.insights?.length ?? 0) > 0,
      nextToken,
      maxResults,
      defaultPageSize: DEFAULT_ONLINE_INSIGHT_PAGE_SIZE,
      resourceLabel: "Online insight",
    });
    return { onlineEvaluationConfigs: page.items, nextToken: page.nextToken };
  }

  async setOnlineInsightExecutionStatus(
    id: string,
    executionStatus: "ENABLED" | "DISABLED",
    options: CoreOptions,
  ): Promise<UpdateOnlineInsightResponse> {
    const config = await this.clients
      .control(toClientConfig(options))
      .send(new GetOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id }));
    if ((config.insights?.length ?? 0) === 0)
      throw new InputValidationError(`"${id}" is not an online-insight config`, {
        meta: { onlineEvaluationConfigId: id },
      });
    return this.setOnlineEvaluationExecutionStatus(id, executionStatus, options);
  }

  async deleteOnlineInsight(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteOnlineInsightResponse> {
    const config = await this.clients
      .control(toClientConfig(options))
      .send(new GetOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id }));
    if ((config.insights?.length ?? 0) === 0)
      throw new InputValidationError(`"${id}" is not an online-insight config`, {
        meta: { onlineEvaluationConfigId: id },
      });
    return this.deleteOnlineEvaluationConfig(id, options);
  }

  // updateOnlineEvaluationConfig fetches the current config and merges the
  // provided fields over it, because UpdateOnlineEvaluationConfig replaces the
  // whole `rule` (and, when endpoint changes, `dataSourceConfig`) rather than
  // patching individual fields.
  async updateOnlineEvaluationConfig(
    id: string,
    update: UpdateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<{
    response: UpdateOnlineEvaluationConfigResponse;
    roleScopeWarning?: RoleScopeWarning;
  }> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(
      new GetOnlineEvaluationConfigCommand({
        onlineEvaluationConfigId: id,
      }),
    );

    const samplingPercentage =
      update.samplingRate ?? current.rule?.samplingConfig?.samplingPercentage;
    const sessionTimeoutMinutes =
      update.sessionTimeoutMinutes ?? current.rule?.sessionConfig?.sessionTimeoutMinutes;
    const filters = update.filters ?? current.rule?.filters;

    const evaluators =
      update.evaluatorIds !== undefined
        ? update.evaluatorIds.map((evaluatorId) => ({ evaluatorId }))
        : current.evaluators;

    // Repointing the evaluation, in precedence order: an explicit
    // dataSourceConfig replaces the source outright; --agent re-derives it from
    // that agent; --endpoint/--clear-endpoint alone re-scope the agent this config
    // was already built from, which means recovering its runtime id first.
    let dataSourceConfig = current.dataSourceConfig;
    if (update.dataSourceConfig !== undefined) {
      dataSourceConfig = update.dataSourceConfig;
    } else if (update.agent !== undefined) {
      dataSourceConfig = await agentDataSource(
        update.agent,
        update.clearEndpoint ? DEFAULT_ENDPOINT_QUALIFIER : update.endpoint,
        this.clients,
        options,
      );
    } else if (update.clearEndpoint || update.endpoint !== undefined) {
      // The runtime id only survives inside the stored log group path, so an
      // endpoint change has to recover it from there.
      const currentLogGroup =
        current.dataSourceConfig && "cloudWatchLogs" in current.dataSourceConfig
          ? current.dataSourceConfig.cloudWatchLogs?.logGroupNames?.[0]
          : undefined;
      const runtimeId = currentLogGroup ? runtimeIdFromLogGroup(currentLogGroup) : undefined;
      if (!runtimeId) {
        throw new InputValidationError(
          `Online evaluation config "${id}" was not created from an agent; ` +
            `pass --agent or --data-source-config to repoint it`,
          { meta: { onlineEvaluationConfigId: id } },
        );
      }
      const endpoint = update.clearEndpoint ? DEFAULT_ENDPOINT_QUALIFIER : update.endpoint;
      dataSourceConfig = await agentDataSource(runtimeId, endpoint, this.clients, options);
    }

    // Moving the data source invalidates the execution role's scope: its policy
    // grants query access to the previous log groups only. A role the caller named
    // via --role-arn is theirs to manage and is never edited; a CLI-provisioned one
    // (identified by its derived name) is re-scoped unless the caller declines.
    // Either way, skipping the refresh is reported so the caller can be told.
    let roleScopeWarning: RoleScopeWarning | undefined;
    const movedTo =
      dataSourceConfig !== undefined && dataSourceConfig !== current.dataSourceConfig
        ? dataSourceConfig
        : undefined;

    const configName = current.onlineEvaluationConfigName;
    const roleArn = update.evaluationExecutionRoleArn ?? current.evaluationExecutionRoleArn;
    const managedRoleName =
      configName !== undefined &&
      update.evaluationExecutionRoleArn === undefined &&
      roleArn !== undefined &&
      isManagedOnlineEvalRole(roleArn, configName)
        ? configName
        : undefined;
    const refreshManagedRole = movedTo !== undefined && managedRoleName !== undefined;

    if (movedTo !== undefined && managedRoleName === undefined && roleArn) {
      roleScopeWarning = {
        reason: "custom-role",
        roleArn,
        logGroupNames: logGroupNamesOf(movedTo),
      };
    } else if (movedTo !== undefined && !refreshManagedRole && roleArn) {
      // managed role, but the caller declined the refresh
      roleScopeWarning = {
        reason: "update-declined",
        roleArn,
        logGroupNames: logGroupNamesOf(movedTo),
      };
    }

    if (refreshManagedRole && update.updateRole !== false) {
      const iam = this.clients.iam({ region: options.region });
      const newLogGroups = logGroupNamesOf(movedTo);
      const oldLogGroups = current.dataSourceConfig
        ? logGroupNamesOf(current.dataSourceConfig)
        : [];
      // The evaluator list may have changed alongside the data source, so
      // re-resolve the keys rather than reusing the ones from create.
      const kmsKeys = await evaluatorKmsKeys(
        update.evaluatorIds ??
          (current.evaluators ?? [])
            .map((e) => ("evaluatorId" in e ? e.evaluatorId : undefined))
            .filter((id): id is string => id !== undefined),
        control,
      );

      // Grant the new scope as its own inline policy before the update, then
      // revoke the superseded one only once the update has landed. IAM unions
      // Allows across a role's inline policies, so both scopes are granted in
      // between — and because each scope is a separate policy, a failed update
      // leaves the one backing the current data source exactly as it was.
      const { roleArn: managedRoleArn, policyName: newPolicyName } = await grantOnlineEvalScope(
        iam,
        managedRoleName,
        options.region,
        newLogGroups,
        kmsKeys,
        roleNameFromArn(roleArn!),
      );
      const oldPolicyName = scopePolicyName(
        executionPolicy(
          options.region,
          accountIdFromRoleArn(managedRoleArn),
          oldLogGroups,
          kmsKeys,
        ),
      );

      const response = await control.send(
        new UpdateOnlineEvaluationConfigCommand({
          onlineEvaluationConfigId: id,
          rule: toRule(samplingPercentage, sessionTimeoutMinutes, filters),
          dataSourceConfig,
          evaluators,
        }),
      );

      if (newPolicyName !== oldPolicyName) {
        const revoked = await revokeOnlineEvalScope(
          iam,
          roleNameFromArn(managedRoleArn),
          oldPolicyName,
        ).catch(() => false);
        // The config is already correct; the role just still grants a data
        // source it no longer uses, either because the delete failed or because
        // the policy was written under a legacy name this build cannot derive.
        if (!revoked) {
          roleScopeWarning = {
            reason: "stale-scope",
            roleArn: roleArn!,
            logGroupNames: oldLogGroups,
          };
        }
      }
      return { response, roleScopeWarning };
    }

    const response = await control.send(
      new UpdateOnlineEvaluationConfigCommand({
        onlineEvaluationConfigId: id,
        rule: toRule(samplingPercentage, sessionTimeoutMinutes, filters),
        dataSourceConfig,
        evaluators,
        evaluationExecutionRoleArn: update.evaluationExecutionRoleArn,
      }),
    );
    return { response, roleScopeWarning };
  }

  async getOnlineEvaluationConfig(
    id: string,
    options: CoreOptions,
  ): Promise<GetOnlineEvaluationConfigResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id }));
  }

  async listOnlineEvaluationConfigs(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOnlineEvaluationConfigsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListOnlineEvaluationConfigsCommand({ nextToken, maxResults }));
  }

  async setOnlineEvaluationExecutionStatus(
    id: string,
    executionStatus: "ENABLED" | "DISABLED",
    options: CoreOptions,
  ): Promise<UpdateOnlineEvaluationConfigResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(
        new UpdateOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id, executionStatus }),
      );
  }

  async deleteOnlineEvaluationConfig(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteOnlineEvaluationConfigResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id }));
  }

  async createConfigurationBundle(
    input: CreateConfigurationBundleInput,
    options: CoreOptions,
  ): Promise<CreateConfigurationBundleResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreateConfigurationBundleCommand(input));
  }

  async getConfigurationBundle(
    id: string,
    version: string | undefined,
    branchName: string,
    options: CoreOptions,
  ): Promise<GetConfigurationBundleResponse | GetConfigurationBundleVersionResponse> {
    const control = this.clients.control(toClientConfig(options));
    return version === undefined
      ? control.send(new GetConfigurationBundleCommand({ bundleId: id, branchName }))
      : control.send(
          new GetConfigurationBundleVersionCommand({ bundleId: id, versionId: version }),
        );
  }

  async listConfigurationBundles(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListConfigurationBundlesResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListConfigurationBundlesCommand({ nextToken, maxResults }));
  }

  async updateConfigurationBundle(
    id: string,
    update: UpdateConfigurationBundleInput,
    options: CoreOptions,
  ): Promise<UpdateConfigurationBundleResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(
      new GetConfigurationBundleCommand({ bundleId: id, branchName: update.branchName }),
    );
    if (!current.versionId) {
      throw new NetworkingError(
        `Configuration bundle "${id}" returned no latest version and cannot be updated`,
        { meta: { bundleId: id } },
      );
    }

    return control.send(
      new UpdateConfigurationBundleCommand({
        bundleId: id,
        branchName: update.branchName,
        components: update.components,
        commitMessage: update.commitMessage,
        kmsKeyArn: update.kmsKeyArn,
        parentVersionIds: [current.versionId],
      }),
    );
  }

  async deleteConfigurationBundle(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteConfigurationBundleResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteConfigurationBundleCommand({ bundleId: id }));
  }

  async listConfigurationBundleVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListConfigurationBundleVersionsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListConfigurationBundleVersionsCommand({ bundleId: id, nextToken, maxResults }));
  }

  async createDataset(
    input: CreateDatasetInput,
    options: CoreOptions,
  ): Promise<CreateDatasetResponse> {
    return this.clients.control(toClientConfig(options)).send(new CreateDatasetCommand(input));
  }

  async getDataset(
    id: string,
    version: string | undefined,
    options: CoreOptions,
  ): Promise<GetDatasetResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetDatasetCommand({ datasetId: id, datasetVersion: version }));
  }

  // downloadDataset resolves the version's presigned URL and streams it to disk.
  // The body is streamed to a temporary file and renamed into place
  async downloadDataset(
    id: string,
    version: string | undefined,
    filePath: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetDatasetResponse> {
    const dataset = await this.getDataset(id, version, options);

    // The consolidated file is written asynchronously, so a dataset that is still
    // ingesting has no URL to offer yet. Report the status, which is what tells
    // the caller whether to retry.
    if (!dataset.downloadUrl) {
      throw new NetworkingError(
        `Dataset "${id}" has no downloadable content yet (status ${dataset.status ?? "unknown"}); ` +
          `retry once it reports ACTIVE`,
        { meta: { datasetId: id, datasetVersion: dataset.datasetVersion, status: dataset.status } },
      );
    }

    const response = await this.fetchDatasetDownload(id, dataset.downloadUrl, signal);
    if (!response.body) {
      throw new NetworkingError(`Dataset "${id}" download returned an empty response`, {
        meta: { datasetId: id },
      });
    }

    try {
      await atomicWriteStream(filePath, response.body, {
        signal,
        transforms: [endWithNewline()],
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new FileWriteError(`Could not write dataset "${id}" to ${filePath}`, {
        cause: error,
        meta: { datasetId: id, filePath },
      });
    }
    return dataset;
  }

  async listDatasets(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListDatasetsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListDatasetsCommand({ nextToken, maxResults }));
  }

  async deleteDataset(
    id: string,
    version: string | undefined,
    options: CoreOptions,
  ): Promise<DeleteDatasetResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteDatasetCommand({ datasetId: id, datasetVersion: version }));
  }

  async publishDataset(id: string, options: CoreOptions): Promise<CreateDatasetVersionResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreateDatasetVersionCommand({ datasetId: id }));
  }

  async updateDatasetExamples(
    id: string,
    filePath: string,
    options: CoreOptions,
    signal?: AbortSignal,
    onProgress?: (event: DatasetUpdateProgressEvent) => void,
  ): Promise<DatasetUpdateResult> {
    const control = this.clients.control(toClientConfig(options));
    const localText = await readLocalDatasetFile(filePath, signal);
    const localExamples = parseJsonl(localText, "file-path");

    const dataset = await control.send(new GetDatasetCommand({ datasetId: id }), {
      abortSignal: signal,
    });
    const remoteText = await this.downloadDatasetDraftForDiff(id, dataset, signal);
    const remoteExamples = parseRemoteDatasetExamples(remoteText);
    const diff = diffExamples(localExamples, indexRemoteById(remoteExamples));

    // Build every batch before mutating the remote draft so an oversized
    // individual example cannot fail after earlier phases have already run.
    const deleteBatches = buildDatasetExampleBatches({
      items: diff.deleteIds,
      payloadItem: (exampleId) => exampleId,
      requestBody: (exampleIds, clientToken) => ({ datasetId: id, exampleIds, clientToken }),
    });
    const updateBatches = buildDatasetExampleBatches({
      items: diff.updates,
      payloadItem: (example) => example,
      requestBody: (examples, clientToken) => ({ datasetId: id, examples, clientToken }),
    });
    const additionBatches = buildDatasetExampleBatches({
      items: diff.additions,
      payloadItem: (addition) => addition.content,
      requestBody: (examples, clientToken) => ({
        datasetId: id,
        source: { inlineExamples: { examples } },
        clientToken,
      }),
    });
    const totalBatches = deleteBatches.length + updateBatches.length + additionBatches.length;
    let nextBatch = 0;
    const reportProgress = onProgress
      ? () => {
          nextBatch++;
          onProgress({
            message: `Applying update (batch ${nextBatch} of ${totalBatches})...`,
          });
        }
      : undefined;

    await runDatasetExampleBatches({
      batches: deleteBatches,
      datasetId: id,
      control,
      signal,
      onBatchStart: reportProgress,
      operation: (exampleIds, clientToken) =>
        control.send(new DeleteDatasetExamplesCommand({ datasetId: id, exampleIds, clientToken }), {
          abortSignal: signal,
        }),
    });

    await runDatasetExampleBatches({
      batches: updateBatches,
      datasetId: id,
      control,
      signal,
      onBatchStart: reportProgress,
      operation: (examples, clientToken) =>
        control.send(new UpdateDatasetExamplesCommand({ datasetId: id, examples, clientToken }), {
          abortSignal: signal,
        }),
    });

    const completedAdditions: Addition[] = [];
    const assignedIds: string[] = [];
    let expectedLocalText = localText;
    let checkpointConflict: InputValidationError | undefined;
    await runDatasetExampleBatches({
      batches: additionBatches,
      datasetId: id,
      control,
      signal,
      onBatchStart: reportProgress,
      operation: (additions, clientToken) =>
        control.send(
          new AddDatasetExamplesCommand({
            datasetId: id,
            source: {
              inlineExamples: { examples: additions.map((addition) => addition.content) },
            },
            clientToken,
          }),
          { abortSignal: signal },
        ),
      afterOperation: async (additions, response: AddDatasetExamplesResponse): Promise<void> => {
        completedAdditions.push(...additions);
        assignedIds.push(...(response.exampleIds ?? []));
        const nextLocalText = applyExampleIds(localExamples, completedAdditions, assignedIds);

        const currentLocalText = await readTextFile(filePath);
        if (currentLocalText !== expectedLocalText) {
          const recoveryFilePath = datasetRecoveryFilePath(filePath);
          try {
            await atomicWrite(recoveryFilePath, nextLocalText);
          } catch (error) {
            throw new FileWriteError(
              `Dataset "${id}" changed while the update was running and its recovered IDs ` +
                `could not be written to ${recoveryFilePath}`,
              {
                cause: error,
                meta: { datasetId: id, filePath, recoveryFilePath },
              },
            );
          }
          checkpointConflict = new InputValidationError(
            `Dataset file "${filePath}" changed while the update was running. ` +
              `The file was left untouched and the reconciled content was written to ` +
              `"${recoveryFilePath}".`,
            { meta: { datasetId: id, filePath, recoveryFilePath } },
          );
          return;
        }

        try {
          // The remote request has already succeeded, so checkpoint its IDs even
          // if cancellation arrives before the next poll or batch.
          await atomicWrite(filePath, nextLocalText);
          expectedLocalText = nextLocalText;
        } catch (error) {
          throw new FileWriteError(`Could not write dataset "${id}" to ${filePath}`, {
            cause: error,
            meta: { datasetId: id, filePath },
          });
        }
      },
      afterBatchSettled: async (): Promise<void> => {
        if (checkpointConflict) throw checkpointConflict;
      },
    });

    return {
      datasetId: id,
      added: diff.additions.length,
      updated: diff.updates.length,
      deleted: diff.deleteIds.length,
      unchanged: diff.unchanged,
    };
  }

  private async downloadDatasetDraftForDiff(
    id: string,
    dataset: GetDatasetResponse,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!dataset.status || !ALLOWED_DATASET_STATUSES.has(dataset.status)) {
      const status = dataset.status ?? "unknown";
      const retry =
        dataset.status && RETRYABLE_DATASET_STATUSES.has(dataset.status)
          ? " Retry once its status is ACTIVE."
          : "";
      throw new NetworkingError(
        `Dataset "${id}" cannot be updated with status ${status}.${retry}`,
        { meta: { datasetId: id, datasetVersion: dataset.datasetVersion, status: dataset.status } },
      );
    }
    if (!dataset.downloadUrl) {
      if (dataset.exampleCount === 0) return "";
      throw new NetworkingError(
        `Dataset "${id}" has no downloadable DRAFT content yet (status ${dataset.status ?? "unknown"}); ` +
          `retry once DRAFT content is available`,
        { meta: { datasetId: id, datasetVersion: dataset.datasetVersion, status: dataset.status } },
      );
    }

    return this.fetchDatasetDownload(id, dataset.downloadUrl, signal).then((response) =>
      response.text(),
    );
  }

  private async fetchDatasetDownload(
    id: string,
    downloadUrl: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(downloadUrl, { signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    }
    if (!response.ok) {
      throw new NetworkingError(`Downloading dataset "${id}" failed with HTTP ${response.status}`, {
        meta: { datasetId: id, status: response.status },
      });
    }
    return response;
  }
}

async function readLocalDatasetFile(filePath: string, signal?: AbortSignal): Promise<string> {
  try {
    return await readTextFile(filePath, { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new InputValidationError(`could not read '--file-path' from file '${filePath}'`, {
      cause: error,
      meta: { filePath },
    });
  }
}

function datasetRecoveryFilePath(filePath: string): string {
  const extension = extname(filePath);
  const stem = basename(filePath, extension);
  return join(
    dirname(filePath),
    `${stem}.agentcore-recovery-${randomUUID()}${extension || ".jsonl"}`,
  );
}

function parseRemoteDatasetExamples(text: string): ReturnType<typeof parseJsonl> {
  try {
    return parseJsonl(text, "remote dataset");
  } catch (error) {
    // map back to AgentCoreCLIError, since this should be source: SERVICE, not USER
    if (error instanceof InputValidationError) {
      throw new AgentCoreCLIError(`Remote dataset DRAFT is invalid: ${error.message}`, {
        cause: error,
        source: ERROR_SOURCE.SERVICE,
      });
    }
    throw error;
  }
}

type DatasetExampleBatch<T> = {
  items: T[];
  clientToken: string;
};

function buildDatasetExampleBatches<T, P>(options: {
  items: T[];
  payloadItem: (item: T) => P;
  requestBody: (items: P[], clientToken: string) => unknown;
}): DatasetExampleBatch<T>[] {
  const { items, payloadItem, requestBody } = options;
  const batches: DatasetExampleBatch<T>[] = [];
  let batch: DatasetExampleBatch<T> | undefined;
  let batchBytes = 0;

  for (const [index, item] of items.entries()) {
    const itemBytes = encodedJsonBytes(payloadItem(item));
    if (!batch) {
      batch = { items: [], clientToken: randomUUID() };
      batchBytes = encodedJsonBytes(requestBody([], batch.clientToken));
    }

    const separatorBytes = batch.items.length === 0 ? 0 : 1;
    const exceedsCount = batch.items.length >= DATASET_EXAMPLES_BATCH_LIMIT;
    const exceedsPayload =
      batchBytes + separatorBytes + itemBytes > DATASET_MUTATION_PAYLOAD_LIMIT_BYTES;
    if (exceedsCount || exceedsPayload) {
      if (batch.items.length > 0) batches.push(batch);
      batch = { items: [], clientToken: randomUUID() };
      batchBytes = encodedJsonBytes(requestBody([], batch.clientToken));
    }

    const nextBatchBytes = batchBytes + (batch.items.length === 0 ? 0 : 1) + itemBytes;
    if (nextBatchBytes > DATASET_MUTATION_PAYLOAD_LIMIT_BYTES) {
      throw new InputValidationError(
        `Dataset example ${index + 1} exceeds the 5 MB mutation request limit`,
        {
          meta: {
            example: index + 1,
            payloadBytes: nextBatchBytes,
            payloadLimitBytes: DATASET_MUTATION_PAYLOAD_LIMIT_BYTES,
          },
        },
      );
    }

    batch.items.push(item);
    batchBytes = nextBatchBytes;
  }

  if (batch?.items.length) batches.push(batch);
  return batches;
}

function encodedJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new InputValidationError("Dataset example cannot be serialized as JSON");
  }
  return Buffer.byteLength(json, "utf8");
}

async function runDatasetExampleBatches<T, R>(options: {
  batches: DatasetExampleBatch<T>[];
  datasetId: string;
  control: BedrockAgentCoreControlClient;
  signal?: AbortSignal;
  onBatchStart?: () => void;
  operation: (batch: T[], clientToken: string) => Promise<R>;
  afterOperation?: (batch: T[], response: R) => Promise<void>;
  afterBatchSettled?: (batch: T[], response: R) => Promise<void>;
}): Promise<void> {
  const {
    batches,
    datasetId,
    control,
    signal,
    onBatchStart,
    operation,
    afterOperation,
    afterBatchSettled,
  } = options;
  for (const batch of batches) {
    signal?.throwIfAborted();
    onBatchStart?.();
    const response = await operation(batch.items, batch.clientToken);
    await afterOperation?.(batch.items, response);
    await waitForDatasetActive(control, datasetId, signal);
    await afterBatchSettled?.(batch.items, response);
  }
}

async function waitForDatasetActive(
  control: BedrockAgentCoreControlClient,
  datasetId: string,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < DATASET_ACTIVE_TIMEOUT_MS) {
    signal?.throwIfAborted();
    const dataset = await control.send(new GetDatasetCommand({ datasetId }), {
      abortSignal: signal,
    });
    if (dataset.status === "ACTIVE") return;
    if (dataset.status?.endsWith("_FAILED")) {
      throw new NetworkingError(`Dataset entered failed state: ${dataset.status}`, {
        meta: { datasetId, status: dataset.status },
      });
    }
    try {
      await sleep(DATASET_ACTIVE_POLL_MS, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    }
  }
  throw new NetworkingError(
    `Timed out waiting for dataset "${datasetId}" to become ACTIVE ` +
      `(waited ${DATASET_ACTIVE_TIMEOUT_MS / 1000}s)`,
    { meta: { datasetId } },
  );
}

// endWithNewline appends a single trailing newline if the stream did not with one
// Omitting the trailing newline causes attempts at appending to produce malformed JSONL
// Normalizing on write keeps the downloaded file editable
function endWithNewline(): Transform {
  const NEWLINE = 0x0a;
  let lastByte: number | undefined;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
      callback(null, chunk);
    },
    flush(callback) {
      // An empty body is left empty rather than turned into a lone newline.
      callback(null, lastByte === undefined || lastByte === NEWLINE ? undefined : "\n");
    },
  });
}

// runtimeServiceName derives the CloudWatch trace service name that scopes a
// CreateOnlineEvaluationConfig data source to one runtime endpoint's sessions:
// `{runtimeName}.{endpoint}`, keyed by the runtime *name* (verified against
// production configs — this does NOT match the log group's runtime id).
function runtimeServiceName(runtimeName: string, endpoint: string): string {
  return `${runtimeName}.${endpoint}`;
}

// resolveAgentToNameAndId resolves `--agent <id>` to its underlying runtime id +
// name. A harness is itself implemented as an AgentCore Runtime under the
// hood, so a plain runtime id resolves directly via GetAgentRuntime; a harness
// id 404s there and resolves instead via GetHarness, reading the underlying
// runtime out of `harness.environment.agentCoreRuntimeEnvironment`. Verified
// against real harnesses/runtimes in a live account before relying on it.
async function resolveAgentToNameAndId(
  agent: string,
  clients: AwsClients,
  options: CoreOptions,
): Promise<{ runtimeId: string; runtimeName: string }> {
  const control = clients.control(toClientConfig(options));
  try {
    const runtime = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: agent }));
    if (runtime.agentRuntimeName) {
      return { runtimeId: agent, runtimeName: runtime.agentRuntimeName };
    }
  } catch (error) {
    if ((error as Error).name !== "ResourceNotFoundException") throw error;
  }

  const harness = await control.send(new GetHarnessCommand({ harnessId: agent }));
  try {
    return harnessRuntimeFromResponse(agent, harness);
  } catch (error) {
    if (!(error instanceof InputValidationError)) throw error;
    throw new InputValidationError(`"${agent}" does not exist as a runtime or a harness`, {
      cause: error,
      meta: { agent },
    });
  }
}

// agentDataSource builds the CloudWatch data source for an agent id, resolving it
// to its underlying runtime first (the log group is keyed by the runtime id, the
// service name by the runtime name).
async function agentDataSource(
  agent: string,
  endpoint: string | undefined,
  clients: AwsClients,
  options: CoreOptions,
): Promise<DataSourceConfig> {
  const qualifier = endpoint ?? DEFAULT_ENDPOINT_QUALIFIER;
  const { runtimeId, runtimeName } = await resolveAgentToNameAndId(agent, clients, options);
  return {
    cloudWatchLogs: {
      logGroupNames: [runtimeLogGroup(runtimeId, qualifier)],
      serviceNames: [runtimeServiceName(runtimeName, qualifier)],
    },
  };
}

function buildSpanQuery(serviceName: string, sessionIds?: string[], traceId?: string): string {
  let query = `fields @message, attributes.session.id as sessionId, traceId, spanId
     | filter resource.attributes.service.name in ['${sanitizeQueryValue(serviceName)}']`;
  if (sessionIds && sessionIds.length > 0) {
    const ids = sessionIds.map((id) => `'${sanitizeQueryValue(id)}'`).join(", ");
    query += `\n     | filter attributes.session.id in [${ids}]`;
  }
  if (traceId) {
    query += `\n     | filter traceId = '${sanitizeQueryValue(traceId)}'`;
  }
  query += `\n     | sort @timestamp asc\n     | limit ${INSIGHTS_MAX_ROWS}`;
  return query;
}

// Group parsed @message docs by session, keeping only sessions with >=1 span
// (Evaluate rejects log-only sessions), and derive each session's trace/tool ids.
function groupSpansBySession(rows: ResultField[][], logger: Logger): SessionTrace[] {
  const docsBySession = new Map<string, SpanRecord[]>();
  const sessionsWithSpans = new Set<string>();
  let warnedAboutMalformedTelemetry = false;
  for (const row of rows) {
    const message = row.find((f) => f.field === "@message")?.value;
    const sessionId = row.find((f) => f.field === "sessionId")?.value;
    // Drop orphan records with no session id (e.g. system logs) — an
    // unidentifiable session can't be evaluated.
    if (!message || !sessionId) continue;
    let doc: SpanRecord;
    try {
      doc = JSON.parse(message) as SpanRecord;
    } catch {
      if (!warnedAboutMalformedTelemetry) {
        logger.warn("skipping malformed telemetry records");
        warnedAboutMalformedTelemetry = true;
      }
      continue;
    }
    const list = docsBySession.get(sessionId);
    if (list) list.push(doc);
    else docsBySession.set(sessionId, [doc]);
    // distinquish between log record and span (which has "kind")
    if ("kind" in doc) sessionsWithSpans.add(sessionId);
  }
  return [...docsBySession]
    .filter(([sessionId]) => sessionsWithSpans.has(sessionId))
    .map(([sessionId, spans]) => ({
      sessionId,
      spans,
      traceIds: extractTraceIds(spans),
      toolCallSpanIds: extractToolCallSpanIds(spans),
    }));
}

// extractTraceIds pulls the distinct trace ids out of a session's spans, preserving
// first-seen order (ported from the old CLI's span-collector).
function extractTraceIds(spans: SpanRecord[]): string[] {
  const seen = new Set<string>();
  const traceIds: string[] = [];
  for (const span of spans) {
    const traceId = span.traceId;
    // Skip empty ids: log records not tied to a trace carry traceId "", and the
    // Evaluate API rejects any target id that isn't a 32-char trace id.
    if (typeof traceId === "string" && traceId.length > 0 && !seen.has(traceId)) {
      seen.add(traceId);
      traceIds.push(traceId);
    }
  }
  return traceIds;
}

// isToolSpan classifies a tool-execution span by the framework markers the AgentCore
// evaluation SDK uses (Strands / OpenInference / Traceloop). Exact, case-sensitive —
// OpenInference is "TOOL" (upper), Traceloop is "tool" (lower).
function isToolSpan(attrs: Record<string, unknown>): boolean {
  return (
    attrs["gen_ai.operation.name"] === "execute_tool" ||
    attrs["openinference.span.kind"] === "TOOL" ||
    attrs["traceloop.span.kind"] === "tool"
  );
}

// extractToolCallSpanIds pulls the span ids of tool-execution spans for TOOL_CALL
// evaluators. A tool name attribute alone is unreliable (Traceloop names tools via
// traceloop.entity.name, not tool.name), so classify by span kind instead.
function extractToolCallSpanIds(spans: SpanRecord[]): string[] {
  const spanIds: string[] = [];
  for (const span of spans) {
    const spanId = span.spanId;
    if (typeof spanId !== "string" || spanId.length === 0) continue;
    if (isToolSpan((span.attributes ?? {}) as Record<string, unknown>)) spanIds.push(spanId);
  }
  return spanIds;
}

// resolveEvaluatorLevels maps each evaluator id to its evaluation level via
// GetEvaluator — authoritative for both builtins (e.g. Builtin.Helpfulness ⇒ TRACE)
// and custom evaluators, so the level (which decides whether the Evaluate call
// targets trace ids, tool-call span ids, or the whole session) is never guessed.
// GetEvaluator errors propagate: a failed lookup (e.g. AccessDenied, not-found)
// must surface, not silently degrade to SESSION and submit the wrong scope.
async function resolveEvaluatorLevels(
  evaluatorIds: string[],
  control: BedrockAgentCoreControlClient,
  _options: CoreOptions,
): Promise<Map<string, EvaluatorLevel>> {
  const levels = new Map<string, EvaluatorLevel>();
  for (const id of new Set(evaluatorIds)) {
    const evaluator = await control.send(new GetEvaluatorCommand({ evaluatorId: id }));
    // level is a required response field (SDK types it `| undefined` without `?`).
    levels.set(id, evaluator.level!);
  }
  return levels;
}

// groupRefsBySession indexes ground-truth reference inputs by the session they
// apply to (context.spanContext.sessionId), so each Evaluate call attaches only its
// own session's references — the synchronous Evaluate shape, not batch's job-level
// evaluationMetadata.
function groupRefsBySession(
  groundTruth: EvaluationReferenceInput[] | undefined,
): Map<string, EvaluationReferenceInput[]> {
  const map = new Map<string, EvaluationReferenceInput[]>();
  for (const ref of groundTruth ?? []) {
    const sessionId =
      ref.context && "spanContext" in ref.context ? ref.context.spanContext?.sessionId : undefined;
    if (!sessionId) continue;
    const list = map.get(sessionId);
    if (list) list.push(ref);
    else map.set(sessionId, [ref]);
  }
  return map;
}

// targetBatches splits a session's evaluation targets into <=10-id Evaluate calls.
// SESSION evaluators make a single call with no target; TRACE/TOOL_CALL sessions
// with no ids at that level make none (the session is skipped for that evaluator).
function targetBatches(
  level: EvaluatorLevel,
  trace: SessionTrace,
): (EvaluationTarget | undefined)[] {
  if (level === "TRACE") {
    return chunk(trace.traceIds, EVALUATE_TARGET_BATCH).map((traceIds) => ({ traceIds }));
  }
  if (level === "TOOL_CALL") {
    return chunk(trace.toolCallSpanIds, EVALUATE_TARGET_BATCH).map((spanIds) => ({ spanIds }));
  }
  return [undefined];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// A just-written role or inline policy is not visible to the service immediately
// (IAM is eventually consistent), and the service validates both when the config
// is created. It surfaces as one of two messages depending on which part has not
// propagated yet.
const ROLE_NOT_PROPAGATED =
  /cannot be assumed|unable to assume|does not have permissions to (create log group|access the specified log groups)/i;

async function retryWhileRolePropagates<T>(send: () => Promise<T>): Promise<T> {
  const delaysMs = [2_000, 4_000, 8_000, 15_000];
  for (const delay of delaysMs) {
    try {
      return await send();
    } catch (error) {
      const err = error as {
        name?: string;
        message?: string;
        $metadata?: { httpStatusCode?: number };
      };
      const retryable =
        err.name === "AccessDeniedException" ||
        err.$metadata?.httpStatusCode === 403 ||
        (err.name === "ValidationException" && /assume|role|trust/i.test(err.message ?? "")) ||
        ROLE_NOT_PROPAGATED.test(err.message ?? "");
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return send();
}

// evaluatorKmsKeys collects the customer managed KMS keys of the referenced
// evaluators. The service validates that the execution role can decrypt them when
// the config is created, so a provisioned role has to grant kms:Decrypt on exactly
// these keys. Builtins carry no key, so the common case resolves to nothing. A
// GetEvaluator failure propagates as-is: the SDK's error already names the
// operation and the evaluator, and it is not the caller's input at fault.
async function evaluatorKmsKeys(
  evaluatorIds: string[],
  control: BedrockAgentCoreControlClient,
): Promise<string[]> {
  const keys = await Promise.all(
    evaluatorIds.map(async (evaluatorId) => {
      const evaluator = await control.send(new GetEvaluatorCommand({ evaluatorId }));
      return evaluator.kmsKeyArn;
    }),
  );
  return [...new Set(keys.filter((key): key is string => key !== undefined))];
}

// logGroupNamesOf reads the log groups out of a resolved dataSourceConfig, for
// scoping the default execution role. cloudWatchLogs is the only arm the API
// defines today; an unrecognized one yields no groups rather than throwing, so a
// future arm degrades to a role the caller can still override with --role-arn.
function logGroupNamesOf(dataSourceConfig: DataSourceConfig): string[] {
  return "cloudWatchLogs" in dataSourceConfig
    ? (dataSourceConfig.cloudWatchLogs?.logGroupNames ?? [])
    : [];
}

// runtimeIdFromLogGroup recovers the runtime id embedded in a log group path
// produced by runtimeLogGroup, so an update can re-derive dataSourceConfig for a
// new --endpoint without the caller passing --agent again. Returns undefined for
// a path that does not follow the convention, i.e. a config pointed at custom log
// groups, which carries no runtime id to recover.
//
// Splitting on the *last* hyphen is unambiguous: endpoint names are constrained
// to [a-zA-Z][a-zA-Z0-9_]{0,47}, so they never contain one.
function runtimeIdFromLogGroup(logGroupName: string): string | undefined {
  const match = logGroupName.match(/^\/aws\/bedrock-agentcore\/runtimes\/(.+)-[^-]+$/);
  return match?.[1];
}

function toRule(
  samplingRate: number | undefined,
  sessionTimeoutMinutes: number | undefined,
  filters?: Rule["filters"],
): Rule {
  return {
    samplingConfig: { samplingPercentage: samplingRate },
    // sessionConfig is optional on Rule and the service does not backfill it, so
    // omit it when unset rather than materializing the service's own default.
    ...(sessionTimeoutMinutes !== undefined ? { sessionConfig: { sessionTimeoutMinutes } } : {}),
    filters,
  };
}
