import type {
  GetMemoryOutput,
  ListMemoriesOutput,
  MemoryView,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export interface CoreMemoryClient {
  getMemory(id: string, view: MemoryView, options: CoreOptions): Promise<GetMemoryOutput>;
  listMemories(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListMemoriesOutput>;
}
