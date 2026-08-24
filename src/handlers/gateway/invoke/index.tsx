import z from "zod";
import { GatewayInvokeResponseError, InputValidationError } from "../../../errors";
import { SourceResolver, type AppIO } from "../../../io";
import { ExitCode, withUserCancellation } from "../../../runnable";
import { createHandler, flag, PathKey } from "../../../router";
import { renderTuiAt } from "../../../tui";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { GatewayInvokeMethod } from "../types";
import {
  gatewayIdSchema,
  normalizeGatewayInvokeRequest,
  parseGatewayInvokeHeaders,
  resolveGatewayInvokeSources,
  resolveGatewayInvokeTuiBearerToken,
} from "./request";
import { writeGatewayInvokeResponse } from "./response";
import { GatewayInvokeLaunchContextKey } from "./launchContext";

export const createInvokeGatewayHandler = (
  core: Core,
  io: AppIO,
  renderInvokeTui: typeof renderTuiAt = renderTuiAt,
) =>
  createHandler({
    name: "invoke",
    description: "invoke an AgentCore Gateway",
    flags: [
      flag("id", "the ID of the Gateway", gatewayIdSchema.optional()),
      flag(
        "path",
        "the path relative to the Gateway origin",
        z.string().min(1, "requires a nonempty path").optional(),
        { sensitive: true },
      ),
      flag("method", "the HTTP request method", z.enum(["GET", "POST", "DELETE"]).optional()),
      flag("payload", "the inline payload to send", z.string().optional(), { sensitive: true }),
      flag("content-type", "the payload content type", z.string().optional()),
      flag("accept", "the accepted response content type", z.string().optional()),
      flag("header", "an ordered application header", z.array(z.string()).optional(), {
        sensitive: true,
      }),
      flag("bearer-token", "the Gateway bearer token", z.string().optional(), {
        sensitive: true,
      }),
      flag("session-id", "the Runtime target session ID", z.string().optional()),
      flag("mcp-session-id", "the MCP session ID", z.string().optional()),
      flag("mcp-protocol-version", "the MCP protocol version", z.string().optional()),
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

      const jsonOutput = ctx.require(JsonKey);
      if (flags.payload === undefined) {
        const hasHeadlessOnlyFlag = Object.entries(flags).some(
          ([name, value]) =>
            ![
              "id",
              "path",
              "payload",
              "header",
              "bearer-token",
              "session-id",
              "mcp-session-id",
              "mcp-protocol-version",
            ].includes(name) && value !== undefined,
        );
        if (!jsonOutput && !hasHeadlessOnlyFlag) {
          const applicationHeaders = parseGatewayInvokeHeaders(flags.header);
          const bearerToken = await resolveGatewayInvokeTuiBearerToken(
            flags["bearer-token"],
            new SourceResolver({ stdin: io.stdin }),
          );
          const launchContext = {
            gatewayId: flags.id,
            path: flags.path,
            runtimeSessionId: flags["session-id"],
            mcpSessionId: flags["mcp-session-id"],
            mcpProtocolVersion: flags["mcp-protocol-version"],
            applicationHeaders,
            bearerToken,
          };
          await renderInvokeTui(
            `${ctx.require(PathKey)}/${encodeURIComponent(flags.id)}`,
            ctx.withValue(GatewayInvokeLaunchContextKey, launchContext),
            core,
            io,
          );
          return;
        }
      }

      if (jsonOutput && flags["output-file"] !== undefined) {
        throw new InputValidationError("--json cannot be used with --output-file");
      }
      const gatewayId = flags.id;
      const payload = flags.payload;

      await withUserCancellation(async (signal) => {
        const applicationHeaders = parseGatewayInvokeHeaders(flags.header);
        const sources = await resolveGatewayInvokeSources(
          { payload, bearerToken: flags["bearer-token"] },
          io.stdin,
          signal,
        );
        const options = coreOptsFromCtx(ctx);
        const gateway = await core.gateway.getGateway(gatewayId, options, signal);
        const request = normalizeGatewayInvokeRequest(gateway, {
          gatewayId,
          path: flags.path,
          method: flags.method as GatewayInvokeMethod | undefined,
          payload: sources.payload,
          contentType: flags["content-type"],
          accept: flags.accept,
          applicationHeaders,
          bearerToken: sources.bearerToken,
          runtimeSessionId: flags["session-id"],
          mcpSessionId: flags["mcp-session-id"],
          mcpProtocolVersion: flags["mcp-protocol-version"],
        });
        const response = await core.gateway.invokeGateway(request, options, signal);
        await writeGatewayInvokeResponse(response, {
          stdout: io.stdout,
          stderr: io.stderr,
          outputFile: flags["output-file"],
          json: jsonOutput,
          signal,
        });
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new GatewayInvokeResponseError(`HTTP ${response.statusCode}`);
        }
      });
    },
  });
