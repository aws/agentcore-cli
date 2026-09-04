import { test, expect, describe, afterEach } from "bun:test";
import type {
  GetAgentRuntimeResponse,
  GetApiKeyCredentialProviderResponse,
  GetGatewayResponse,
  GetHarnessResponse,
  GetMemoryOutput,
  GetOauth2CredentialProviderResponse,
  Harness,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  flatFrame,
  TestCoreClient,
} from "../../../testing";
import { buildHarnessLinkNodes } from "./screen";

afterEach(cleanupScreens);

// Behavior tests for the harness hub (get) screen and its JSON detail. The
// harness id comes from the route path; the hub fetches that single harness,
// shows a summary overlay, and offers actions that jump into the harness's
// flows.

// getResponse builds a GetHarnessResponse. The screens render whatever
// `harness` they receive, so a minimal shape (cast to the SDK's Harness) is
// enough to test behavior without constructing every field.
function getResponse(): GetHarnessResponse {
  return {
    harness: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
      executionRoleArn: "arn:aws:iam::123:role/MyRole",
      status: "READY",
      harnessVersion: "1",
      updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    },
  } as GetHarnessResponse;
}

function hubScreen() {
  const core = new TestCoreClient();
  core.harness.setGetResponse(getResponse());
  return { core, r: renderScreen("/agentcore/harness/get/MyHarness-abc123", { core }) };
}

describe("harness hub screen", () => {
  test("renders the summary overlay once loaded", async () => {
    const { r } = hubScreen();

    await waitForText(
      r.lastFrame,
      "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
    );
    const frame = r.lastFrame()!;
    expect(frame).toContain("MyHarness-abc123");
    expect(frame).toContain("READY");
    expect(frame).toMatch(/version\s+1/);
    r.unmount();
  });

  test("lists the harness actions", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    const frame = r.lastFrame()!;
    expect(frame).toContain("show the full JSON definition");
    expect(frame).toContain("endpoints");
    expect(frame).toContain("versions");
    expect(frame).toContain("invoke");
    expect(frame).toContain("exec");
    r.unmount();
  });

  test("fetches the harness id taken from the route path", async () => {
    const { core, r } = hubScreen();

    await waitFor(() => core.harness.calls.length > 0);
    const call = core.harness.calls.find((c) => c.method === "getHarness")!;
    expect(call.args[0]).toBe("MyHarness-abc123");
    r.unmount();
  });

  test("shows the error message when the get call fails", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("harness not found"));
    const r = renderScreen("/agentcore/harness/get/does-not-exist", { core });

    await waitForText(r.lastFrame, "Error:");
    expect(r.lastFrame()).toContain("harness not found");
    r.unmount();
  });

  test("enter on `detail` opens the JSON view", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → get → MyHarness-abc123 → json");
    expect(r.lastFrame()).toContain('"harnessName"');
    r.unmount();
  });

  test("up navigation returns to the previous action", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    await r.press("down");
    await r.press("up");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → get → MyHarness-abc123 → json");
    r.unmount();
  });

  test("enter on `endpoints` opens this harness's endpoint list", async () => {
    const { core, r } = hubScreen();
    core.harness.setListEndpointsResponse({
      endpoints: [
        {
          harnessId: "MyHarness-abc123",
          harnessName: "MyHarness",
          endpointName: "prod",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
          status: "READY",
          liveVersion: "1",
          targetVersion: "1",
          createdAt: new Date("2026-04-22T21:53:06.235Z"),
          updatedAt: new Date("2026-04-22T21:53:27.062Z"),
        },
      ],
    });

    await waitForText(r.lastFrame, "detail");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "prod");
    await waitFor(() => core.harness.calls.some((c) => c.method === "listHarnessEndpoints"));
    r.unmount();
  });

  test("enter on `invoke` opens the chat for this harness", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    await r.press("down"); // endpoints
    await r.press("down"); // versions
    await r.press("down"); // invoke
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → invoke → MyHarness-abc123");
    r.unmount();
  });

  test("bare `get` with no id redirects to the list screen", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [
        {
          harnessId: "MyHarness-abc123",
          harnessName: "MyHarness",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
          createdAt: new Date("2026-04-22T21:53:06.235Z"),
          updatedAt: new Date("2026-04-22T21:53:27.062Z"),
          harnessVersion: "1",
          status: "READY",
        },
      ],
    });
    const r = renderScreen("/agentcore/harness/get", { core });

    // The redirect lands on the list, which fetches harnesses.
    await waitForText(r.lastFrame, "MyHarness");
    await waitFor(() => core.harness.calls.some((c) => c.method === "listHarnesses"));
    r.unmount();
  });

  // A hub reached with ?region= (from project status) fetches there; its
  // actions must keep fetching there too.
  test("a hub opened with ?region= carries the region into its endpoint list", async () => {
    const core = new TestCoreClient();
    core.harness.setGetResponse(getResponse());
    core.harness.setListEndpointsResponse({ endpoints: [] });
    const r = renderScreen("/agentcore/harness/get/MyHarness-abc123?region=us-west-2", { core });

    await waitForText(r.lastFrame, "detail");
    const get = core.harness.calls.find((c) => c.method === "getHarness")!;
    expect(get.args[1]).toMatchObject({ region: "us-west-2" });

    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → endpoint → list → MyHarness-abc123");
    await waitFor(() => core.harness.calls.some((c) => c.method === "listHarnessEndpoints"));
    const list = core.harness.calls.find((c) => c.method === "listHarnessEndpoints")!;
    const options = list.args.find(
      (arg) => typeof arg === "object" && arg !== null && "region" in arg,
    );
    expect(options).toMatchObject({ region: "us-west-2" });
    r.unmount();
  });
});

// The linked resources live in us-west-2 while the test context's ambient
// region is us-east-1, so a forward navigation has to fetch where each ARN
// says rather than where the hub was opened.
const LINK_REGION = "us-west-2";
const LINK_ARN = `arn:aws:bedrock-agentcore:${LINK_REGION}:123`;
const RUNTIME_ID = "harness_MyHarness-Rt123456";
const MEMORY_ID = "harness_MyHarness_ab12-Mem12345";
const GATEWAY_ID = "tools-Gw1234567";
const API_KEY_ARN = `${LINK_ARN}:token-vault/default/apikeycredentialprovider/openai-key`;
const OAUTH2_ARN = `${LINK_ARN}:token-vault/default/oauth2credentialprovider/github-oauth`;

// linkedHarness is wired to everything the tree can list: the provisioned
// runtime, a managed memory, a gateway tool with OAuth outbound auth, a
// default browser tool, an OpenAI model with an API key — plus a remote MCP
// tool, which is not an AgentCore resource and must not appear.
function linkedHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    ...getResponse().harness!,
    environment: {
      agentCoreRuntimeEnvironment: {
        agentRuntimeArn: `${LINK_ARN}:runtime/${RUNTIME_ID}`,
        agentRuntimeName: "harness_MyHarness",
        agentRuntimeId: RUNTIME_ID,
      },
    },
    memory: { managedMemoryConfiguration: { arn: `${LINK_ARN}:memory/${MEMORY_ID}` } },
    tools: [
      {
        type: "agentcore_gateway",
        name: "tools",
        config: {
          agentCoreGateway: {
            gatewayArn: `${LINK_ARN}:gateway/${GATEWAY_ID}`,
            outboundAuth: { oauth: { providerArn: OAUTH2_ARN, scopes: ["repo"] } },
          },
        },
      },
      { type: "agentcore_browser", config: { agentCoreBrowser: {} } },
      {
        type: "remote_mcp",
        name: "docs_mcp",
        config: { remoteMcp: { url: "https://mcp.example" } },
      },
    ],
    model: { openAiModelConfig: { modelId: "gpt-4o", apiKeyArn: API_KEY_ARN } },
    ...overrides,
  } as Harness;
}

function linkedHubScreen(harness: Harness = linkedHarness()) {
  const core = new TestCoreClient();
  core.harness.setGetResponse({ harness });
  core.runtime.setGetResponse({
    agentRuntimeId: RUNTIME_ID,
    agentRuntimeArn: `${LINK_ARN}:runtime/${RUNTIME_ID}`,
    status: "READY",
  } as GetAgentRuntimeResponse);
  core.memory.setGetResponse({
    memory: {
      id: MEMORY_ID,
      name: "harness_MyHarness_ab12",
      arn: `${LINK_ARN}:memory/${MEMORY_ID}`,
      status: "ACTIVE",
    },
  } as GetMemoryOutput);
  core.gateway.setGetResponse({
    gatewayId: GATEWAY_ID,
    gatewayArn: `${LINK_ARN}:gateway/${GATEWAY_ID}`,
    status: "READY",
  } as GetGatewayResponse);
  core.identity.setGetApiKeyResponse({
    name: "openai-key",
    credentialProviderArn: API_KEY_ARN,
  } as GetApiKeyCredentialProviderResponse);
  core.identity.setGetOauth2Response({
    name: "github-oauth",
    credentialProviderArn: OAUTH2_ARN,
  } as GetOauth2CredentialProviderResponse);
  return { core, r: renderScreen("/agentcore/harness/get/MyHarness-abc123", { core }) };
}

// markedLines returns the lines carrying the ❯ focus marker.
function markedLines(frame: string | undefined): string[] {
  return (frame ?? "").split("\n").filter((line) => line.includes("❯"));
}

// The action list has six entries, so five downs reach `update` and the sixth
// crosses into the tree.
async function focusTree(r: ReturnType<typeof renderScreen>, row = 0) {
  for (let press = 0; press < 6 + row; press++) await r.press("down");
}

describe("harness hub linked resources", () => {
  test("lists one row per linked resource under a titled divider", async () => {
    const { r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    expect(r.lastFrame()).toContain("── linked resources ");
    const frame = flatFrame(r.lastFrame);
    expect(frame).toMatch(new RegExp(`runtime\\s+${RUNTIME_ID}`));
    expect(frame).toMatch(new RegExp(`memory\\s+${MEMORY_ID} managed`));
    expect(frame).toMatch(new RegExp(`gateway\\s+${GATEWAY_ID}`));
    expect(frame).toMatch(/oauth2 provider\s+github-oauth outbound auth/);
    expect(frame).toMatch(/browser\s+default aws default/);
    expect(frame).toMatch(/api key\s+openai-key model gpt-4o/);
    expect(frame).not.toContain("docs_mcp");
    r.unmount();
  });

  test("shows only the Runtime row for a harness with disabled memory and no tools", async () => {
    const { r } = linkedHubScreen(
      linkedHarness({
        memory: { disabled: {} },
        tools: [],
        model: { bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-4-6" } },
      }),
    );

    await waitForText(r.lastFrame, "linked resources");
    const frame = flatFrame(r.lastFrame);
    expect(frame).toMatch(new RegExp(`runtime\\s+${RUNTIME_ID}`));
    for (const type of ["memory", "gateway", "browser", "code interpreter", "api key"]) {
      expect(frame).not.toContain(type);
    }
    r.unmount();
  });

  test("down past the last action focuses the first tree row and up returns", async () => {
    const { r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    for (let press = 0; press < 5; press++) await r.press("down");
    expect(markedLines(r.lastFrame())).toHaveLength(1);
    expect(markedLines(r.lastFrame())[0]).toContain("update");

    await r.press("down");
    let marked = markedLines(r.lastFrame());
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("runtime");
    expect(marked[0]).not.toContain("update");

    // Down again moves within the tree, not the action list.
    await r.press("down");
    marked = markedLines(r.lastFrame());
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("memory");

    await r.press("up");
    await r.press("up");
    marked = markedLines(r.lastFrame());
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("update");
    r.unmount();
  });

  test("the marker is never shown twice while crossing the zones", async () => {
    const { r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    for (let press = 0; press < 8; press++) {
      await r.press("down");
      expect(markedLines(r.lastFrame())).toHaveLength(1);
    }
    for (let press = 0; press < 8; press++) {
      await r.press("up");
      expect(markedLines(r.lastFrame())).toHaveLength(1);
    }
    expect(markedLines(r.lastFrame())[0]).toContain("detail");
    r.unmount();
  });

  test("enter on the Runtime row opens the Runtime hub in the runtime ARN's region", async () => {
    const { core, r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r);
    await r.press("return");

    await waitForText(r.lastFrame, `agentcore → runtime → get → ${RUNTIME_ID}`);
    await waitForText(r.lastFrame, "READY");
    const call = core.runtime.calls.find(({ method }) => method === "getRuntime")!;
    expect(call.args[0]).toBe(RUNTIME_ID);
    expect(call.args[1]).toMatchObject({ region: LINK_REGION });
    r.unmount();
  });

  test("escape from a linked page returns to the hub with the tree", async () => {
    const { r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r);
    await r.press("return");
    await waitForText(r.lastFrame, `agentcore → runtime → get → ${RUNTIME_ID}`);

    await r.press("escape");
    // History-back re-renders the hub, which refetches the harness before the
    // tree is back.
    await waitForText(r.lastFrame, "linked resources");
    expect(r.lastFrame()).toContain("agentcore → harness → get → MyHarness-abc123");
    r.unmount();
  });

  test("enter on the Memory row opens the Memory hub", async () => {
    const { core, r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r, 1);
    await r.press("return");

    await waitForText(r.lastFrame, `agentcore → memory → get → ${MEMORY_ID}`);
    await waitForText(r.lastFrame, "ACTIVE");
    const call = core.memory.calls.find(({ method }) => method === "getMemory")!;
    expect(call.args[0]).toBe(MEMORY_ID);
    expect(call.args[2]).toMatchObject({ region: LINK_REGION });
    r.unmount();
  });

  test("enter on the Gateway row opens the Gateway hub", async () => {
    const { core, r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r, 2);
    await r.press("return");

    await waitForText(r.lastFrame, `agentcore → gateway → get → ${GATEWAY_ID}`);
    await waitFor(() => core.gateway.calls.some(({ method }) => method === "getGateway"));
    const call = core.gateway.calls.find(({ method }) => method === "getGateway")!;
    expect(call.args[0]).toBe(GATEWAY_ID);
    expect(call.args[1]).toMatchObject({ region: LINK_REGION });
    r.unmount();
  });

  test("enter on the nested OAuth2 Provider row opens that provider's hub", async () => {
    const { core, r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r, 3);
    expect(markedLines(r.lastFrame())[0]).toContain("oauth2 provider");
    await r.press("return");

    await waitForText(
      r.lastFrame,
      "agentcore → identity → oauth2-credential-provider → get → github-oauth",
    );
    await waitFor(() =>
      core.identity.calls.some(({ method }) => method === "getOauth2CredentialProvider"),
    );
    const call = core.identity.calls.find(
      ({ method }) => method === "getOauth2CredentialProvider",
    )!;
    expect(call.args[0]).toBe("github-oauth");
    expect(call.args[1]).toMatchObject({ region: LINK_REGION });
    r.unmount();
  });

  test("enter on the API Key row opens the API key credential provider hub by name", async () => {
    const { core, r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r, 5);
    expect(markedLines(r.lastFrame())[0]).toContain("api key");
    await r.press("return");

    await waitForText(
      r.lastFrame,
      "agentcore → identity → api-key-credential-provider → get → openai-key",
    );
    await waitFor(() =>
      core.identity.calls.some(({ method }) => method === "getApiKeyCredentialProvider"),
    );
    const call = core.identity.calls.find(
      ({ method }) => method === "getApiKeyCredentialProvider",
    )!;
    expect(call.args[0]).toBe("openai-key");
    expect(call.args[1]).toMatchObject({ region: LINK_REGION });
    r.unmount();
  });

  test("enter on the Browser row shows the no-detail hint and stays put", async () => {
    const { core, r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r, 4);
    expect(markedLines(r.lastFrame())[0]).toContain("browser");
    await r.press("return");

    await waitForText(r.lastFrame, "browser default has no detail view.");
    expect(r.lastFrame()).toContain("agentcore → harness → get → MyHarness-abc123");
    expect(r.lastFrame()).toContain("linked resources");
    expect(core.runtime.calls).toHaveLength(0);
    r.unmount();
  });

  test("the footer hints follow the focused zone", async () => {
    const { r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    expect(r.lastFrame()).toContain("select");
    expect(r.lastFrame()).not.toContain("collapse/expand");
    await focusTree(r);
    expect(r.lastFrame()).toContain("open");
    expect(r.lastFrame()).toContain("collapse/expand");
    r.unmount();
  });

  test("a linked runtime's region follows it into the runtime's detail JSON", async () => {
    const { core, r } = linkedHubScreen();

    await waitForText(r.lastFrame, "linked resources");
    await focusTree(r);
    await r.press("return");
    await waitForText(r.lastFrame, `agentcore → runtime → get → ${RUNTIME_ID}`);
    await waitForText(r.lastFrame, "show the full JSON definition");
    // invoke → shell → endpoints → versions → detail
    for (let press = 0; press < 4; press++) await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, `agentcore → runtime → get → ${RUNTIME_ID} → json`);
    await waitForText(r.lastFrame, '"agentRuntimeId"');
    const fetches = core.runtime.calls.filter(({ method }) => method === "getRuntime");
    expect(fetches.length).toBeGreaterThanOrEqual(2);
    for (const fetch of fetches) expect(fetch.args[1]).toMatchObject({ region: LINK_REGION });
    r.unmount();
  });
});

describe("buildHarnessLinkNodes", () => {
  const FALLBACK = "us-east-1";

  test("orders the rows and nests the OAuth2 provider under its gateway", () => {
    const nodes = buildHarnessLinkNodes(linkedHarness(), FALLBACK);

    expect(nodes.map((node) => node.id)).toEqual([
      "runtime",
      "memory",
      "tool:0",
      "tool:1",
      "model-key",
    ]);
    const gateway = nodes[2]!;
    expect(gateway.defaultExpanded).toBe(true);
    expect(gateway.children?.map((node) => node.id)).toEqual(["tool:0/oauth"]);
    expect(gateway.children?.[0]?.label).toContain("oauth2 provider");
    expect(gateway.children?.[0]?.annotation).toBe("outbound auth");
  });

  test("links each row to its detail route in the region of its ARN", () => {
    const nodes = buildHarnessLinkNodes(linkedHarness(), FALLBACK);
    const routes = Object.fromEntries(nodes.map((node) => [node.id, node.data?.route]));

    expect(routes.runtime).toBe(`/agentcore/runtime/get/${RUNTIME_ID}?region=${LINK_REGION}`);
    expect(routes.memory).toBe(`/agentcore/memory/get/${MEMORY_ID}?region=${LINK_REGION}`);
    expect(routes["tool:0"]).toBe(`/agentcore/gateway/get/${GATEWAY_ID}?region=${LINK_REGION}`);
    expect(routes["model-key"]).toBe(
      `/agentcore/identity/api-key-credential-provider/get/openai-key?region=${LINK_REGION}`,
    );
    expect(nodes[2]?.children?.[0]?.data?.route).toBe(
      `/agentcore/identity/oauth2-credential-provider/get/github-oauth?region=${LINK_REGION}`,
    );
  });

  test("gives Browser and Code Interpreter rows a hint instead of a route", () => {
    const nodes = buildHarnessLinkNodes(
      linkedHarness({
        tools: [
          {
            type: "agentcore_code_interpreter",
            name: "sandbox",
            config: {
              agentCoreCodeInterpreter: {
                codeInterpreterArn: `${LINK_ARN}:code-interpreter/ci-123`,
              },
            },
          },
          {
            type: "agentcore_browser",
            name: "aws_browser_v1",
            config: {
              agentCoreBrowser: {
                browserArn: "arn:aws:bedrock-agentcore:us-east-1:aws:browser/aws.browser.v1",
              },
            },
          },
          { type: "agentcore_browser", config: { agentCoreBrowser: {} } },
        ],
      }),
      FALLBACK,
    );
    const tools = nodes.filter((node) => node.id.startsWith("tool:"));

    // Browsers come before Code Interpreters regardless of tools[] order.
    expect(tools.map((node) => node.id)).toEqual(["tool:1", "tool:2", "tool:0"]);
    expect(tools[0]?.label).toMatch(/browser\s+aws\.browser\.v1$/);
    expect(tools[0]?.annotation).toBe("aws default");
    expect(tools[1]?.label).toMatch(/browser\s+default$/);
    expect(tools[1]?.annotation).toBe("aws default");
    expect(tools[1]?.data).toEqual({ hint: "browser default has no detail view." });
    expect(tools[2]?.label).toMatch(/code interpreter\s+ci-123$/);
    expect(tools[2]?.annotation).toBeUndefined();
    expect(tools[2]?.data).toEqual({ hint: "code interpreter ci-123 has no detail view." });
  });

  test("keeps the name column aligned across the tree", () => {
    const nodes = buildHarnessLinkNodes(
      linkedHarness({
        tools: [
          ...linkedHarness().tools!,
          { type: "agentcore_code_interpreter", config: { agentCoreCodeInterpreter: {} } },
        ],
      }),
      FALLBACK,
    );
    const column = (label: string) => label.search(/\S+$/);

    // TreeView draws four guide characters ("│ └─") before a row nested under
    // a top-level one, so the nested "oauth2 provider" is the widest entry:
    // every top-level name starts after it plus two spaces, and the nested
    // row gives those four columns back so its name lands in the same place.
    const nestedGuides = 4;
    const width = "oauth2 provider".length + nestedGuides + 2;
    for (const node of nodes) expect(column(node.label)).toBe(width);
    expect(column(nodes[2]!.children![0]!.label)).toBe(width - nestedGuides);
  });

  test("annotates an attached memory and omits a disabled or absent one", () => {
    const attached = buildHarnessLinkNodes(
      linkedHarness({
        memory: { agentCoreMemoryConfiguration: { arn: `${LINK_ARN}:memory/${MEMORY_ID}` } },
      }),
      FALLBACK,
    );
    expect(attached.find((node) => node.id === "memory")?.annotation).toBe("attached");

    const disabled = buildHarnessLinkNodes(linkedHarness({ memory: { disabled: {} } }), FALLBACK);
    expect(disabled.some((node) => node.id === "memory")).toBe(false);

    const absent = buildHarnessLinkNodes(linkedHarness({ memory: undefined }), FALLBACK);
    expect(absent.some((node) => node.id === "memory")).toBe(false);
  });

  test("falls back to the harness's region when an ARN carries none", () => {
    const nodes = buildHarnessLinkNodes(
      linkedHarness({
        environment: {
          agentCoreRuntimeEnvironment: {
            agentRuntimeId: RUNTIME_ID,
            agentRuntimeName: "harness_MyHarness",
          },
        },
      } as Partial<Harness>),
      FALLBACK,
    );

    expect(nodes[0]?.data?.route).toBe(`/agentcore/runtime/get/${RUNTIME_ID}?region=${FALLBACK}`);
  });

  test("lists a git skill's API key provider annotated with the skill", () => {
    const nodes = buildHarnessLinkNodes(
      linkedHarness({
        model: { bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-4-6" } },
        skills: [
          { path: "/skills/local" },
          {
            git: {
              url: "https://github.com/acme/skills.git",
              path: "skills/search",
              auth: { credentialArn: API_KEY_ARN },
            },
          },
          {
            git: {
              url: "https://github.com/acme/private.git",
              auth: { credentialArn: OAUTH2_ARN },
            },
          },
        ],
      }),
      FALLBACK,
    );
    const keys = nodes.filter((node) => node.id.startsWith("skill:"));

    expect(keys.map((node) => node.id)).toEqual(["skill:1/key", "skill:2/key"]);
    expect(keys[0]?.label).toMatch(/api key\s+openai-key$/);
    expect(keys[0]?.annotation).toBe("skill skills/search");
    expect(keys[0]?.data?.route).toBe(
      `/agentcore/identity/api-key-credential-provider/get/openai-key?region=${LINK_REGION}`,
    );
    expect(keys[1]?.label).toMatch(/oauth2 provider\s+github-oauth$/);
    expect(keys[1]?.annotation).toBe("skill https://github.com/acme/private.git");
    expect(nodes.some((node) => node.id === "model-key")).toBe(false);
  });

  test("skips inline-function and remote-MCP tools", () => {
    const nodes = buildHarnessLinkNodes(
      linkedHarness({
        tools: [
          {
            type: "remote_mcp",
            name: "docs",
            config: { remoteMcp: { url: "https://mcp.example" } },
          },
          {
            type: "inline_function",
            name: "add",
            config: { inlineFunction: { description: "adds", inputSchema: {} } },
          },
        ],
      }),
      FALLBACK,
    );

    expect(nodes.some((node) => node.id.startsWith("tool:"))).toBe(false);
  });
});

describe("harness JSON detail screen", () => {
  test("wraps long JSON values instead of truncating them", async () => {
    const longPrompt = `${"reply sarcastically but accurately and concisely ".repeat(5)}WRAP_SENTINEL`;
    const response = getResponse();
    response.harness!.systemPrompt = [{ text: longPrompt }];

    const core = new TestCoreClient();
    core.harness.setGetResponse(response);
    const r = renderScreen("/agentcore/harness/get/MyHarness-abc123/json", { core });

    await waitForText(r.lastFrame, "WRAP_SENTINEL");
    r.unmount();
  });

  test("renders the harness JSON and scrolls without crashing", async () => {
    const core = new TestCoreClient();
    core.harness.setGetResponse(getResponse());
    const r = renderScreen("/agentcore/harness/get/MyHarness-abc123/json", { core });

    await waitForText(r.lastFrame, '"harnessName"');
    await r.press("down");
    await r.press("up");
    await r.write("j");
    await r.write("k");
    expect(r.lastFrame()).toContain('"harnessName"');
    r.unmount();
  });
});
