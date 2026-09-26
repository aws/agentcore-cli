import { Navigate, Outlet, useLocation, useResolvedPath } from "react-router";
import { CommandKey, type Context } from "../router";
import { commandPath, resolveCommand } from "./RouterScreen";

export function isCommandAvailable(ctx: Context, path: string[]): boolean {
  const command = resolveCommand(ctx.require(CommandKey), path);
  return commandPath(command).join("/") === path.join("/");
}

// Mount at the command's route, above its index and resource-ID routes, so an
// unavailable command cannot mount a screen that fetches or mutates resources.
export function CommandGate({ ctx }: { ctx: Context }) {
  const path = useResolvedPath(".").pathname.split("/").filter(Boolean);
  const locationPath = useLocation().pathname.split("/").filter(Boolean);
  const launchPath = commandPath(ctx.require(CommandKey));
  // Project invoke resolves a project resource before launching these shared
  // consoles. It does not grant access to exec, shell, or other resource actions.
  const isProjectInvoke =
    path.length === 3 &&
    locationPath.length > path.length &&
    path[2] === "invoke" &&
    (path[1] === "harness" || path[1] === "runtime") &&
    launchPath.join("/") === `agentcore/invoke/${path[1]}`;

  return isCommandAvailable(ctx, path) || isProjectInvoke ? (
    <Outlet />
  ) : (
    <Navigate to="/agentcore" replace />
  );
}
