import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetOauth2CredentialProviderResponse,
  Oauth2CredentialProviderItem,
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
  overrides: Partial<Oauth2CredentialProviderItem> = {},
): Oauth2CredentialProviderItem {
  return {
    name: "oauth2-1",
    credentialProviderVendor: "CustomOauth2",
    credentialProviderArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/oauth2credentialprovider/oauth2-1",
    createdTime: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedTime: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function getResponse(
  overrides: Partial<GetOauth2CredentialProviderResponse> = {},
): GetOauth2CredentialProviderResponse {
  return {
    name: "oauth2-1",
    credentialProviderVendor: "CustomOauth2",
    credentialProviderArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/oauth2credentialprovider/oauth2-1",
    clientSecretArn: {
      secretArn:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/oauth2/oauth2-1",
    },
    clientSecretSource: "MANAGED",
    callbackUrl: "https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/abc",
    createdTime: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedTime: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  } as GetOauth2CredentialProviderResponse;
}

function coreWithProviders(providers: Oauth2CredentialProviderItem[]): TestCoreClient {
  const core = new TestCoreClient();
  core.identity.setListOauth2Response({ credentialProviders: providers });
  return core;
}

describe("OAuth2 credential provider menu", () => {
  test("lists the read-only commands, then the rest as command line only", async () => {
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider");

    await waitForText(screen.lastFrame, "get an OAuth2 credential provider");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["get", "list"],
      cliOnly: ["create", "update", "delete"],
    });
  });
});

describe("OAuth2 credential provider picker", () => {
  test("renders provider name, vendor, created, and updated times", async () => {
    const core = coreWithProviders([
      providerItem({
        name: "visible-provider",
        credentialProviderVendor: "GithubOauth2",
        lastUpdatedTime: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/list", { core });

    await waitForText(screen.lastFrame, "visible-provider");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("name");
    expect(frame).toContain("vendor");
    expect(frame).toContain("GithubOauth2");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("calls listOauth2CredentialProviders with exact Core options", async () => {
    const core = coreWithProviders([providerItem()]);
    renderScreen("/agentcore/identity/oauth2-credential-provider/list", { core, endpointUrl });

    await waitFor(() =>
      core.identity.calls.some((call) => call.method === "listOauth2CredentialProviders"),
    );
    expect(
      core.identity.calls.filter((call) => call.method === "listOauth2CredentialProviders"),
    ).toEqual([
      {
        method: "listOauth2CredentialProviders",
        args: [undefined, expect.any(Number), { region: "us-east-1", endpointUrl }],
      },
    ]);
  });

  test("fills a tall terminal past the service's 20-item page", async () => {
    const core = coreWithProviders(
      Array.from({ length: 25 }, (_, index) => providerItem({ name: `provider-${index + 1}` })),
    );
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/list", { core });
    // Core assembles a page taller than one service page, so the picker asks for
    // as many rows as the terminal holds and shows them all.
    await screen.resize(120, 60);

    await waitForText(screen.lastFrame, "provider-25");
    const pageSizes = core.identity.calls
      .filter((call) => call.method === "listOauth2CredentialProviders")
      .map((call) => call.args[1] as number);
    expect(pageSizes.at(-1)).toBeGreaterThan(20);
    expect(screen.lastFrame()).not.toContain("more →");
  });

  test("shows first-page and later-page empty states", async () => {
    const empty = renderScreen("/agentcore/identity/oauth2-credential-provider/list");
    await waitForText(empty.lastFrame, "No OAuth2 credential providers found in this Region.");
    empty.unmount();

    const core = new TestCoreClient();
    core.identity.setListOauth2Response({
      credentialProviders: [providerItem({ name: "page-one" })],
      nextToken: "page-2",
    });
    core.identity.setListOauth2Response({ credentialProviders: [] }, "page-2");
    const paged = renderScreen("/agentcore/identity/oauth2-credential-provider/list", { core });

    await waitForText(paged.lastFrame, "page 1 · more →");
    await paged.write("l");
    await waitForText(paged.lastFrame, "No OAuth2 credential providers on this page.");
    expect(paged.lastFrame()).not.toContain("No OAuth2 credential providers found in this Region.");
  });

  test("bare get redirects to the picker", async () => {
    const core = coreWithProviders([providerItem({ name: "redirected" })]);
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/get", { core });

    await waitForText(screen.lastFrame, "redirected");
    expect(core.identity.calls[0]?.method).toBe("listOauth2CredentialProviders");
  });

  test("selection opens the matching provider detail", async () => {
    const name = "oauth2 blue";
    const core = coreWithProviders([providerItem({ name })]);
    core.identity.setGetOauth2Response(getResponse({ name }));
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/list", { core });

    await waitForText(screen.lastFrame, name);
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → identity → oauth2-credential-provider → get → ${name}`,
    );
    await waitFor(() =>
      core.identity.calls.some(
        (call) => call.method === "getOauth2CredentialProvider" && call.args[0] === name,
      ),
    );
  });
});

describe("OAuth2 credential provider detail", () => {
  test("renders a resource summary with only the detail action", async () => {
    const core = new TestCoreClient();
    core.identity.setGetOauth2Response(getResponse());
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/get/oauth2-1", {
      core,
      endpointUrl,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("oauth2-1");
    expect(frame).toMatch(/vendor\s+CustomOauth2/);
    expect(frame).toMatch(/secretSource\s+MANAGED/);
    expect(frame).toContain("arn:aws:bedrock-agentcore");
    // The only action is "detail"; mutations are CLI-only, never surfaced here.
    expect(frame).toContain("❯ detail");
    expect(
      core.identity.calls.find((call) => call.method === "getOauth2CredentialProvider"),
    ).toEqual({
      method: "getOauth2CredentialProvider",
      args: ["oauth2-1", { region: "us-east-1", endpointUrl }],
    });
  });

  test("shows a callback URL only when the service provides one", async () => {
    const withCallback = new TestCoreClient();
    withCallback.identity.setGetOauth2Response(getResponse());
    const shown = renderScreen("/agentcore/identity/oauth2-credential-provider/get/oauth2-1", {
      core: withCallback,
    });
    await waitForText(shown.lastFrame, "show the full JSON definition");
    expect(shown.lastFrame()).toContain("callbackUrl");
    shown.unmount();

    const noCallback = new TestCoreClient();
    noCallback.identity.setGetOauth2Response(getResponse({ callbackUrl: undefined }));
    const hidden = renderScreen("/agentcore/identity/oauth2-credential-provider/get/oauth2-1", {
      core: noCallback,
    });
    await waitForText(hidden.lastFrame, "show the full JSON definition");
    expect(hidden.lastFrame()).not.toContain("callbackUrl");
  });

  test("shows status and failure reason for a failed provider", async () => {
    const core = new TestCoreClient();
    core.identity.setGetOauth2Response(
      getResponse({
        status: "CREATE_FAILED",
        failureReason: "authorization server metadata could not be loaded",
      }),
    );
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/get/oauth2-1", {
      core,
    });

    await waitForText(screen.lastFrame, "authorization server metadata could not be loaded");
    const frame = screen.lastFrame()!;
    expect(frame).toMatch(/status\s+CREATE_FAILED/);
    expect(frame).toContain("failureReason");
  });

  test("opens the complete provider JSON", async () => {
    const core = new TestCoreClient();
    core.identity.setGetOauth2Response(getResponse());
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/get/oauth2-1", {
      core,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "agentcore → identity → oauth2-credential-provider → get → oauth2-1 → json",
    );
    expect(screen.lastFrame()).toContain('"credentialProviderVendor"');
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.identity.setError(new Error("provider unavailable"));
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/get/oauth2-1", {
      core,
    });

    await waitForText(screen.lastFrame, "provider unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.identity.setError(undefined);
    core.identity.setGetOauth2Response(getResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });

  test("does not open cached detail after a background refresh fails", async () => {
    const core = new TestCoreClient();
    core.identity.setGetOauth2Response(getResponse());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
    });
    const screen = renderScreen("/agentcore/identity/oauth2-credential-provider/get/oauth2-1", {
      core,
      queryClient,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    core.identity.setError(new Error("background refresh failed"));
    await queryClient.invalidateQueries({
      queryKey: ["oauth2-credential-provider", "us-east-1", "oauth2-1"],
    });
    await waitForText(screen.lastFrame, "background refresh failed");

    await screen.press("return");
    await tick();
    expect(screen.lastFrame()).toContain(
      "agentcore → identity → oauth2-credential-provider → get → oauth2-1",
    );
    expect(screen.lastFrame()).not.toContain("→ json");
  });
});
