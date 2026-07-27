import {
  GetMemoryCommand,
  ListMemoriesCommand,
  type GetMemoryOutput,
  type ListMemoriesOutput,
  type MemoryView,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreMemoryClient } from "../handlers/memory/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

export class MemoryClient implements CoreMemoryClient {
  constructor(private readonly clients: AwsClients) {}

  async getMemory(id: string, view: MemoryView, options: CoreOptions): Promise<GetMemoryOutput> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetMemoryCommand({ memoryId: id, view }));
  }

  async listMemories(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListMemoriesOutput> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListMemoriesCommand({ nextToken, maxResults }));
  }
}
