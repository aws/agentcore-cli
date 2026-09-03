import z from "zod";
import { createHandler, flag } from "../../../router";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx } from "../../utils.tsx";
import { JsonRendererKey } from "../../../tui";
import { InputValidationError } from "../../../errors";

export const createDeleteHarnessHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a harness",
    flags: [
      flag("id", "the ID of the harness to delete", z.string().max(48).optional()),
      flag(
        "delete-managed-memory",
        "whether to also delete the managed Memory (default true; pass false to keep it)",
        z.enum(["true", "false"]).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare
      // `harness delete` falls through to the TUI middleware instead.
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      const response = await core.harness.deleteHarness(
        {
          harnessId: flags["id"],
          deleteManagedMemory:
            flags["delete-managed-memory"] === undefined
              ? undefined
              : flags["delete-managed-memory"] === "true",
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessDeleteScreen } from "./screen.tsx";
