import { describe, expect, test } from "bun:test";
import {
  DeleteDatasetGenerationCommand,
  GetDatasetGenerationCommand,
  ListDatasetGenerationsCommand,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import { EvalClient } from "./eval";
import type { AwsClients } from "./types";

const OPTIONS = { region: "us-west-2" };

function subject(): { client: EvalClient; sent: unknown[] } {
  const sent: unknown[] = [];
  const data = {
    send: async (command: unknown) => {
      sent.push(command);
      return {};
    },
  } as unknown as BedrockAgentCoreClient;
  return { client: new EvalClient({ data: () => data } as unknown as AwsClients), sent };
}

// get, list and delete take the dataset and generation as separate arguments; each
// request must carry datasetId, since generations are addressed under their dataset.
describe("EvalClient dataset generations", () => {
  test("get, list and delete address the generation under its dataset", async () => {
    const { client, sent } = subject();

    await client.getDatasetGeneration("d-1", "g-1", OPTIONS);
    await client.listDatasetGenerations("d-1", "page-2", 5, OPTIONS);
    await client.deleteDatasetGeneration("d-1", "g-1", OPTIONS);

    expect(sent[0]).toBeInstanceOf(GetDatasetGenerationCommand);
    expect((sent[0] as GetDatasetGenerationCommand).input).toEqual({
      datasetId: "d-1",
      generationId: "g-1",
    });
    expect(sent[1]).toBeInstanceOf(ListDatasetGenerationsCommand);
    expect((sent[1] as ListDatasetGenerationsCommand).input).toEqual({
      datasetId: "d-1",
      nextToken: "page-2",
      maxResults: 5,
    });
    expect(sent[2]).toBeInstanceOf(DeleteDatasetGenerationCommand);
    expect((sent[2] as DeleteDatasetGenerationCommand).input).toEqual({
      datasetId: "d-1",
      generationId: "g-1",
    });
  });
});
