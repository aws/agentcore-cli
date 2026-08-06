import { afterEach, describe, expect, test } from "bun:test";
import type { DatasetSummary, GetDatasetResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

const evalEndpointUrl = "https://eval.test";

function datasetSummary(overrides: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    datasetArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:dataset/dataset-1",
    datasetId: "dataset-1",
    datasetName: "orders-regression",
    status: "ACTIVE",
    draftStatus: "MODIFIED",
    schemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
    exampleCount: 2,
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T12:34:56.000Z"),
    ...overrides,
  };
}

function getDatasetResponse(overrides: Partial<GetDatasetResponse> = {}): GetDatasetResponse {
  return {
    datasetArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:dataset/dataset-1",
    datasetId: "dataset-1",
    datasetVersion: "DRAFT",
    datasetName: "orders-regression",
    description: "Regression tests for the order-support agent",
    status: "ACTIVE",
    draftStatus: "MODIFIED",
    schemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
    exampleCount: 2,
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T12:34:56.000Z"),
    tags: { team: "agentcore" },
    ...overrides,
  };
}

function coreWithDatasets(datasets: DatasetSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setListDatasetsResponse({ datasets });
  return core;
}

describe("dataset menu", () => {
  test("offers only the read-only commands", async () => {
    const screen = renderScreen("/agentcore/eval/dataset");

    await waitForText(screen.lastFrame, "get a dataset's metadata");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("list");
    expect(frame).not.toContain("create");
    expect(frame).not.toContain("update");
    expect(frame).not.toContain("publish");
    expect(frame).not.toContain("delete");
  });
});

describe("dataset picker", () => {
  test("renders name, status, schema, example count, and update time", async () => {
    const core = coreWithDatasets([
      datasetSummary({
        datasetName: "staging-regression",
        status: "UPDATE_FAILED",
        schemaType: "AGENTCORE_EVALUATION_SIMULATED_V1",
        exampleCount: 17,
        updatedAt: new Date("2026-08-03T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/dataset/list", { core });

    await waitForText(screen.lastFrame, "staging-regression");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("UPDATE_FAILED");
    expect(frame).toContain("simulated");
    expect(frame).toMatch(/17\s+2026-08-03 02:03/);
  });

  test("calls listDatasets with exact Core options", async () => {
    const core = coreWithDatasets([datasetSummary()]);
    renderScreen("/agentcore/eval/dataset/list", { core, endpointUrl: evalEndpointUrl });

    await waitFor(() => core.eval.calls.some((call) => call.method === "listDatasets"));
    expect(core.eval.calls.filter((call) => call.method === "listDatasets")).toEqual([
      {
        method: "listDatasets",
        args: [
          undefined,
          expect.any(Number),
          { region: "us-east-1", endpointUrl: evalEndpointUrl },
        ],
      },
    ]);
  });

  test("bare dataset get redirects to the picker", async () => {
    const core = coreWithDatasets([
      datasetSummary({ datasetId: "redirected-dataset", datasetName: "redirected-dataset" }),
    ]);
    const screen = renderScreen("/agentcore/eval/dataset/get", { core });

    await waitForText(screen.lastFrame, "redirected-dataset");
    expect(core.eval.calls[0]?.method).toBe("listDatasets");
  });

  test("selection opens the matching dataset detail", async () => {
    const core = coreWithDatasets([datasetSummary({ datasetId: "dataset-1" })]);
    core.eval.setGetDatasetResponse(getDatasetResponse({ datasetId: "dataset-1" }));
    const screen = renderScreen("/agentcore/eval/dataset/list", { core });

    await waitForText(screen.lastFrame, "orders-regression");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → dataset → get → dataset-1");
    await waitFor(() =>
      core.eval.calls.some((call) => call.method === "getDataset" && call.args[0] === "dataset-1"),
    );
  });

  test("shows the empty state", async () => {
    const screen = renderScreen("/agentcore/eval/dataset/list");
    await waitForText(screen.lastFrame, "No datasets found in this Region.");
  });
});

describe("dataset detail", () => {
  test("renders DRAFT metadata without downloading examples", async () => {
    const core = new TestCoreClient();
    core.eval.setGetDatasetResponse(getDatasetResponse());
    const screen = renderScreen("/agentcore/eval/dataset/get/dataset-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "show the full JSON metadata");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("orders-regression");
    expect(frame).toMatch(/version\s+DRAFT/);
    expect(frame).toMatch(/draftStatus\s+MODIFIED/);
    expect(frame).toMatch(/examples\s+2/);
    expect(core.eval.calls).toEqual([
      {
        method: "getDataset",
        args: ["dataset-1", undefined, { region: "us-east-1", endpointUrl: evalEndpointUrl }],
      },
    ]);
  });

  test("shows failure details when present", async () => {
    const core = new TestCoreClient();
    core.eval.setGetDatasetResponse(
      getDatasetResponse({
        status: "UPDATE_FAILED",
        failureReason: "The source could not be read",
      }),
    );
    const screen = renderScreen("/agentcore/eval/dataset/get/dataset-1", { core });

    await waitForText(screen.lastFrame, "The source could not be read");
    expect(screen.lastFrame()).toContain("UPDATE_FAILED");
  });

  test("opens the complete dataset JSON", async () => {
    const core = new TestCoreClient();
    core.eval.setGetDatasetResponse(getDatasetResponse());
    const screen = renderScreen("/agentcore/eval/dataset/get/dataset-1", { core });

    await waitForText(screen.lastFrame, "show the full JSON metadata");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → dataset → get → dataset-1 → json");
    expect(screen.lastFrame()).toContain('"team"');
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("dataset unavailable"));
    const screen = renderScreen("/agentcore/eval/dataset/get/dataset-1", { core });

    await waitForText(screen.lastFrame, "dataset unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setGetDatasetResponse(getDatasetResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, "show the full JSON metadata");
  });
});
