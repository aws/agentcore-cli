import { ExitCode, InputValidationError, RuntimeInvokeResponseError } from "../../../errors";
import { invokeLocalRuntime } from "../../../core/dev/localInvoke";
import { DEV_PORTS } from "../../../core/dev/port";
import type { AppIO } from "../../../io";
import type { Context } from "../../../router";
import { withUserCancellation } from "../../../runnable";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey } from "../../keys";
import {
  parseRuntimeInvokeHeaders,
  resolveRuntimeInvokeSources,
} from "../../runtime/invoke/request";
import { writeRuntimeInvokeResponse } from "../../runtime/invoke/response";
import type { Project } from "../types";
import type { InvokeFlags } from ".";

export async function invokeProjectRuntimeLocally(
  io: AppIO,
  ctx: Context,
  runtime: Project["spec"]["runtimes"][number],
  flags: InvokeFlags,
): Promise<void> {
  const jsonOutput = ctx.require(JsonKey);
  if (jsonOutput && flags["output-file"] !== undefined) {
    throw new InputValidationError("--json cannot be used with --output-file");
  }
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
