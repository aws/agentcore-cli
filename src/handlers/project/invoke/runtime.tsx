import { ExitCode, InputValidationError, RuntimeInvokeResponseError } from "../../../errors";
import { invokeLocalRuntime } from "../../../core/dev/localInvoke";
import { DEV_PORTS } from "../../../core/dev/port";
import type { AppIO } from "../../../io";
import type { Context } from "../../../router";
import { withUserCancellation } from "../../../runnable";
import type { renderTuiAt } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey } from "../../keys";
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
import type { Project } from "../types";
import type { InvokeFlags } from ".";

const TUI_FLAGS = [
  "runtime",
  "target",
  "local",
  "qualifier",
  "session-id",
  "user-id",
  "header",
  "bearer-token",
];

export async function invokeProjectRuntimeLocally(
  io: AppIO,
  ctx: Context,
  runtime: Project["spec"]["runtimes"][number],
  flags: InvokeFlags,
): Promise<void> {
  const jsonOutput = ctx.require(JsonKey);
  const protocol = runtime.protocol ?? "HTTP";
  const unsupportedFlag = Object.entries({
    target: flags.target,
    qualifier: flags.qualifier,
    "bearer-token": flags["bearer-token"],
  }).find(([, value]) => value !== undefined)?.[0];
  if (unsupportedFlag !== undefined) {
    throw new InputValidationError(`--${unsupportedFlag} cannot be used with --local`);
  }
  if (
    protocol !== "MCP" &&
    [
      flags["mcp-session-id"],
      flags["mcp-protocol-version"],
      flags["mcp-method"],
      flags["mcp-name"],
    ].some((value) => value !== undefined)
  ) {
    throw new InputValidationError("MCP options are only valid for MCP Runtimes");
  }
  if (flags.payload === undefined) {
    throw new InputValidationError("required option '--payload <payload>' not specified", {
      exitCode: ExitCode.USAGE,
    });
  }

  const applicationHeaders = parseRuntimeInvokeHeaders(flags.header);
  const invoke = async (
    signal: AbortSignal,
    beforeOutput: () => Promise<void>,
    sources: Awaited<ReturnType<typeof resolveRuntimeInvokeSources>>,
  ) => {
    const response = await invokeLocalRuntime(
      {
        port: flags.port ?? DEV_PORTS[protocol],
        protocol,
        payload: sources.payload,
        contentType: flags["content-type"],
        accept: flags.accept,
        runtimeSessionId: flags["session-id"],
        runtimeUserId: flags["user-id"],
        applicationHeaders,
        mcpSessionId: flags["mcp-session-id"],
        mcpProtocolVersion: flags["mcp-protocol-version"],
        mcpMethod: flags["mcp-method"],
        mcpName: flags["mcp-name"],
        traceId: flags["trace-id"],
        traceParent: flags["trace-parent"],
        traceState: flags["trace-state"],
        baggage: flags.baggage,
      },
      signal,
    );
    // Local agent error bodies are useful diagnostics, so write them before returning nonzero.
    await writeRuntimeInvokeResponse(response, {
      stdout: io.stdout,
      stderr: io.stderr,
      outputFile: flags["output-file"],
      json: jsonOutput,
      signal,
      beforeOutput,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new RuntimeInvokeResponseError(`HTTP ${response.statusCode}`);
    }
  };
  await withUserCancellation(async (signal) => {
    const sources = await resolveRuntimeInvokeSources(
      { payload: flags.payload! },
      io.stdin,
      signal,
    );
    return runWithProgress((stop) => invoke(signal, stop, sources), {
      io,
      label: "Invoking runtime...",
      interactive: !jsonOutput,
    });
  });
}

export async function invokeRuntime(
  core: Core,
  io: AppIO,
  ctx: Context,
  runtimeId: string,
  flags: InvokeFlags,
  renderInvokeTui: typeof renderTuiAt,
): Promise<void> {
  const jsonOutput = ctx.require(JsonKey);
  if (flags.payload === undefined) {
    const hasHeadlessOnlyFlag = Object.entries(flags).some(
      ([flagName, value]) => !TUI_FLAGS.includes(flagName) && value !== undefined,
    );
    if (jsonOutput || hasHeadlessOnlyFlag) {
      throw new InputValidationError("required option '--payload <payload>' not specified", {
        exitCode: ExitCode.USAGE,
      });
    }
    let path = `/agentcore/invoke/runtime/${encodeURIComponent(runtimeId)}`;
    if (flags.qualifier !== undefined) path += `/${encodeURIComponent(flags.qualifier)}`;
    const applicationHeaders = parseRuntimeInvokeHeaders(flags.header);
    const bearerToken = await resolveRuntimeInvokeTuiBearerToken(flags["bearer-token"], io.stdin);
    await renderInvokeTui(
      path,
      ctx.withValue(RuntimeInvokeLaunchContextKey, {
        runtimeId,
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

  const applicationHeaders = parseRuntimeInvokeHeaders(flags.header);
  const invoke = async (
    signal: AbortSignal,
    beforeOutput: () => Promise<void>,
    sources: Awaited<ReturnType<typeof resolveRuntimeInvokeSources>>,
  ) => {
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
      coreOptsFromCtx(ctx),
      signal,
    );
    await writeRuntimeInvokeResponse(response, {
      stdout: io.stdout,
      stderr: io.stderr,
      outputFile: flags["output-file"],
      json: jsonOutput,
      signal,
      beforeOutput,
    });
  };
  await withUserCancellation(async (signal) => {
    const sources = await resolveRuntimeInvokeSources(
      { payload: flags.payload!, bearerToken: flags["bearer-token"] },
      io.stdin,
      signal,
    );
    return runWithProgress((stop) => invoke(signal, stop, sources), {
      io,
      label: "Invoking runtime...",
      interactive: !jsonOutput,
    });
  });
}
