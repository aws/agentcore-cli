import {
  GetEventCommand,
  GetMemoryRecordCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  type GetEventInput,
  type GetEventOutput,
  type GetMemoryRecordInput,
  type GetMemoryRecordOutput,
  type ListEventsInput,
  type ListEventsOutput,
  type ListMemoryRecordsInput,
  type ListMemoryRecordsOutput,
} from "@aws-sdk/client-bedrock-agentcore";
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

  async getEvent(input: GetEventInput, options: CoreOptions): Promise<GetEventOutput> {
    return this.clients.data(toClientConfig(options)).send(new GetEventCommand(input));
  }

  async listEvents(input: ListEventsInput, options: CoreOptions): Promise<ListEventsOutput> {
    return this.clients.data(toClientConfig(options)).send(new ListEventsCommand(input));
  }

  async getMemoryRecord(
    input: GetMemoryRecordInput,
    options: CoreOptions,
  ): Promise<GetMemoryRecordOutput> {
    return this.clients.data(toClientConfig(options)).send(new GetMemoryRecordCommand(input));
  }

  async listMemoryRecords(
    input: ListMemoryRecordsInput,
    options: CoreOptions,
  ): Promise<ListMemoryRecordsOutput> {
    return this.clients.data(toClientConfig(options)).send(new ListMemoryRecordsCommand(input));
  }
}
