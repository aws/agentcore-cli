import z from "zod";
import { InputValidationError } from "../../../errors";
import { createHandler, flag, PathKey } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { JsonKey } from "../../keys";
import { ExitCode, withUserCancellation } from "../../../runnable";
import { renderTuiAt } from "../../../tui";
import {
  parseRuntimeInvokeHeaders,
  resolveRuntimeInvokeSources,
  resolveRuntimeInvokeTuiBearerToken,
  runtimeIdSchema,
} from "./request";
import { writeRuntimeInvokeResponse } from "./response";
import { RuntimeInvokeLaunchContextKey } from "./launchContext";
import { invokeRuntimeTarget } from "./operation";

export const createInvokeRuntimeHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "invoke",
    description: "invoke a Runtime",
    flags: [
      flag("id", "the ID of the Runtime", runtimeIdSchema.optional()),
      flag("payload", "the inline payload to send", z.string().optional(), {
        sensitive: true,
      }),
      flag("qualifier", "the Runtime endpoint qualifier", z.string().optional()),
      flag("content-type", "the payload content type", z.string().optional()),
      flag("accept", "the accepted response content type", z.string().optional()),
      flag("session-id", "the Runtime session ID", z.string().optional()),
      flag("user-id", "the Runtime user ID", z.string().optional()),
      flag("header", "an ordered application header", z.array(z.string()).optional(), {
        sensitive: true,
      }),
      flag("bearer-token", "the CUSTOM_JWT bearer token", z.string().optional(), {
        sensitive: true,
      }),
      flag("mcp-session-id", "the MCP session ID", z.string().optional()),
      flag("mcp-protocol-version", "the MCP protocol version", z.string().optional()),
      flag("mcp-method", "the MCP method", z.string().optional()),
      flag("mcp-name", "the MCP tool, resource, or prompt name", z.string().optional()),
      flag("trace-id", "the X-Ray trace ID", z.string().optional()),
      flag("trace-parent", "the W3C trace parent", z.string().optional()),
      flag("trace-state", "the W3C trace state", z.string().optional()),
      flag("baggage", "the W3C baggage", z.string().optional()),
      flag(
        "output-file",
        "the response output file",
        z.string().min(1, "requires a nonempty path").optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (flags.id === undefined) {
        throw new InputValidationError("required option '--id <id>' not specified", {
          exitCode: ExitCode.USAGE,
        });
      }
      if (flags.payload === undefined) {
        const hasHeadlessOnlyFlag = Object.entries(flags).some(
          ([name, value]) =>
            ![
              "id",
              "qualifier",
              "payload",
              "session-id",
              "user-id",
              "header",
              "bearer-token",
            ].includes(name) && value !== undefined,
        );
        if (ctx.require(JsonKey) || hasHeadlessOnlyFlag) {
          throw new InputValidationError("required option '--payload <payload>' not specified", {
            exitCode: ExitCode.USAGE,
          });
        }
        let path = `${ctx.require(PathKey)}/${encodeURIComponent(flags.id)}`;
        if (flags.qualifier !== undefined) {
          path += `/${encodeURIComponent(flags.qualifier)}`;
        }
        const applicationHeaders = parseRuntimeInvokeHeaders(flags.header);
        const bearerToken = await resolveRuntimeInvokeTuiBearerToken(
          flags["bearer-token"],
          io.stdin,
        );
        const launchContext = {
          runtimeId: flags.id,
          runtimeSessionId: flags["session-id"],
          runtimeUserId: flags["user-id"],
          applicationHeaders,
          bearerToken,
        };
        await renderTuiAt(
          path,
          ctx.withValue(RuntimeInvokeLaunchContextKey, launchContext),
          core,
          io,
        );
        return;
      }

      const jsonOutput = ctx.require(JsonKey);
      if (jsonOutput && flags["output-file"] !== undefined) {
        throw new InputValidationError("--json cannot be used with --output-file");
      }
      const runtimeId = flags.id;
      const payload = flags.payload;
      await withUserCancellation(async (signal) => {
        const applicationHeaders = parseRuntimeInvokeHeaders(flags.header);
        const sources = await resolveRuntimeInvokeSources(
          { payload, bearerToken: flags["bearer-token"] },
          io.stdin,
          signal,
        );
        const options = coreOptsFromCtx(ctx);
        const response = await invokeRuntimeTarget(
          core.runtime,
          {
            runtimeId,
            qualifier: flags.qualifier,
            payload: sources.payload,
            contentType: flags["content-type"],
            accept: flags.accept,
            runtimeSessionId: flags["session-id"],
            runtimeUserId: flags["user-id"],
            applicationHeaders,
            bearerToken: sources.bearerToken,
            mcpSessionId: flags["mcp-session-id"],
            mcpProtocolVersion: flags["mcp-protocol-version"],
            mcpMethod: flags["mcp-method"],
            mcpName: flags["mcp-name"],
            traceId: flags["trace-id"],
            traceParent: flags["trace-parent"],
            traceState: flags["trace-state"],
            baggage: flags.baggage,
          },
          options,
          signal,
        );
        await writeRuntimeInvokeResponse(response, {
          stdout: io.stdout,
          stderr: io.stderr,
          outputFile: flags["output-file"],
          json: jsonOutput,
          signal,
        });
      });
    },
  });
