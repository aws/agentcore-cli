import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, PathKey } from "../../../router";
import { renderTuiAt } from "../../../tui";
import { JsonKey } from "../../keys";
import { shellIdSchema } from "../../shell";
import type { Core } from "../../types";
import { resolveRuntimeShellBearerToken } from "../../runtime/shell/request";
import { HarnessShellLaunchContextKey } from "./launchContext";
import { runHarnessShell } from "./operation";

export const createHarnessShellHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "shell",
    description: "open an interactive shell in a harness",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("qualifier", "the harness endpoint qualifier", z.string().min(1).optional()),
      flag("session-id", "the Runtime session ID to use", z.string().min(33).max(256).optional()),
      flag("shell-id", "the shell ID to resume (requires --session-id)", shellIdSchema.optional()),
      flag("bearer-token", "the CUSTOM_JWT bearer token", z.string().optional(), {
        sensitive: true,
      }),
    ],
    handle: async (ctx, flags) => {
      if (ctx.require(JsonKey)) {
        throw new InputValidationError("--json cannot be used with harness shell");
      }
      if (flags["shell-id"] !== undefined && flags["session-id"] === undefined) {
        throw new InputValidationError("--shell-id requires --session-id");
      }
      const launchContext = {
        harnessId: flags.id,
        runtimeSessionId: flags["session-id"],
        shellId: flags["shell-id"],
        bearerToken: await resolveRuntimeShellBearerToken(flags["bearer-token"], io.stdin),
      };
      if (flags.qualifier === undefined) {
        await renderTuiAt(
          `${ctx.require(PathKey)}/${encodeURIComponent(flags.id)}`,
          ctx.withValue(HarnessShellLaunchContextKey, launchContext),
          core,
          io,
        );
        return;
      }
      await runHarnessShell({
        ctx,
        core,
        io,
        harnessId: flags.id,
        qualifier: flags.qualifier,
        launchContext,
      });
    },
  });

export { HarnessShellScreen } from "./screen";
