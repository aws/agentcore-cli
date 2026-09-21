import { afterEach, describe, expect, test } from "bun:test";
import type {
  ApiKeyCredentialProviderItem,
  GetApiKeyCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { QueryClient } from "@tanstack/react-query";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  tick,
  waitFor,
  waitForText,
  menuEntries,
} from "../../../testing";

afterEach(cleanupScreens);

const endpointUrl = "https://identity.test";

function providerItem(
  overrides: Partial<ApiKeyCredentialProviderItem> = {},
): ApiKeyCredentialProviderItem {
  return {
    name: "api-key-1",
    credentialProviderArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/api-key-1",
    createdTime: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedTime: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function getResponse(
  overrides: Partial<GetApiKeyCredentialProviderResponse> = {},
): GetApiKeyCredentialProviderResponse {
  return {
    name: "api-key-1",
    credentialProviderArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/api-key-1",
    apiKeySecretArn: {
      secretArn:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/apikey/api-key-1",
    },
    apiKeySecretSource: "MANAGED",
    createdTime: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedTime: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  } as GetApiKeyCredentialProviderResponse;
}

function coreWithProviders(providers: ApiKeyCredentialProviderItem[]): TestCoreClient {
  const core = new TestCoreClient();
  core.identity.setListApiKeyResponse({ credentialProviders: providers });
  return core;
}

describe("API key credential provider menu", () => {
  test("lists the read-only commands, then the rest as command line only", async () => {
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider");

    await waitForText(screen.lastFrame, "get an API key credential provider");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["get", "list"],
      cliOnly: ["create", "update", "delete"],
    });
  });
});

describe("API key credential provider picker", () => {
  test("renders provider name, created, and updated times", async () => {
    const core = coreWithProviders([
      providerItem({
        name: "visible-provider",
        createdTime: new Date("2026-07-18T00:00:00.000Z"),
        lastUpdatedTime: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/list", { core });

    await waitForText(screen.lastFrame, "visible-provider");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("name");
    expect(frame).toContain("created UTC");
    expect(frame).toContain("updated UTC");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("calls listApiKeyCredentialProviders with exact Core options", async () => {
    const core = coreWithProviders([providerItem()]);
    renderScreen("/agentcore/identity/api-key-credential-provider/list", { core, endpointUrl });

    await waitFor(() =>
      core.identity.calls.some((call) => call.method === "listApiKeyCredentialProviders"),
    );
    expect(
      core.identity.calls.filter((call) => call.method === "listApiKeyCredentialProviders"),
    ).toEqual([
      {
        method: "listApiKeyCredentialProviders",
        args: [undefined, expect.any(Number), { region: "us-east-1", endpointUrl }],
      },
    ]);
  });

  test("fills a tall terminal past the service's 20-item page", async () => {
    const core = coreWithProviders(
      Array.from({ length: 25 }, (_, index) => providerItem({ name: `provider-${index + 1}` })),
    );
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/list", { core });
    // Core assembles a page taller than one service page, so the picker asks for
    // as many rows as the terminal holds and shows them all.
    await screen.resize(120, 60);

    await waitForText(screen.lastFrame, "provider-25");
    const pageSizes = core.identity.calls
      .filter((call) => call.method === "listApiKeyCredentialProviders")
      .map((call) => call.args[1] as number);
    expect(pageSizes.at(-1)).toBeGreaterThan(20);
    expect(screen.lastFrame()).not.toContain("more →");
  });

  test("shows first-page and later-page empty states", async () => {
    const empty = renderScreen("/agentcore/identity/api-key-credential-provider/list");
    await waitForText(empty.lastFrame, "No API key credential providers found in this Region.");
    empty.unmount();

    const core = new TestCoreClient();
    core.identity.setListApiKeyResponse({
      credentialProviders: [providerItem({ name: "page-one" })],
      nextToken: "page-2",
    });
    core.identity.setListApiKeyResponse({ credentialProviders: [] }, "page-2");
    const paged = renderScreen("/agentcore/identity/api-key-credential-provider/list", { core });

    await waitForText(paged.lastFrame, "page 1 · more →");
    await paged.write("l");
    await waitForText(paged.lastFrame, "No API key credential providers on this page.");
    expect(paged.lastFrame()).not.toContain(
      "No API key credential providers found in this Region.",
    );
  });

  test("bare get redirects to the picker", async () => {
    const core = coreWithProviders([providerItem({ name: "redirected" })]);
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/get", { core });

    await waitForText(screen.lastFrame, "redirected");
    expect(core.identity.calls[0]?.method).toBe("listApiKeyCredentialProviders");
  });

  test("selection opens the matching provider detail", async () => {
    const name = "api key blue";
    const core = coreWithProviders([providerItem({ name })]);
    core.identity.setGetApiKeyResponse(getResponse({ name }));
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/list", { core });

    await waitForText(screen.lastFrame, name);
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → identity → api-key-credential-provider → get → ${name}`,
    );
    await waitFor(() =>
      core.identity.calls.some(
        (call) => call.method === "getApiKeyCredentialProvider" && call.args[0] === name,
      ),
    );
  });
});

describe("API key credential provider detail", () => {
  test("renders a resource summary with only the detail action", async () => {
    const core = new TestCoreClient();
    core.identity.setGetApiKeyResponse(getResponse());
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/get/api-key-1", {
      core,
      endpointUrl,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("api-key-1");
    expect(frame).toMatch(/secretSource\s+MANAGED/);
    expect(frame).toContain("arn:aws:bedrock-agentcore");
    // The only action is "detail"; mutations are CLI-only, never surfaced here.
    expect(frame).toContain("❯ detail");
    expect(
      core.identity.calls.find((call) => call.method === "getApiKeyCredentialProvider"),
    ).toEqual({
      method: "getApiKeyCredentialProvider",
      args: ["api-key-1", { region: "us-east-1", endpointUrl }],
    });
  });

  test("opens the complete provider JSON", async () => {
    const core = new TestCoreClient();
    core.identity.setGetApiKeyResponse(getResponse());
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/get/api-key-1", {
      core,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "agentcore → identity → api-key-credential-provider → get → api-key-1 → json",
    );
    expect(screen.lastFrame()).toContain('"credentialProviderArn"');
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.identity.setError(new Error("provider unavailable"));
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/get/api-key-1", {
      core,
    });

    await waitForText(screen.lastFrame, "provider unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.identity.setError(undefined);
    core.identity.setGetApiKeyResponse(getResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });

  test("does not open cached detail after a background refresh fails", async () => {
    const core = new TestCoreClient();
    core.identity.setGetApiKeyResponse(getResponse());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
    });
    const screen = renderScreen("/agentcore/identity/api-key-credential-provider/get/api-key-1", {
      core,
      queryClient,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    core.identity.setError(new Error("background refresh failed"));
    await queryClient.invalidateQueries({
      queryKey: ["api-key-credential-provider", "us-east-1", "api-key-1"],
    });
    await waitForText(screen.lastFrame, "background refresh failed");

    await screen.press("return");
    await tick();
    expect(screen.lastFrame()).toContain(
      "agentcore → identity → api-key-credential-provider → get → api-key-1",
    );
    expect(screen.lastFrame()).not.toContain("→ json");
  });
});
