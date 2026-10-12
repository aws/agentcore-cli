import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { CommandKey, isTuiCommandSupported } from "../router";
import type { ScreenProps } from "../handlers/types";
import { RouterScreen, commandPath, resolveCommand } from "./RouterScreen";

// A known command without a dedicated route opens its menu only when it has
// TUI support. CLI-only commands return to the nearest supported parent.
// Unknown paths retain the existing HelpScreen fallback.
export function CommandFallbackScreen({
  unknownFallback,
  ...props
}: ScreenProps & { unknownFallback: ReactNode }) {
  const { pathname } = useLocation();
  const path = pathname.split("/").filter((segment) => segment !== "");
  const command = resolveCommand(props.ctx.require(CommandKey), path);
  const resolved = commandPath(command);
  const isExactCommand =
    resolved.length === path.length && resolved.every((segment, index) => segment === path[index]);

  if (!isExactCommand) return unknownFallback;
  if (isTuiCommandSupported(command) && command.commands.length > 0) {
    return <RouterScreen {...props} path={resolved} />;
  }

  let parent = command.parent;
  while (parent?.parent && !isTuiCommandSupported(parent)) parent = parent.parent;
  return <Navigate to={"/" + commandPath(parent ?? command).join("/")} replace />;
}
