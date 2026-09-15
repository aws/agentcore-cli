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

const TARGET = "Target:";
const PAYLOAD = "Payload:";
const SESSION = "Session:";
const MCP = "MCP:";
const TRACING = "Tracing:";

export const createInvokeRuntimeHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "invoke",
    description: "invoke a Runtime",
    flags: [
      flag("id", "the ID of the Runtime", runtimeIdSchema.optional(), { group: TARGET }),
      flag("qualifier", "the Runtime endpoint qualifier", z.string().optional(), {
        group: TARGET,
      }),
      flag("payload", "the inline payload to send", z.string().optional(), {
        sensitive: true,
        group: PAYLOAD,
      }),
      flag("content-type", "the payload content type", z.string().optional(), { group: PAYLOAD }),
      flag("accept", "the accepted response content type", z.string().optional(), {
        group: PAYLOAD,
      }),
      flag(
        "output-file",
        "the response output file",
        z.string().min(1, "requires a nonempty path").optional(),
        { group: PAYLOAD },
      ),
      flag("session-id", "the Runtime session ID", z.string().optional(), { group: SESSION }),
      flag("user-id", 'the Runtime user ID (default "default")', z.string().optional(), {
        group: SESSION,
      }),
      flag("bearer-token", "the CUSTOM_JWT bearer token", z.string().optional(), {
        sensitive: true,
        group: "Authentication:",
      }),
      flag("header", "an ordered application header", z.array(z.string()).optional(), {
        sensitive: true,
        group: "Application headers:",
      }),
      flag("mcp-session-id", "the MCP session ID", z.string().optional(), { group: MCP }),
      flag("mcp-protocol-version", "the MCP protocol version", z.string().optional(), {
        group: MCP,
      }),
      flag("mcp-method", "the MCP method", z.string().optional(), { group: MCP }),
      flag("mcp-name", "the MCP tool, resource, or prompt name", z.string().optional(), {
        group: MCP,
      }),
      flag("trace-id", "the X-Ray trace ID", z.string().optional(), {
        group: TRACING,
        help: `(string)
The AWS X-Ray trace ID to associate this invocation with, sent as the
X-Amzn-Trace-Id header. Format: 1-<8 hex digits>-<24 hex digits>.

Example:
  --trace-id 1-5759e988-bd862e3fe1be46a994272793`,
      }),
      flag("trace-parent", "the W3C trace parent", z.string().optional(), {
        group: TRACING,
        help: `(string)
The W3C Trace Context traceparent header identifying the parent span.
Format: <version>-<trace-id>-<parent-id>-<trace-flags>.

Example:
  --trace-parent 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`,
      }),
      flag("trace-state", "the W3C trace state", z.string().optional(), {
        group: TRACING,
        help: `(string)
The W3C Trace Context tracestate header carrying vendor-specific trace
data. Format: a comma-separated list of key=value pairs.

Example:
  --trace-state vendor1=opaqueValue1,vendor2=opaqueValue2`,
      }),
      flag("baggage", "the W3C baggage", z.string().optional(), {
        group: TRACING,
        help: `(string)
The W3C Baggage header carrying application-defined key=value context
propagated across the request. Format: a comma-separated list of key=value
pairs.

Example:
  --baggage userId=alice,sessionId=abc123`,
      }),
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
