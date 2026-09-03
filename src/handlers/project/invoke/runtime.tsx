import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { ExitCode, withUserCancellation } from "../../../runnable";
import { createHandler, flag, ProjectKey } from "../../../router";
import { renderTuiAt } from "../../../tui";
import { JsonKey, RegionKey } from "../../keys";
import { RuntimeInvokeLaunchContextKey } from "../../runtime/invoke/launchContext";
import { invokeRuntimeTarget } from "../../runtime/invoke/operation";
import {
  parseRuntimeInvokeHeaders,
  resolveRuntimeInvokeSources,
  resolveRuntimeInvokeTuiBearerToken,
} from "../../runtime/invoke/request";
import { writeRuntimeInvokeResponse } from "../../runtime/invoke/response";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { selectProjectResource } from "./selection";

export const createProjectInvokeRuntimeHandler = (
  core: Core,
  io: AppIO,
  renderInvokeTui: typeof renderTuiAt = renderTuiAt,
) =>
  createHandler({
    name: "runtime",
    description: "invoke a Runtime from the current project",
    flags: [
      flag("name", "the logical project Runtime name", z.string().optional()),
      flag("target", "project deployment target", z.string().default("default")),
      flag("payload", "the inline payload to send", z.string().optional(), { sensitive: true }),
      flag("qualifier", "the Runtime endpoint qualifier", z.string().optional()),
      flag("content-type", "the payload content type", z.string().optional()),
      flag("accept", "the accepted response content type", z.string().optional()),
      flag("session-id", "the Runtime session ID", z.string().optional()),
      flag("user-id", 'the Runtime user ID (default "default")', z.string().optional()),
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
      const project = ctx.require(ProjectKey);
      const name = selectProjectResource(project, "runtime", flags.name);
      const deployed = await core.projectManager.resolveDeployedResource(project, {
        target: flags.target,
        resourceType: "runtime",
        name,
      });
      const invokeCtx = ctx.withValue(RegionKey, deployed.target.region);

      if (flags.payload === undefined) {
        const hasHeadlessOnlyFlag = Object.entries(flags).some(
          ([flagName, value]) =>
            ![
              "name",
              "target",
              "qualifier",
              "payload",
              "session-id",
              "user-id",
              "header",
              "bearer-token",
            ].includes(flagName) && value !== undefined,
        );
        if (invokeCtx.require(JsonKey) || hasHeadlessOnlyFlag) {
          throw new InputValidationError("required option '--payload <payload>' not specified", {
            exitCode: ExitCode.USAGE,
          });
        }
        let path = `/agentcore/runtime/invoke/${encodeURIComponent(deployed.id)}`;
        if (flags.qualifier !== undefined) path += `/${encodeURIComponent(flags.qualifier)}`;
        const applicationHeaders = parseRuntimeInvokeHeaders(flags.header);
        const bearerToken = await resolveRuntimeInvokeTuiBearerToken(
          flags["bearer-token"],
          io.stdin,
        );
        await renderInvokeTui(
          path,
          invokeCtx.withValue(RuntimeInvokeLaunchContextKey, {
            runtimeId: deployed.id,
            runtimeSessionId: flags["session-id"],
            runtimeUserId: flags["user-id"],
            applicationHeaders,
            bearerToken,
          }),
          core,
          io,
        );
        return;
      }

      if (invokeCtx.require(JsonKey) && flags["output-file"] !== undefined) {
        throw new InputValidationError("--json cannot be used with --output-file");
      }
      await withUserCancellation(async (signal) => {
        const applicationHeaders = parseRuntimeInvokeHeaders(flags.header);
        const sources = await resolveRuntimeInvokeSources(
          { payload: flags.payload!, bearerToken: flags["bearer-token"] },
          io.stdin,
          signal,
        );
        const response = await invokeRuntimeTarget(
          core.runtime,
          {
            runtimeId: deployed.id,
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
          coreOptsFromCtx(invokeCtx),
          signal,
        );
        await writeRuntimeInvokeResponse(response, {
          stdout: io.stdout,
          stderr: io.stderr,
          outputFile: flags["output-file"],
          json: invokeCtx.require(JsonKey),
          signal,
        });
      });
    },
  });
