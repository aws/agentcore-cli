import { afterEach, describe, expect, test } from "bun:test";
import type {
  ConfigurationBundleSummary,
  ConfigurationBundleVersionSummary,
  GetConfigurationBundleResponse,
  GetConfigurationBundleVersionResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

const evalEndpointUrl = "https://eval.test";

function bundleSummary(
  overrides: Partial<ConfigurationBundleSummary> = {},
): ConfigurationBundleSummary {
  return {
    bundleArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:configuration-bundle/bundle-1",
    bundleId: "bundle-1",
    bundleName: "orders-prompt",
    description: "Order support agent configuration",
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    ...overrides,
  };
}

function bundleVersionSummary(
  overrides: Partial<ConfigurationBundleVersionSummary> = {},
): ConfigurationBundleVersionSummary {
  return {
    bundleArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:configuration-bundle/bundle-1",
    bundleId: "bundle-1",
    versionId: "version-1",
    versionCreatedAt: new Date("2026-08-02T12:34:56.000Z"),
    lineageMetadata: {
      branchName: "mainline",
      commitMessage: "Initial configuration",
      parentVersionIds: [],
    },
    ...overrides,
  };
}

function latestBundleResponse(
  overrides: Partial<GetConfigurationBundleResponse> = {},
): GetConfigurationBundleResponse {
  return {
    bundleArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:configuration-bundle/bundle-1",
    bundleId: "bundle-1",
    bundleName: "orders-prompt",
    description: "Order support agent configuration",
    versionId: "version-2",
    components: {
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent": {
        configuration: { system_prompt: "Help customers with their orders." },
      },
    },
    lineageMetadata: {
      branchName: "mainline",
      commitMessage: "Improve order guidance",
      parentVersionIds: ["version-1"],
    },
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-03T04:05:06.000Z"),
    ...overrides,
  };
}

function versionBundleResponse(
  overrides: Partial<GetConfigurationBundleVersionResponse> = {},
): GetConfigurationBundleVersionResponse {
  return {
    bundleArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:configuration-bundle/bundle-1",
    bundleId: "bundle-1",
    bundleName: "orders-prompt",
    description: "Order support agent configuration",
    versionId: "version-1",
    components: {
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent": {
        configuration: { system_prompt: "Help with orders." },
      },
    },
    lineageMetadata: {
      branchName: "mainline",
      commitMessage: "Initial configuration",
      parentVersionIds: [],
    },
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    versionCreatedAt: new Date("2026-08-02T12:34:56.000Z"),
    ...overrides,
  };
}

function coreWithBundles(bundles: ConfigurationBundleSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setListConfigurationBundlesResponse({ bundles });
  return core;
}

describe("configuration bundle menu", () => {
  test("offers only get, list, and version", async () => {
    const screen = renderScreen("/agentcore/eval/config-bundle");

    await waitForText(
      screen.lastFrame,
      "get the latest or a specific configuration bundle version",
    );
    const frame = screen.lastFrame()!;
    expect(frame).toContain("list");
    expect(frame).toContain("version");
    expect(frame).not.toContain("create");
    expect(frame).not.toContain("update");
    expect(frame).not.toContain("delete");
  });

  test("the version menu offers only list", async () => {
    const screen = renderScreen("/agentcore/eval/config-bundle/version");

    await waitForText(screen.lastFrame, "list immutable versions of a configuration bundle");
    expect(screen.lastFrame()).not.toContain("create");
    expect(screen.lastFrame()).not.toContain("delete");
  });
});

describe("configuration bundle picker", () => {
  test("renders name, description, and creation time", async () => {
    const core = coreWithBundles([
      bundleSummary({
        bundleName: "staging-prompt",
        description: "Staging agent settings",
        createdAt: new Date("2026-08-03T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/config-bundle/list", { core });

    await waitForText(screen.lastFrame, "staging-prompt");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("Staging agent settings");
    expect(frame).toContain("2026-08-03 02:03");
  });

  test("calls listConfigurationBundles with exact Core options", async () => {
    const core = coreWithBundles([bundleSummary()]);
    renderScreen("/agentcore/eval/config-bundle/list", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitFor(() => core.eval.calls.some((call) => call.method === "listConfigurationBundles"));
    expect(core.eval.calls.filter((call) => call.method === "listConfigurationBundles")).toEqual([
      {
        method: "listConfigurationBundles",
        args: [
          undefined,
          expect.any(Number),
          { region: "us-east-1", endpointUrl: evalEndpointUrl },
        ],
      },
    ]);
  });

  test("bare get redirects to the bundle picker", async () => {
    const core = coreWithBundles([
      bundleSummary({ bundleId: "redirected-bundle", bundleName: "redirected-bundle" }),
    ]);
    const screen = renderScreen("/agentcore/eval/config-bundle/get", { core });

    await waitForText(screen.lastFrame, "redirected-bundle");
    expect(core.eval.calls[0]?.method).toBe("listConfigurationBundles");
  });

  test("selection opens the latest mainline bundle JSON", async () => {
    const core = coreWithBundles([bundleSummary()]);
    core.eval.setGetConfigurationBundleResponse(latestBundleResponse());
    const screen = renderScreen("/agentcore/eval/config-bundle/list", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "orders-prompt");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → config-bundle → get → bundle-1");
    await waitForText(screen.lastFrame, '"system_prompt"');
    expect(core.eval.calls.find((call) => call.method === "getConfigurationBundle")).toEqual({
      method: "getConfigurationBundle",
      args: [
        "bundle-1",
        undefined,
        "mainline",
        { region: "us-east-1", endpointUrl: evalEndpointUrl },
      ],
    });
  });

  test("shows the empty state", async () => {
    const screen = renderScreen("/agentcore/eval/config-bundle/list");
    await waitForText(screen.lastFrame, "No configuration bundles found in this Region.");
  });
});

describe("configuration bundle version list", () => {
  test("uses the bundle picker to scope an unscoped version list", async () => {
    const core = coreWithBundles([
      bundleSummary({ bundleId: "bundle/blue one", bundleName: "pick-bundle" }),
    ]);
    core.eval.setListConfigurationBundleVersionsResponse({
      versions: [bundleVersionSummary({ bundleId: "bundle/blue one", versionId: "version-9" })],
    });
    const screen = renderScreen("/agentcore/eval/config-bundle/version/list", { core });

    await waitForText(screen.lastFrame, "pick-bundle");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "agentcore → eval → config-bundle → version → list → bundle/blue one",
    );
    await waitForText(screen.lastFrame, "version-9");
    expect(
      core.eval.calls.some(
        (call) =>
          call.method === "listConfigurationBundleVersions" && call.args[0] === "bundle/blue one",
      ),
    ).toBe(true);
  });

  test("calls listConfigurationBundleVersions with exact scope and options", async () => {
    const core = new TestCoreClient();
    core.eval.setListConfigurationBundleVersionsResponse({
      versions: [bundleVersionSummary()],
    });
    renderScreen("/agentcore/eval/config-bundle/version/list/bundle-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitFor(() =>
      core.eval.calls.some((call) => call.method === "listConfigurationBundleVersions"),
    );
    expect(
      core.eval.calls.filter((call) => call.method === "listConfigurationBundleVersions"),
    ).toEqual([
      {
        method: "listConfigurationBundleVersions",
        args: [
          "bundle-1",
          undefined,
          expect.any(Number),
          { region: "us-east-1", endpointUrl: evalEndpointUrl },
        ],
      },
    ]);
    expect(core.eval.calls.some((call) => call.method === "listConfigurationBundles")).toBe(false);
  });

  test("renders newest versions first with branch, message, and creation time", async () => {
    const core = new TestCoreClient();
    core.eval.setListConfigurationBundleVersionsResponse({
      versions: [
        bundleVersionSummary({
          versionId: "older-version",
          versionCreatedAt: new Date("2026-08-02T00:00:00.000Z"),
        }),
        bundleVersionSummary({
          versionId: "newer-version",
          versionCreatedAt: new Date("2026-08-04T10:11:12.000Z"),
          lineageMetadata: {
            branchName: "review",
            commitMessage: "Tune the review prompt",
          },
        }),
      ],
    });
    const screen = renderScreen("/agentcore/eval/config-bundle/version/list/bundle-1", { core });

    await waitForText(screen.lastFrame, "older-version");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("review");
    expect(frame).toContain("Tune the review prompt");
    expect(frame).toContain("2026-08-04 10:11");
    expect(frame.indexOf("newer-version")).toBeLessThan(frame.indexOf("older-version"));
  });

  test("selection opens the selected immutable version JSON", async () => {
    const core = new TestCoreClient();
    core.eval.setListConfigurationBundleVersionsResponse({
      versions: [bundleVersionSummary({ versionId: "version-9" })],
    });
    core.eval.setGetConfigurationBundleVersionResponse(
      versionBundleResponse({ versionId: "version-9" }),
    );
    const screen = renderScreen("/agentcore/eval/config-bundle/version/list/bundle-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "version-9");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "agentcore → eval → config-bundle → get → bundle-1 → version-9",
    );
    await waitForText(screen.lastFrame, '"components"');
    expect(core.eval.calls.find((call) => call.method === "getConfigurationBundle")).toEqual({
      method: "getConfigurationBundle",
      args: [
        "bundle-1",
        "version-9",
        "mainline",
        { region: "us-east-1", endpointUrl: evalEndpointUrl },
      ],
    });
  });

  test("returns to bundle selection from a scoped version list", async () => {
    const core = coreWithBundles([bundleSummary()]);
    core.eval.setListConfigurationBundleVersionsResponse({
      versions: [bundleVersionSummary()],
    });
    const screen = renderScreen("/agentcore/eval/config-bundle/version/list/bundle-1", { core });

    await waitForText(screen.lastFrame, "version-1");
    await screen.press("escape");
    await waitForText(
      screen.lastFrame,
      "agentcore → eval → config-bundle → version → list → choose a configuration bundle",
    );
    await waitForText(screen.lastFrame, "orders-prompt");
  });

  test("names the bundle in empty and error states", async () => {
    const empty = renderScreen("/agentcore/eval/config-bundle/version/list/bundle-1");
    await waitForText(empty.lastFrame, "No versions found for configuration bundle bundle-1.");
    empty.unmount();

    const core = new TestCoreClient();
    core.eval.setError(new Error("version access denied"));
    const failed = renderScreen("/agentcore/eval/config-bundle/version/list/bundle-1", { core });
    await waitForText(failed.lastFrame, "Error loading versions for configuration bundle bundle-1");
    expect(failed.lastFrame()).toContain("version access denied");
    expect(failed.lastFrame()).toContain("[r] retry");
  });
});

describe("configuration bundle detail", () => {
  test("retries a failed query", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("configuration bundle unavailable"));
    const screen = renderScreen("/agentcore/eval/config-bundle/get/bundle-1", { core });

    await waitForText(screen.lastFrame, "configuration bundle unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setGetConfigurationBundleResponse(latestBundleResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, '"system_prompt"');
  });
});
