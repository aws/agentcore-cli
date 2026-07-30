import {
  CreateOnlineEvaluationConfigCommand,
  DeleteOnlineEvaluationConfigCommand,
  GetAgentRuntimeCommand,
  GetHarnessCommand,
  GetOnlineEvaluationConfigCommand,
  ListOnlineEvaluationConfigsCommand,
  UpdateOnlineEvaluationConfigCommand,
  type CreateOnlineEvaluationConfigResponse,
  type DeleteOnlineEvaluationConfigResponse,
  type GetOnlineEvaluationConfigResponse,
  type ListOnlineEvaluationConfigsResponse,
  type Rule,
  type UpdateOnlineEvaluationConfigResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../errors";
import type {
  CoreOnlineEvalClient,
  CreateOnlineEvalInput,
  UpdateOnlineEvalInput,
} from "../handlers/eval/online-eval/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";
import { ensureDefaultOnlineEvalExecutionRole } from "./onlineEvalExecutionRole";

const DEFAULT_ENDPOINT_QUALIFIER = "DEFAULT";
const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;

// runtimeLogGroup mirrors the old CLI's derivation (src/cli/aws/cloudwatch.ts):
// AgentCore always writes a runtime endpoint's traces to this fixed path, keyed
// by the runtime *id*.
function runtimeLogGroup(runtimeId: string, endpoint: string): string {
  return `/aws/bedrock-agentcore/runtimes/${runtimeId}-${endpoint}`;
}

// runtimeServiceName derives the CloudWatch trace service name that scopes a
// CreateOnlineEvaluationConfig data source to one runtime endpoint's sessions:
// `{runtimeName}.{endpoint}`, keyed by the runtime *name* (verified against
// production configs — this does NOT match the log group's runtime id).
function runtimeServiceName(runtimeName: string, endpoint: string): string {
  return `${runtimeName}.${endpoint}`;
}

// resolveAgentRuntime resolves `--agent <id>` to its underlying runtime id +
// name. A harness is itself implemented as an AgentCore Runtime under the
// hood, so a plain runtime id resolves directly via GetAgentRuntime; a harness
// id 404s there and resolves instead via GetHarness, reading the underlying
// runtime out of `harness.environment.agentCoreRuntimeEnvironment`. Verified
// against real harnesses/runtimes in a live account before relying on it.
async function resolveAgentRuntime(
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
  const environment = harness.harness?.environment;
  const runtimeEnv =
    environment && "agentCoreRuntimeEnvironment" in environment
      ? environment.agentCoreRuntimeEnvironment
      : undefined;
  if (!runtimeEnv?.agentRuntimeId || !runtimeEnv?.agentRuntimeName) {
    throw new InputValidationError(`"${agent}" is not a runtime or harness AgentCore can resolve`, {
      meta: { agent },
    });
  }
  return { runtimeId: runtimeEnv.agentRuntimeId, runtimeName: runtimeEnv.agentRuntimeName };
}

// resolveDataSource turns the caller-facing agent-or-raw union into the
// dataSourceConfig.cloudWatchLogs shape the API accepts.
async function resolveDataSource(
  input: CreateOnlineEvalInput,
  clients: AwsClients,
  options: CoreOptions,
): Promise<{ logGroupNames: string[]; serviceNames: string[] }> {
  if (input.agent !== undefined) {
    const agent = input.agent;
    const endpoint = input.endpoint ?? DEFAULT_ENDPOINT_QUALIFIER;
    const { runtimeId, runtimeName } = await resolveAgentRuntime(agent, clients, options);
    return {
      logGroupNames: [runtimeLogGroup(runtimeId, endpoint)],
      serviceNames: [runtimeServiceName(runtimeName, endpoint)],
    };
  }
  return { logGroupNames: input.logGroupNames, serviceNames: input.serviceNames };
}

// runtimeIdFromLogGroup recovers the runtime id embedded in a log group path
// produced by runtimeLogGroup, so an update can re-derive dataSourceConfig for
// a new --endpoint without the caller having to pass --runtime again.
function runtimeIdFromLogGroup(logGroupName: string): string | undefined {
  const match = logGroupName.match(/^\/aws\/bedrock-agentcore\/runtimes\/(.+)-[^-]+$/);
  return match?.[1];
}

function toRule(
  samplingRate: number,
  sessionTimeoutMinutes: number,
  filters?: Rule["filters"],
): Rule {
  return {
    samplingConfig: { samplingPercentage: samplingRate },
    sessionConfig: { sessionTimeoutMinutes },
    filters,
  };
}

export class OnlineEvalClient implements CoreOnlineEvalClient {
  constructor(private readonly clients: AwsClients) {}

  async createOnlineEvaluationConfig(
    input: CreateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<CreateOnlineEvaluationConfigResponse> {
    const { logGroupNames, serviceNames } = await resolveDataSource(input, this.clients, options);
    const control = this.clients.control(toClientConfig(options));

    const evaluationExecutionRoleArn =
      input.evaluationExecutionRoleArn ??
      (await ensureDefaultOnlineEvalExecutionRole(
        this.clients.iam(toClientConfig(options)),
        input.name,
        options.region,
        logGroupNames,
      ));

    return control.send(
      new CreateOnlineEvaluationConfigCommand({
        onlineEvaluationConfigName: input.name,
        description: input.description,
        rule: toRule(
          input.samplingRate,
          input.sessionTimeoutMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES,
          input.filters,
        ),
        dataSourceConfig: { cloudWatchLogs: { logGroupNames, serviceNames } },
        evaluators: input.evaluatorIds?.map((evaluatorId) => ({ evaluatorId })),
        evaluationExecutionRoleArn,
        enableOnCreate: input.enableOnCreate ?? true,
        clientToken: input.clientToken,
      }),
    );
  }

  // updateOnlineEvaluationConfig fetches the current config and merges the
  // provided fields over it, because UpdateOnlineEvaluationConfig replaces the
  // whole `rule` (and, when endpoint changes, `dataSourceConfig`) rather than
  // patching individual fields.
  async updateOnlineEvaluationConfig(
    id: string,
    update: UpdateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<UpdateOnlineEvaluationConfigResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(
      new GetOnlineEvaluationConfigCommand({
        onlineEvaluationConfigId: id,
      }),
    );

    const samplingPercentage =
      update.samplingRate ?? current.rule?.samplingConfig?.samplingPercentage;
    if (samplingPercentage === undefined) {
      throw new InputValidationError(
        `Online evaluation config "${id}" is missing its sampling configuration`,
        { meta: { onlineEvaluationConfigId: id } },
      );
    }
    const sessionTimeoutMinutes =
      update.sessionTimeoutMinutes ??
      current.rule?.sessionConfig?.sessionTimeoutMinutes ??
      DEFAULT_SESSION_TIMEOUT_MINUTES;
    const filters = update.filters ?? current.rule?.filters;

    const evaluators =
      update.evaluatorIds !== undefined
        ? update.evaluatorIds.map((evaluatorId) => ({ evaluatorId }))
        : current.evaluators;

    let dataSourceConfig = current.dataSourceConfig;
    if (update.clearEndpoint || update.endpoint !== undefined) {
      const currentSource =
        current.dataSourceConfig && "cloudWatchLogs" in current.dataSourceConfig
          ? current.dataSourceConfig.cloudWatchLogs
          : undefined;
      const currentLogGroup = currentSource?.logGroupNames?.[0];
      const runtimeId = currentLogGroup && runtimeIdFromLogGroup(currentLogGroup);
      if (!runtimeId) {
        throw new InputValidationError(
          `Online evaluation config "${id}" was not created from an agent; --endpoint cannot be changed`,
          { meta: { onlineEvaluationConfigId: id } },
        );
      }
      const runtime = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
      if (!runtime.agentRuntimeName) {
        throw new InputValidationError(`Runtime "${runtimeId}" was not found`, {
          meta: { agentRuntimeId: runtimeId },
        });
      }
      const endpoint = update.clearEndpoint ? DEFAULT_ENDPOINT_QUALIFIER : update.endpoint!;
      dataSourceConfig = {
        cloudWatchLogs: {
          logGroupNames: [runtimeLogGroup(runtimeId, endpoint)],
          serviceNames: [runtimeServiceName(runtime.agentRuntimeName, endpoint)],
        },
      };
    }

    return control.send(
      new UpdateOnlineEvaluationConfigCommand({
        onlineEvaluationConfigId: id,
        rule: toRule(samplingPercentage, sessionTimeoutMinutes, filters),
        dataSourceConfig,
        evaluators,
        clientToken: update.clientToken,
      }),
    );
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
}
