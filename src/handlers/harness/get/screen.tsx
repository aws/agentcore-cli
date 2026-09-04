import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import type { Harness, HarnessTool } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../../types";
import { useCoreOpts, useRegionNavigate } from "../../utils";
import {
  credentialProviderTypeFromArn,
  parseArn,
  regionFromArn,
  resourceNameFromArn,
  serviceIdFromArn,
  type CredentialProviderType,
} from "../../../core/arn";
import { JsonDetail } from "../../../components/JsonDetail";
import {
  linkedResourceLabel,
  typeColumnWidth,
  type LinkedResourceNode,
} from "../../../components/LinkedResources";
import { ResourceDetailScreen } from "../../../components/ResourceDetailScreen";

// The actions offered for a harness, in menu order. Each routes into the
// corresponding flow with the harness preselected.
const ACTIONS: { name: string; description: string; to: (id: string) => string }[] = [
  {
    name: "detail",
    description: "show the full JSON definition",
    to: (id) => `/agentcore/harness/get/${id}/json`,
  },
  {
    name: "endpoints",
    description: "list this harness's endpoints",
    to: (id) => `/agentcore/harness/endpoint/list/${id}`,
  },
  {
    name: "versions",
    description: "list this harness's versions",
    to: (id) => `/agentcore/harness/version/list/${id}`,
  },
  {
    name: "invoke",
    description: "chat with this harness",
    to: (id) => `/agentcore/harness/invoke/${id}`,
  },
  {
    name: "exec",
    description: "run shell commands in this harness",
    to: (id) => `/agentcore/harness/exec/${id}`,
  },
  {
    name: "update",
    description: "update this harness",
    to: (id) => `/agentcore/harness/update/${id}`,
  },
];

// The detail routes a linked resource forwards to, by the id the route takes.
// Browsers and Code Interpreters have no detail screen and get a hint instead.
const DETAIL_ROUTES = {
  runtime: (id: string) => `/agentcore/runtime/get/${encodeURIComponent(id)}`,
  memory: (id: string) => `/agentcore/memory/get/${encodeURIComponent(id)}`,
  gateway: (id: string) => `/agentcore/gateway/get/${encodeURIComponent(id)}`,
  "api-key": (name: string) =>
    `/agentcore/identity/api-key-credential-provider/get/${encodeURIComponent(name)}`,
  oauth2: (name: string) =>
    `/agentcore/identity/oauth2-credential-provider/get/${encodeURIComponent(name)}`,
} as const;

const CREDENTIAL_PROVIDER_TYPES: Record<CredentialProviderType, string> = {
  "api-key": "api key",
  oauth2: "oauth2 provider",
};

// A resource the harness is wired to, before it becomes a tree row.
interface HarnessLink {
  id: string;
  type: string;
  name: string;
  annotation?: string;
  // The detail route (without a region); unset rows show a hint instead.
  route?: string;
  // The ARN the resource's region is read from.
  arn?: string;
  children?: HarnessLink[];
}

function credentialLink(id: string, arn: string, annotation: string): HarnessLink | undefined {
  // The ARN is all a linking resource carries, so it decides between the two
  // credential provider screens; anything else under the vault is skipped.
  const providerType = credentialProviderTypeFromArn(arn);
  if (!providerType) return undefined;
  const name = resourceNameFromArn(arn);
  return {
    id,
    type: CREDENTIAL_PROVIDER_TYPES[providerType],
    name,
    annotation,
    route: DETAIL_ROUTES[providerType](name),
    arn,
  };
}

// managedToolLink describes a Browser or Code Interpreter tool. An unset ARN
// means the AWS-managed default; the service also reports that default by an
// ARN under the `aws` account.
function managedToolLink(
  id: string,
  type: string,
  tool: HarnessTool,
  arn: string | undefined,
): HarnessLink {
  const awsDefault = !arn || parseArn(arn)?.account === "aws";
  return {
    id,
    type,
    name: arn ? serviceIdFromArn(arn) : (tool.name ?? "default"),
    annotation: awsDefault ? "aws default" : undefined,
    arn,
  };
}

// collectLinks reads the linked resources out of a GetHarness response, in
// display order: the Runtime the service provisioned under the harness, its
// Memory, then the AgentCore tools (Gateways with their outbound OAuth2
// provider nested beneath, Browsers, Code Interpreters) and finally the
// credential providers the model and git-backed skills authenticate with.
// Inline-function and remote-MCP tools are not AgentCore resources and are
// left out.
function collectLinks(harness: Harness): HarnessLink[] {
  const links: HarnessLink[] = [];

  const runtime = harness.environment?.agentCoreRuntimeEnvironment;
  if (runtime?.agentRuntimeId) {
    links.push({
      id: "runtime",
      type: "runtime",
      name: runtime.agentRuntimeId,
      route: DETAIL_ROUTES.runtime(runtime.agentRuntimeId),
      arn: runtime.agentRuntimeArn,
    });
  }

  // A disabled memory (or one not yet provisioned) has nothing to open.
  const managedMemoryArn = harness.memory?.managedMemoryConfiguration?.arn;
  const memoryArn = managedMemoryArn ?? harness.memory?.agentCoreMemoryConfiguration?.arn;
  if (memoryArn) {
    const memoryId = serviceIdFromArn(memoryArn);
    links.push({
      id: "memory",
      type: "memory",
      name: memoryId,
      annotation: managedMemoryArn ? "managed" : "attached",
      route: DETAIL_ROUTES.memory(memoryId),
      arn: memoryArn,
    });
  }

  const tools = harness.tools ?? [];
  tools.forEach((tool, index) => {
    const gateway = tool.config?.agentCoreGateway;
    if (!gateway?.gatewayArn) return;
    const gatewayId = serviceIdFromArn(gateway.gatewayArn);
    const providerArn = gateway.outboundAuth?.oauth?.providerArn;
    const provider = providerArn
      ? credentialLink(`tool:${index}/oauth`, providerArn, "outbound auth")
      : undefined;
    links.push({
      id: `tool:${index}`,
      type: "gateway",
      name: gatewayId,
      route: DETAIL_ROUTES.gateway(gatewayId),
      arn: gateway.gatewayArn,
      children: provider ? [provider] : undefined,
    });
  });
  tools.forEach((tool, index) => {
    const browser = tool.config?.agentCoreBrowser;
    if (browser) links.push(managedToolLink(`tool:${index}`, "browser", tool, browser.browserArn));
  });
  tools.forEach((tool, index) => {
    const interpreter = tool.config?.agentCoreCodeInterpreter;
    if (interpreter) {
      links.push(
        managedToolLink(`tool:${index}`, "code interpreter", tool, interpreter.codeInterpreterArn),
      );
    }
  });

  const model = harness.model;
  const keyedModel =
    model?.openAiModelConfig ?? model?.geminiModelConfig ?? model?.liteLlmModelConfig;
  if (keyedModel?.apiKeyArn) {
    const link = credentialLink(
      "model-key",
      keyedModel.apiKeyArn,
      keyedModel.modelId ? `model ${keyedModel.modelId}` : "model",
    );
    if (link) links.push(link);
  }

  (harness.skills ?? []).forEach((skill, index) => {
    const git = skill.git;
    const credentialArn = git?.auth?.credentialArn;
    if (!git || !credentialArn) return;
    // A git skill has no name of its own; its path in the repository (or the
    // repository itself) is what identifies it.
    const skillName = git.path ?? git.url;
    const link = credentialLink(
      `skill:${index}/key`,
      credentialArn,
      skillName ? `skill ${skillName}` : "skill",
    );
    if (link) links.push(link);
  });

  return links;
}

// guideDepthOf counts the two-character guide steps TreeView draws before a
// row at `depth`: none on the top level, then one per ancestor plus the branch
// itself.
function guideDepthOf(depth: number): number {
  return depth === 0 ? 0 : depth + 1;
}

function flattenLinks(links: HarnessLink[], depth = 0): { link: HarnessLink; depth: number }[] {
  return links.flatMap((link) => [
    { link, depth },
    ...flattenLinks(link.children ?? [], depth + 1),
  ]);
}

// buildHarnessLinkNodes maps a GetHarness response to the rows of the hub's
// Linked Resources tree. Each row with a detail screen links there with
// ?region= taken from the resource's own ARN, so it opens where it lives (see
// useCoreOpts); `fallbackRegion` — the region the harness itself was fetched
// in — covers ARNs without one. Rows without a detail screen carry a hint.
export function buildHarnessLinkNodes(
  harness: Harness,
  fallbackRegion: string,
): LinkedResourceNode[] {
  const links = collectLinks(harness);
  const typeWidth = typeColumnWidth(
    flattenLinks(links).map(({ link, depth }) => ({
      type: link.type,
      guideDepth: guideDepthOf(depth),
    })),
    10,
  );

  const toNode = (link: HarnessLink, depth: number): LinkedResourceNode => {
    const children = link.children?.map((child) => toNode(child, depth + 1));
    const region = (link.arn && regionFromArn(link.arn)) || fallbackRegion;
    return {
      id: link.id,
      label: linkedResourceLabel(link.type, link.name, typeWidth, guideDepthOf(depth)),
      annotation: link.annotation,
      ...(children?.length ? { defaultExpanded: true, children } : {}),
      data: link.route
        ? { route: `${link.route}?region=${encodeURIComponent(region)}` }
        : { hint: `${link.type} ${link.name} has no detail view.` },
    };
  };

  return links.map((link) => toNode(link, 0));
}

// The harness ID comes from the `:harnessId` route path value; the fetch
// honours a ?region= link (see useCoreOpts) and reports the region it used so
// the linked rows can fall back to it.
function useHarnessDetail({ ctx, core }: ScreenProps, harnessId: string | undefined) {
  const opts = useCoreOpts(ctx);
  const query = useQuery({
    queryKey: ["harness", opts.region, harnessId],
    queryFn: () => core.harness.getHarness(harnessId!, opts),
    enabled: harnessId !== undefined,
  });
  return { query, region: opts.region };
}

// HarnessGetScreen is the hub for a single harness: a summary overlay (name,
// ARN, execution role, status) above an action selector that jumps into the
// harness's flows (detail JSON, endpoints, versions, invoke, exec, update),
// followed by a Linked Resources tree of what the harness is wired to — the
// Runtime provisioned underneath it, its managed or attached Memory, Gateway
// (with its outbound OAuth2 provider), Browser and Code Interpreter tools, and
// the API key providers behind the model and git-backed skills. Enter on a
// linked row opens that resource's own hub in the region its ARN names.
export function HarnessGetScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { harnessId } = useParams();
  const { query: detail, region } = useHarnessDetail(props, harnessId);
  const harness = detail.data?.harness;

  const linkedNodes = useMemo(
    () => (harness ? buildHarnessLinkNodes(harness, region) : []),
    [harness, region],
  );

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "harness", "get", harnessId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: harness?.harnessId ?? "",
        status: harness?.status ?? "",
        version: harness?.harnessVersion?.toString() ?? "0",
        arn: harness?.arn ?? "",
      }}
      actions={
        harnessId && harness
          ? ACTIONS.map((action) => ({
              name: action.name,
              description: action.description,
              onSelect: () => navigate(action.to(harnessId)),
            }))
          : []
      }
      loadingLabel="loading harness…"
      linkedResources={{ nodes: linkedNodes }}
      onRetry={() => void detail.refetch()}
    />
  );
}

// HarnessGetJsonScreen renders the harness's full definition as scrollable JSON
// (the hub's "detail" action).
export function HarnessGetJsonScreen(props: ScreenProps) {
  const { harnessId } = useParams();
  const { query: detail } = useHarnessDetail(props, harnessId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "harness", "get", harnessId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data?.harness}
      loadingLabel="loading harness…"
      onRetry={() => void detail.refetch()}
    />
  );
}
