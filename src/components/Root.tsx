import { useState } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Core } from "../handlers/types.tsx";
import { HarnessScreen } from "../handlers/harness/screen.tsx";
import { HarnessGetScreen, HarnessGetJsonScreen } from "../handlers/harness/get/screen.tsx";
import { HarnessListScreen } from "../handlers/harness/list/screen.tsx";
import { HarnessCreateScreen } from "../handlers/harness/create/screen.tsx";
import { HarnessUpdateScreen } from "../handlers/harness/update/screen.tsx";
import { HarnessDeleteScreen } from "../handlers/harness/delete/screen.tsx";
import { HarnessInvokeScreen } from "../handlers/harness/invoke/screen.tsx";
import { HarnessExecScreen } from "../handlers/harness/exec/screen.tsx";
import { HarnessEndpointScreen } from "../handlers/harness/endpoint/screen.tsx";
import { HarnessCreateEndpointScreen } from "../handlers/harness/endpoint/create/screen.tsx";
import { HarnessGetEndpointScreen } from "../handlers/harness/endpoint/get/screen.tsx";
import { HarnessListEndpointsScreen } from "../handlers/harness/endpoint/list/screen.tsx";
import { HarnessUpdateEndpointScreen } from "../handlers/harness/endpoint/update/screen.tsx";
import { HarnessDeleteEndpointScreen } from "../handlers/harness/endpoint/delete/screen.tsx";
import { HarnessVersionScreen } from "../handlers/harness/version/screen.tsx";
import { HarnessGetVersionScreen } from "../handlers/harness/version/get/screen.tsx";
import { HarnessListVersionsScreen } from "../handlers/harness/version/list/screen.tsx";
import { RuntimeScreen } from "../handlers/runtime/screen.tsx";
import { RuntimeGetJsonScreen, RuntimeGetScreen } from "../handlers/runtime/get/screen.tsx";
import { RuntimeListScreen } from "../handlers/runtime/list/screen.tsx";
import { RuntimeEndpointScreen } from "../handlers/runtime/endpoint/screen.tsx";
import {
  RuntimeGetEndpointJsonScreen,
  RuntimeGetEndpointScreen,
} from "../handlers/runtime/endpoint/get/screen.tsx";
import { RuntimeListEndpointsScreen } from "../handlers/runtime/endpoint/list/screen.tsx";
import { RuntimeVersionScreen } from "../handlers/runtime/version/screen.tsx";
import { RuntimeGetVersionScreen } from "../handlers/runtime/version/get/screen.tsx";
import { RuntimeListVersionsScreen } from "../handlers/runtime/version/list/screen.tsx";
import { MemoryScreen } from "../handlers/memory/screen.tsx";
import { MemoryGetJsonScreen, MemoryGetScreen } from "../handlers/memory/get/screen.tsx";
import { MemoryListScreen } from "../handlers/memory/list/screen.tsx";
import { RuntimeInvokeScreen } from "../handlers/runtime/invoke/screen.tsx";
import { EvalScreen } from "../handlers/eval/screen.tsx";
import { EvaluatorScreen } from "../handlers/eval/evaluator/screen.tsx";
import { EvaluatorListScreen } from "../handlers/eval/evaluator/list/screen.tsx";
import {
  EvaluatorGetScreen,
  EvaluatorGetJsonScreen,
} from "../handlers/eval/evaluator/get/screen.tsx";
import { OnlineEvalScreen } from "../handlers/eval/online-eval/screen.tsx";
import { OnlineEvalListScreen } from "../handlers/eval/online-eval/list/screen.tsx";
import {
  OnlineEvalGetScreen,
  OnlineEvalGetJsonScreen,
} from "../handlers/eval/online-eval/get/screen.tsx";
import { OnlineInsightScreen } from "../handlers/eval/online-insight/screen.tsx";
import { OnlineInsightListScreen } from "../handlers/eval/online-insight/list/screen.tsx";
import {
  OnlineInsightGetScreen,
  OnlineInsightGetJsonScreen,
} from "../handlers/eval/online-insight/get/screen.tsx";
import { BatchEvaluationScreen } from "../handlers/eval/batch-evaluation/screen.tsx";
import { BatchEvaluationListScreen } from "../handlers/eval/batch-evaluation/list/screen.tsx";
import { BatchEvaluationGetJsonScreen } from "../handlers/eval/batch-evaluation/get/screen.tsx";
import { BatchInsightsScreen } from "../handlers/eval/batch-insights/screen.tsx";
import { BatchInsightsListScreen } from "../handlers/eval/batch-insights/list/screen.tsx";
import { BatchInsightsGetJsonScreen } from "../handlers/eval/batch-insights/get/screen.tsx";
import { DatasetScreen } from "../handlers/eval/dataset/screen.tsx";
import { DatasetListScreen } from "../handlers/eval/dataset/list/screen.tsx";
import { DatasetGetScreen, DatasetGetJsonScreen } from "../handlers/eval/dataset/get/screen.tsx";
import { ConfigBundleScreen } from "../handlers/eval/config-bundle/screen.tsx";
import { ConfigBundleListScreen } from "../handlers/eval/config-bundle/list/screen.tsx";
import { ConfigBundleGetScreen } from "../handlers/eval/config-bundle/get/screen.tsx";
import { ConfigBundleVersionScreen } from "../handlers/eval/config-bundle/version/screen.tsx";
import { ConfigBundleVersionListScreen } from "../handlers/eval/config-bundle/version/list/screen.tsx";
import { AbTestScreen } from "../handlers/eval/ab-test/screen.tsx";
import { AbTestListScreen } from "../handlers/eval/ab-test/list/screen.tsx";
import { AbTestGetScreen, AbTestGetJsonScreen } from "../handlers/eval/ab-test/get/screen.tsx";
import { MemoryEventScreen } from "../handlers/memory/event/screen.tsx";
import { MemoryEventGetScreen } from "../handlers/memory/event/get/screen.tsx";
import { MemoryEventListScreen } from "../handlers/memory/event/list/screen.tsx";
import { MemoryRecordScreen } from "../handlers/memory/record/screen.tsx";
import { MemoryRecordGetScreen } from "../handlers/memory/record/get/screen.tsx";
import { MemoryRecordListScreen } from "../handlers/memory/record/list/screen.tsx";
import { MemoryActorScreen } from "../handlers/memory/actor/screen.tsx";
import { MemoryActorListScreen } from "../handlers/memory/actor/list/screen.tsx";
import { MemorySessionScreen } from "../handlers/memory/session/screen.tsx";
import { MemorySessionListScreen } from "../handlers/memory/session/list/screen.tsx";
import { IdentityScreen } from "../handlers/identity/screen.tsx";
import { ApiKeyCredentialProviderScreen } from "../handlers/identity/api-key-credential-provider/screen.tsx";
import { ApiKeyCredentialProviderListScreen } from "../handlers/identity/api-key-credential-provider/list/screen.tsx";
import {
  ApiKeyCredentialProviderGetScreen,
  ApiKeyCredentialProviderGetJsonScreen,
} from "../handlers/identity/api-key-credential-provider/get/screen.tsx";
import { Oauth2CredentialProviderScreen } from "../handlers/identity/oauth2-credential-provider/screen.tsx";
import { Oauth2CredentialProviderListScreen } from "../handlers/identity/oauth2-credential-provider/list/screen.tsx";
import {
  Oauth2CredentialProviderGetScreen,
  Oauth2CredentialProviderGetJsonScreen,
} from "../handlers/identity/oauth2-credential-provider/get/screen.tsx";
import { GatewayScreen } from "../handlers/gateway/screen.tsx";
import { GatewayGetJsonScreen, GatewayGetScreen } from "../handlers/gateway/get/screen.tsx";
import { GatewayListScreen } from "../handlers/gateway/list/screen.tsx";
import { GatewayTargetScreen } from "../handlers/gateway/target/screen.tsx";
import { GatewayTargetListScreen } from "../handlers/gateway/target/list/screen.tsx";
import { GatewayTargetGetScreen } from "../handlers/gateway/target/get/screen.tsx";
import { GatewayConnectorScreen } from "../handlers/gateway/connector/screen.tsx";
import { GatewayConnectorListScreen } from "../handlers/gateway/connector/list/screen.tsx";
import { GatewayConnectorGetScreen } from "../handlers/gateway/connector/get/screen.tsx";
import { GatewayRuleScreen } from "../handlers/gateway/rule/screen.tsx";
import { GatewayRuleListScreen } from "../handlers/gateway/rule/list/screen.tsx";
import { GatewayRuleGetScreen } from "../handlers/gateway/rule/get/screen.tsx";
import { GatewayInvokeScreen } from "../handlers/gateway/invoke/screen.tsx";
import { ProjectScreen, ProjectCommandNotImplementedScreen } from "../handlers/project/screen.tsx";
import { ProjectCreateScreen } from "../handlers/project/create/screen.tsx";
import { ProjectInvokePickerScreen } from "../handlers/project/invoke/screen.tsx";
import { RootScreen, HelpScreen } from "../handlers/screen.tsx";
import type { Context } from "../router";

// PROJECT_COMMANDS are the `agentcore project` subcommands that are listed in
// the menu but have no screen of their own yet (`create` has the wizard). Each
// is routed explicitly so selecting it reports "not implemented" error
const PROJECT_COMMANDS = ["add", "export", "remove", "dev", "deploy", "status", "build"] as const;

export interface RootProps {
  // path is the command path to the executing node (e.g. "/agentcore").
  path: string;
  // core carries the injected service clients for use by the TUI.
  core: Core;

  ctx: Context;

  // queryClient is an optional override for the react-query client. Production
  // leaves it unset (a stable one is created per mount); tests inject one — e.g.
  // with retries disabled — to keep behavior deterministic and fast.
  queryClient?: QueryClient;
}

// Root is the top of the Ink React tree, rendered by the `agentcore` default
// handler when the CLI is invoked without a subcommand.
export function Root({ path, ctx, core, queryClient }: RootProps) {
  // Create the QueryClient once per mount; a lazy initializer keeps it stable
  // across re-renders (a fresh client would drop the cache and refetch). An
  // injected client (tests) takes precedence.
  const [defaultQueryClient] = useState(() => new QueryClient());
  const client = queryClient ?? defaultQueryClient;

  return (
    <QueryClientProvider client={client}>
      {/* initialEntries seeds the in-memory history with the CLI command path,
          then leaves navigation to the router so screens can useNavigate. */}
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="agentcore" element={<RootScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/project/invoke"
            element={<ProjectInvokePickerScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/harness" element={<HarnessScreen ctx={ctx} core={core} />} />
          {/* Bare `get` (no id) has nothing to show — send the user to the list. */}
          <Route
            path="agentcore/harness/get"
            element={<Navigate to="/agentcore/harness/list" replace />}
          />
          <Route
            path="agentcore/harness/get/:harnessId"
            element={<HarnessGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/get/:harnessId/json"
            element={<HarnessGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/list"
            element={<HarnessListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/create"
            element={<HarnessCreateScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/update"
            element={<HarnessUpdateScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/update/:harnessId"
            element={<HarnessUpdateScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/delete"
            element={<HarnessDeleteScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/delete/:harnessId"
            element={<HarnessDeleteScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/invoke"
            element={<HarnessInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/invoke/:harnessId"
            element={<HarnessInvokeScreen ctx={ctx} core={core} />}
          />
          {/* Deep link that resumes an existing runtime session in the chat. */}
          <Route
            path="agentcore/harness/invoke/:harnessId/:sessionId"
            element={<HarnessInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/exec"
            element={<HarnessExecScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/exec/:harnessId"
            element={<HarnessExecScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/exec/:harnessId/:sessionId"
            element={<HarnessExecScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint"
            element={<HarnessEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/create"
            element={<HarnessCreateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/create/:harnessId"
            element={<HarnessCreateEndpointScreen ctx={ctx} core={core} />}
          />
          {/* Bare `endpoint get` (no target) has nothing to show — send the
              user to the endpoint listing (same idea for `version get`). */}
          <Route
            path="agentcore/harness/endpoint/get"
            element={<Navigate to="/agentcore/harness/endpoint/list" replace />}
          />
          <Route
            path="agentcore/harness/endpoint/get/:harnessId/:endpointName"
            element={<HarnessGetEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/list"
            element={<HarnessListEndpointsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/list/:harnessId"
            element={<HarnessListEndpointsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/update"
            element={<HarnessUpdateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/update/:harnessId"
            element={<HarnessUpdateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/update/:harnessId/:endpointName"
            element={<HarnessUpdateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/delete"
            element={<HarnessDeleteEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/delete/:harnessId"
            element={<HarnessDeleteEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/delete/:harnessId/:endpointName"
            element={<HarnessDeleteEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version"
            element={<HarnessVersionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version/get"
            element={<Navigate to="/agentcore/harness/version/list" replace />}
          />
          <Route
            path="agentcore/harness/version/get/:harnessId/:version"
            element={<HarnessGetVersionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version/list"
            element={<HarnessListVersionsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version/list/:harnessId"
            element={<HarnessListVersionsScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/runtime" element={<RuntimeScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/runtime/get"
            element={<Navigate to="/agentcore/runtime/list" replace />}
          />
          <Route
            path="agentcore/runtime/list"
            element={<RuntimeListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/get/:runtimeId"
            element={<RuntimeGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/get/:runtimeId/json"
            element={<RuntimeGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/version"
            element={<RuntimeVersionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/version/get"
            element={<Navigate to="/agentcore/runtime/version/list" replace />}
          />
          <Route
            path="agentcore/runtime/version/get/:runtimeId/:version"
            element={<RuntimeGetVersionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/version/list"
            element={<RuntimeListVersionsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/version/list/:runtimeId"
            element={<RuntimeListVersionsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/endpoint"
            element={<RuntimeEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/endpoint/get"
            element={<Navigate to="/agentcore/runtime/endpoint/list" replace />}
          />
          <Route
            path="agentcore/runtime/endpoint/get/:runtimeId/:qualifier"
            element={<RuntimeGetEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/endpoint/get/:runtimeId/:qualifier/json"
            element={<RuntimeGetEndpointJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/endpoint/list"
            element={<RuntimeListEndpointsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/endpoint/list/:runtimeId"
            element={<RuntimeListEndpointsScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/memory" element={<MemoryScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/memory/get"
            element={<Navigate to="/agentcore/memory/list" replace />}
          />
          <Route
            path="agentcore/memory/list"
            element={<MemoryListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/get/:memoryId"
            element={<MemoryGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/get/:memoryId/json"
            element={<MemoryGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/invoke"
            element={<RuntimeInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/invoke/:runtimeId"
            element={<RuntimeInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/runtime/invoke/:runtimeId/:qualifier"
            element={<RuntimeInvokeScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/gateway" element={<GatewayScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/gateway/get"
            element={<Navigate to="/agentcore/gateway/list" replace />}
          />
          <Route
            path="agentcore/gateway/list"
            element={<GatewayListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/get/:gatewayId"
            element={<GatewayGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/get/:gatewayId/json"
            element={<GatewayGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/invoke"
            element={<GatewayInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/invoke/:gatewayId"
            element={<GatewayInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/target"
            element={<GatewayTargetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/target/get"
            element={<Navigate to="/agentcore/gateway/target/list" replace />}
          />
          <Route
            path="agentcore/gateway/target/list"
            element={<GatewayTargetListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/target/list/:gatewayId"
            element={<GatewayTargetListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/target/get/:gatewayId/:targetId"
            element={<GatewayTargetGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/connector"
            element={<GatewayConnectorScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/connector/get"
            element={<Navigate to="/agentcore/gateway/connector/list" replace />}
          />
          <Route
            path="agentcore/gateway/connector/list"
            element={<GatewayConnectorListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/connector/list/:gatewayId"
            element={<GatewayConnectorListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/connector/get/:gatewayId/:targetId"
            element={<GatewayConnectorGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/rule"
            element={<GatewayRuleScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/rule/get"
            element={<Navigate to="/agentcore/gateway/rule/list" replace />}
          />
          <Route
            path="agentcore/gateway/rule/list"
            element={<GatewayRuleListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/rule/list/:gatewayId"
            element={<GatewayRuleListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/gateway/rule/get/:gatewayId/:ruleId"
            element={<GatewayRuleGetScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/eval" element={<EvalScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/eval/evaluator"
            element={<EvaluatorScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/evaluator/list"
            element={<EvaluatorListScreen ctx={ctx} core={core} />}
          />
          {/* Bare `get` (no id) has nothing to show — send the user to the list. */}
          <Route
            path="agentcore/eval/evaluator/get"
            element={<Navigate to="/agentcore/eval/evaluator/list" replace />}
          />
          <Route
            path="agentcore/eval/evaluator/get/:evaluatorId"
            element={<EvaluatorGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/evaluator/get/:evaluatorId/json"
            element={<EvaluatorGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-eval"
            element={<OnlineEvalScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-eval/list"
            element={<OnlineEvalListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-eval/get"
            element={<Navigate to="/agentcore/eval/online-eval/list" replace />}
          />
          <Route
            path="agentcore/eval/online-eval/get/:configId"
            element={<OnlineEvalGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-eval/get/:configId/json"
            element={<OnlineEvalGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-insight"
            element={<OnlineInsightScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-insight/list"
            element={<OnlineInsightListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-insight/get"
            element={<Navigate to="/agentcore/eval/online-insight/list" replace />}
          />
          <Route
            path="agentcore/eval/online-insight/get/:configId"
            element={<OnlineInsightGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/online-insight/get/:configId/json"
            element={<OnlineInsightGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/eval/dataset" element={<DatasetScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/eval/dataset/list"
            element={<DatasetListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/dataset/get"
            element={<Navigate to="/agentcore/eval/dataset/list" replace />}
          />
          <Route
            path="agentcore/eval/dataset/get/:datasetId"
            element={<DatasetGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/dataset/get/:datasetId/json"
            element={<DatasetGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/config-bundle"
            element={<ConfigBundleScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/config-bundle/list"
            element={<ConfigBundleListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/config-bundle/get"
            element={<Navigate to="/agentcore/eval/config-bundle/list" replace />}
          />
          <Route
            path="agentcore/eval/config-bundle/get/:bundleId"
            element={<ConfigBundleGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/config-bundle/get/:bundleId/:versionId"
            element={<ConfigBundleGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/config-bundle/version"
            element={<ConfigBundleVersionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/config-bundle/version/list"
            element={<ConfigBundleVersionListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/config-bundle/version/list/:bundleId"
            element={<ConfigBundleVersionListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/batch-evaluation"
            element={<BatchEvaluationScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/batch-evaluation/list"
            element={<BatchEvaluationListScreen ctx={ctx} core={core} />}
          />
          {/* Bare `get` (no id) has nothing to show — send the user to the list. */}
          <Route
            path="agentcore/eval/batch-evaluation/get"
            element={<Navigate to="/agentcore/eval/batch-evaluation/list" replace />}
          />
          {/* get is raw JSON only — no metadata hub, so :id is the JSON view. */}
          <Route
            path="agentcore/eval/batch-evaluation/get/:batchEvaluationId"
            element={<BatchEvaluationGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/eval/ab-test" element={<AbTestScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/eval/ab-test/list"
            element={<AbTestListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/ab-test/get"
            element={<Navigate to="/agentcore/eval/ab-test/list" replace />}
          />
          <Route
            path="agentcore/eval/ab-test/get/:abTestId"
            element={<AbTestGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/ab-test/get/:abTestId/json"
            element={<AbTestGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/batch-insights"
            element={<BatchInsightsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/batch-insights/list"
            element={<BatchInsightsListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/eval/batch-insights/get"
            element={<Navigate to="/agentcore/eval/batch-insights/list" replace />}
          />
          <Route
            path="agentcore/eval/batch-insights/get/:batchEvaluationId"
            element={<BatchInsightsGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/event"
            element={<MemoryEventScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/event/get"
            element={<Navigate to="/agentcore/memory/event/list" replace />}
          />
          <Route
            path="agentcore/memory/event/get/:memoryId/:actorId/:sessionId/:eventId"
            element={<MemoryEventGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/event/list"
            element={<MemoryEventListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/event/list/:memoryId"
            element={<MemoryEventListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/event/list/:memoryId/:actorId"
            element={<MemoryEventListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/event/list/:memoryId/:actorId/:sessionId"
            element={<MemoryEventListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/record"
            element={<MemoryRecordScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/record/get"
            element={<Navigate to="/agentcore/memory/record/list" replace />}
          />
          <Route
            path="agentcore/memory/record/get/:memoryId/:recordId"
            element={<MemoryRecordGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/record/list"
            element={<MemoryRecordListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/record/list/:memoryId"
            element={<MemoryRecordListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/record/list/:memoryId/:scopeKind/:scope"
            element={<MemoryRecordListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/actor"
            element={<MemoryActorScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/actor/list"
            element={<MemoryActorListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/actor/list/:memoryId"
            element={<MemoryActorListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/session"
            element={<MemorySessionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/session/list"
            element={<MemorySessionListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/session/list/:memoryId"
            element={<MemorySessionListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/memory/session/list/:memoryId/:actorId"
            element={<MemorySessionListScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/identity" element={<IdentityScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/identity/api-key-credential-provider"
            element={<ApiKeyCredentialProviderScreen ctx={ctx} core={core} />}
          />
          {/* Bare `get` (no name) has nothing to show — send the user to the list. */}
          <Route
            path="agentcore/identity/api-key-credential-provider/get"
            element={<Navigate to="/agentcore/identity/api-key-credential-provider/list" replace />}
          />
          <Route
            path="agentcore/identity/api-key-credential-provider/list"
            element={<ApiKeyCredentialProviderListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/identity/api-key-credential-provider/get/:name"
            element={<ApiKeyCredentialProviderGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/identity/api-key-credential-provider/get/:name/json"
            element={<ApiKeyCredentialProviderGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/identity/oauth2-credential-provider"
            element={<Oauth2CredentialProviderScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/identity/oauth2-credential-provider/get"
            element={<Navigate to="/agentcore/identity/oauth2-credential-provider/list" replace />}
          />
          <Route
            path="agentcore/identity/oauth2-credential-provider/list"
            element={<Oauth2CredentialProviderListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/identity/oauth2-credential-provider/get/:name"
            element={<Oauth2CredentialProviderGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/identity/oauth2-credential-provider/get/:name/json"
            element={<Oauth2CredentialProviderGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route path="agentcore/project" element={<ProjectScreen ctx={ctx} core={core} />} />
          <Route
            path="agentcore/project/create"
            element={<ProjectCreateScreen ctx={ctx} core={core} />}
          />
          {PROJECT_COMMANDS.map((command) => (
            <Route
              key={command}
              path={`agentcore/project/${command}`}
              element={
                <ProjectCommandNotImplementedScreen ctx={ctx} core={core} command={command} />
              }
            />
          ))}
          <Route path="*" element={<HelpScreen ctx={ctx} core={core} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
