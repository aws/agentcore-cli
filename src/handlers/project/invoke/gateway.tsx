import { GatewayInvokeResponseError } from "../../../errors";
import { SourceResolver, type AppIO } from "../../../io";
import type { Context } from "../../../router";
import { withUserCancellation } from "../../../runnable";
import type { renderTuiAt } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { GatewayInvokeLaunchContextKey } from "../../gateway/invoke/launchContext";
import {
  normalizeGatewayInvokeRequest,
  parseGatewayInvokeHeaders,
  resolveGatewayInvokeSources,
  resolveGatewayInvokeTuiBearerToken,
} from "../../gateway/invoke/request";
import { writeGatewayInvokeResponse } from "../../gateway/invoke/response";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { InvokeFlags } from ".";

const TUI_FLAGS = [
  "gateway",
  "target",
  "local",
  "path",
  "header",
  "bearer-token",
  "session-id",
  "mcp-session-id",
  "mcp-protocol-version",
];

export async function invokeGateway(
  core: Core,
  io: AppIO,
  ctx: Context,
  gatewayId: string,
  flags: InvokeFlags,
  renderInvokeTui: typeof renderTuiAt,
): Promise<void> {
  const jsonOutput = ctx.require(JsonKey);
  const hasHeadlessOnlyFlag = Object.entries(flags).some(
    ([name, value]) => !TUI_FLAGS.includes(name) && value !== undefined,
  );
  if (!jsonOutput && !hasHeadlessOnlyFlag) {
    const applicationHeaders = parseGatewayInvokeHeaders(flags.header);
    const bearerToken = await resolveGatewayInvokeTuiBearerToken(
      flags["bearer-token"],
      new SourceResolver({ stdin: io.stdin }),
    );
    await renderInvokeTui(
      `/agentcore/invoke/gateway/${encodeURIComponent(gatewayId)}`,
      ctx.withValue(GatewayInvokeLaunchContextKey, {
        gatewayId,
        path: flags.path,
        runtimeSessionId: flags["session-id"],
        mcpSessionId: flags["mcp-session-id"],
        mcpProtocolVersion: flags["mcp-protocol-version"],
        applicationHeaders,
        bearerToken,
      }),
      core,
      io,
    );
    return;
  }

  const applicationHeaders = parseGatewayInvokeHeaders(flags.header);
  const invoke = async (
    signal: AbortSignal,
    beforeOutput: () => Promise<void>,
    sources: Awaited<ReturnType<typeof resolveGatewayInvokeSources>>,
  ) => {
    const options = coreOptsFromCtx(ctx);
    const gateway = await core.gateway.getGateway(gatewayId, options, signal);
    const request = normalizeGatewayInvokeRequest(gateway, {
      gatewayId,
      path: flags.path,
      method: flags.method,
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
      beforeOutput,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new GatewayInvokeResponseError(`HTTP ${response.statusCode}`);
    }
  };
  await withUserCancellation(async (signal) => {
    const sources = await resolveGatewayInvokeSources(
      { payload: flags.payload, bearerToken: flags["bearer-token"] },
      io.stdin,
      signal,
    );
    return runWithProgress((stop) => invoke(signal, stop, sources), {
      io,
      label: "Invoking gateway...",
      interactive: !jsonOutput,
    });
  });
}
