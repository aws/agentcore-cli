import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, PathKey } from "../../../router";
import { renderTuiAt } from "../../../tui";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { runtimeIdSchema } from "../invoke/request";
import { RuntimeShellLaunchContextKey } from "./launchContext";
import { runRuntimeShell } from "./operation";
import { resolveRuntimeShellBearerToken, validateRuntimeShellIds } from "./request";

const shellIdSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/,
    "must start with an alphanumeric character and contain at most 128 alphanumeric, '-' or '_' characters",
  );

export const createRuntimeShellHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "shell",
    description: "open an interactive shell in a Runtime",
    flags: [
      flag("id", "the ID of the Runtime", runtimeIdSchema.optional()),
      flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
      flag(
        "session-id",
        "the Runtime session ID to resume",
        z.string().min(33).max(256).optional(),
      ),
      flag("shell-id", "the shell ID to reattach", shellIdSchema.optional()),
      flag("bearer-token", "the CUSTOM_JWT bearer token", z.string().optional(), {
        sensitive: true,
      }),
    ],
    handle: async (ctx, flags) => {
      if (ctx.require(JsonKey)) {
        throw new InputValidationError("--json cannot be used with runtime shell");
      }
      if (flags.id === undefined) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      validateRuntimeShellIds(flags["session-id"], flags["shell-id"]);
      const bearerToken = await resolveRuntimeShellBearerToken(flags["bearer-token"], io.stdin);
      const launchContext = {
        runtimeId: flags.id,
        runtimeSessionId: flags["session-id"],
        shellId: flags["shell-id"],
        bearerToken,
      };
      if (flags.qualifier === undefined) {
        await renderTuiAt(
          `${ctx.require(PathKey)}/${encodeURIComponent(flags.id)}`,
          ctx.withValue(RuntimeShellLaunchContextKey, launchContext),
          core,
          io,
        );
        return;
      }
      await runRuntimeShell({
        ctx,
        core,
        io,
        runtimeId: flags.id,
        qualifier: flags.qualifier,
        launchContext,
      });
    },
  });

export { RuntimeShellScreen } from "./screen";
