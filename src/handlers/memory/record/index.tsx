import { Router } from "../../../router";
import type { Core } from "../../types";
import { createGetMemoryRecordHandler } from "./get";
import { createListMemoryRecordsHandler } from "./list";

export function createMemoryRecordHandler(core: Core): Router {
  return new Router("record", "inspect AgentCore Memory records")
    .handler(createGetMemoryRecordHandler(core))
    .handler(createListMemoryRecordsHandler(core));
}
