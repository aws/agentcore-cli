import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createPublishDatasetHandler = (core: Core) =>
  createHandler({
    name: "publish",
    description: "publish the current DRAFT as a new immutable version",
    flags: [flag("id", "the ID of the dataset to publish", z.string().min(1))],
    handle: async (ctx, flags) => {
      // Publishing an unmodified DRAFT creates a version identical to the last
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.publishDataset(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
