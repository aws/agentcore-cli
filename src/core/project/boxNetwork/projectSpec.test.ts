import { describe, expect, test } from "bun:test";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { buildBoxNetwork, type BoxNetworkHost } from "./network";
import { parsePolicyFiles } from "./policyParser";
import { gatewayTargetFor, outboundAuthText, sameOutboundAuth } from "./projectSpec";

/** The hosts of `egress`, with the rules the box CLI adds for it. */
function hostsOf(egress: Record<string, unknown>): BoxNetworkHost[] {
  const { parsed } = parsePolicyFiles({ egress, mcp: {}, policyFiles: [] }, []);
  const runtime = { name: "agent" } as ProjectRuntime;
  const spec = { credentials: [], agentCoreGateways: [], memories: [] } as never;
  const network = buildBoxNetwork(parsed, [], {
    spec,
    runtime,
    gateway: "agent-box",
    targets: [],
    grantedActions: [],
  });
  if (network.failures.length > 0) throw new Error(JSON.stringify(network.failures));
  return [...network.hosts];
}

/** A Box project whose Box gateway holds the hosts' targets, and the credentials build declares. */
function projectWith(nodes: BoxNetworkHost[]) {
  const targets = nodes.flatMap((n) =>
    n.target === undefined ? [] : [gatewayTargetFor({ ...n, target: n.target })],
  );
  return {
    targets,
    spec: {
      name: "BoxProject",
      version: 2,
      projectType: "box",
      credentials: nodes.flatMap((node) =>
        node.outboundAuth.kind === "apiKey"
          ? [{ authorizerType: "ApiKeyCredentialProvider", name: node.outboundAuth.credentialName }]
          : [],
      ),
      agentCoreGateways: [
        {
          name: "agent-box",
          protocolType: "None",
          authorizerType: "AWS_IAM",
          enableSemanticSearch: true,
          exceptionLevel: "NONE",
          targets,
        },
      ],
    },
  };
}

const SIGNED_AND_KEYED = {
  bedrock: {
    destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
    secret: { ref: "aws://agentcore-runtime" },
  },
  github: {
    destinations: ["api.github.com"],
    secret: { ref: "env://GITHUB_TOKEN" },
  },
};

describe("gatewayTargetFor", () => {
  test("gives passthrough targets with no schema, which the project schema accepts", () => {
    const { targets, spec } = projectWith(hostsOf(SIGNED_AND_KEYED));
    expect(ProjectSpecSchema.safeParse(spec).error?.issues ?? []).toEqual([]);
    expect(targets).toEqual([
      {
        name: "egress-bedrock",
        targetType: "passthrough",
        passthrough: {
          endpoint: "https://bedrock-runtime.us-west-2.amazonaws.com",
          protocolType: "CUSTOM",
        },
        outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock", region: "us-west-2" },
      },
      {
        name: "egress-github",
        targetType: "passthrough",
        passthrough: { endpoint: "https://api.github.com", protocolType: "CUSTOM" },
        outboundAuth: {
          type: "API_KEY",
          credentialName: "github",
          location: "HEADER",
          parameterName: "Authorization",
          prefix: "Bearer",
        },
      },
    ]);
  });

  test("gives a target with no outbound auth, and one on another port", () => {
    const { targets, spec } = projectWith(
      hostsOf({ public: { destinations: ["api.example.com:1012"] } }),
    );
    expect(targets).toEqual([
      {
        name: "egress-public",
        targetType: "passthrough",
        passthrough: { endpoint: "https://api.example.com:1012", protocolType: "CUSTOM" },
      },
    ]);
    expect(ProjectSpecSchema.safeParse(spec).error?.issues ?? []).toEqual([]);
  });

  test("sends a custom header's key with no prefix", () => {
    const hosts = hostsOf({
      search: {
        destinations: ["api.search.example"],
        secret: { ref: "env://SEARCH_KEY", header: "x-api-key" },
      },
    });
    expect(projectWith(hosts).targets[0]!.outboundAuth).toEqual({
      type: "API_KEY",
      credentialName: "search",
      location: "HEADER",
      parameterName: "x-api-key",
    });
  });
});

describe("sameOutboundAuth", () => {
  test("treats no auth as NONE and a missing API key location as a header", () => {
    expect(sameOutboundAuth(undefined, { type: "NONE" })).toBe(true);
    expect(
      sameOutboundAuth(
        { type: "API_KEY", credentialName: "k", parameterName: "x-api-key" },
        { type: "API_KEY", credentialName: "k", location: "HEADER", parameterName: "x-api-key" },
      ),
    ).toBe(true);
    expect(
      sameOutboundAuth(
        { type: "GATEWAY_IAM_ROLE", service: "bedrock", region: "us-west-2" },
        { type: "GATEWAY_IAM_ROLE", service: "bedrock", region: "us-east-1" },
      ),
    ).toBe(false);
    expect(outboundAuthText(undefined)).toBe("NONE");
  });
});
