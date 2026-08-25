import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createStopAbTestHandler = (core: Core) =>
  createHandler({
    name: "stop",
    description: "stop an A/B test (terminal)",
    flags: [flag("id", "the ID of the A/B test", z.string().optional())],
    handle: async (ctx, flags) => {
      const id = flags["id"];
      if (!id) throw new InputValidationError("required option '--id <id>' not specified");
      // TODO: after stopping, print a suggested (never executed) update-gateway-rule
      // command routing production traffic to the treatment. Shape depends on mode
      // (config-bundle: swap bundleVersion; target-based: routeToTarget); fall back to
      // create-gateway-rule when no prod rule exists, or list candidates when ambiguous.
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.setABTestExecutionStatus(id, "STOPPED", coreOptsFromCtx(ctx)));
    },
  });
