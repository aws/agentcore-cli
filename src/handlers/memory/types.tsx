import type {
  GetMemoryOutput,
  ListMemoriesOutput,
  MemoryView,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  GetEventInput,
  GetEventOutput,
  GetMemoryRecordInput,
  GetMemoryRecordOutput,
  ListEventsInput,
  ListEventsOutput,
  ListMemoryRecordsInput,
  ListMemoryRecordsOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { CoreOptions } from "../../core/types";

export interface CoreMemoryClient {
  getMemory(id: string, view: MemoryView, options: CoreOptions): Promise<GetMemoryOutput>;
  listMemories(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListMemoriesOutput>;

  getMemoryRecord(
    input: GetMemoryRecordInput,
    options: CoreOptions,
  ): Promise<GetMemoryRecordOutput>;

  listMemoryRecords(
    input: ListMemoryRecordsInput,
    options: CoreOptions,
  ): Promise<ListMemoryRecordsOutput>;

  getEvent(input: GetEventInput, options: CoreOptions): Promise<GetEventOutput>;

  listEvents(input: ListEventsInput, options: CoreOptions): Promise<ListEventsOutput>;
}
