import z from "zod";
import { renderTuiAt } from "../../tui";
import { globalFlag, PathKey, type Middleware } from "../../router";
import { JsonKey } from "../keys";
import type { AppIO, Core } from "../types";

export const RuntimeInteractiveKey = globalFlag(
  "interactive",
  "open the Runtime TUI",
  z.boolean().default(false),
);

function selector(flags: Record<string, unknown>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function runtimeTuiPath(commandPath: string, flags: Record<string, unknown>): string {
  const id = selector(flags, "id");
  const version = selector(flags, "version");
  const qualifier = selector(flags, "qualifier");
  const encodedId = id === undefined ? undefined : encodeURIComponent(id);

  switch (commandPath) {
    case "/agentcore/runtime":
    case "/agentcore/runtime/version":
    case "/agentcore/runtime/endpoint":
    case "/agentcore/runtime/list":
      return commandPath;
    case "/agentcore/runtime/get":
      return encodedId === undefined
        ? "/agentcore/runtime/list"
        : `/agentcore/runtime/get/${encodedId}`;
    case "/agentcore/runtime/version/list":
      return encodedId === undefined
        ? "/agentcore/runtime/version/list"
        : `/agentcore/runtime/version/list/${encodedId}`;
    case "/agentcore/runtime/version/get":
      if (version !== undefined && encodedId === undefined) {
        throw new TypeError("Runtime version requires a Runtime id");
      }
      if (encodedId === undefined) return "/agentcore/runtime/version/list";
      if (version === undefined) return `/agentcore/runtime/version/list/${encodedId}`;
      return `/agentcore/runtime/version/get/${encodedId}/${encodeURIComponent(version)}`;
    case "/agentcore/runtime/endpoint/list":
      return encodedId === undefined
        ? "/agentcore/runtime/endpoint/list"
        : `/agentcore/runtime/endpoint/list/${encodedId}`;
    case "/agentcore/runtime/endpoint/get":
      if (qualifier !== undefined && encodedId === undefined) {
        throw new TypeError("Runtime qualifier requires a Runtime id");
      }
      if (encodedId === undefined) return "/agentcore/runtime/endpoint/list";
      if (qualifier === undefined) return `/agentcore/runtime/endpoint/list/${encodedId}`;
      return `/agentcore/runtime/endpoint/get/${encodedId}/${encodeURIComponent(qualifier)}`;
    default:
      throw new TypeError(`unknown Runtime command path: ${commandPath}`);
  }
}

export function withRuntimeInteractive(core: Core, io: AppIO): Middleware {
  return (handler) => ({
    name: () => handler.name(),
    description: () => handler.description(),
    flags: () => handler.flags(),
    arguments: () => handler.arguments(),
    children: () => handler.children(),
    handle: async (ctx, flags, args) => {
      if (!ctx.require(RuntimeInteractiveKey)) {
        await handler.handle(ctx, flags, args);
        return;
      }
      if (ctx.require(JsonKey)) {
        throw new TypeError("--interactive cannot be combined with --json");
      }

      await renderTuiAt(runtimeTuiPath(ctx.require(PathKey), flags), ctx, core, io);
    },
  });
}
