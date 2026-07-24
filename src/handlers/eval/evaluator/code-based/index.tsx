import { Router } from "../../../../router";
import type { AppIO, Core } from "../../../types";
import { createHelpDefault } from "../../../help";
import { createCodeBasedCreateHandler } from "./create";
import { createCodeBasedUpdateHandler } from "./update";

export function createCodeBasedHandler(core: Core, io: AppIO): Router {
  return new Router("code-based", "manage code-based (Lambda-backed) evaluators")
    .default(createHelpDefault(io))
    .handler(createCodeBasedCreateHandler(core, io))
    .handler(createCodeBasedUpdateHandler(core));
}
