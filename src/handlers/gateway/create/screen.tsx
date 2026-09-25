import { CliOnlyScreen } from "../../../components/CliOnlyScreen";
import { ProjectResourceCreateScreen } from "../../../components/ProjectResourceCreateScreen";
import { resolveCommand } from "../../../components/RouterScreen";
import { CommandKey } from "../../../router";
import type { ScreenProps } from "../../types";

export function GatewayCreateScreen(props: ScreenProps) {
  const gateway = resolveCommand(props.ctx.require(CommandKey), ["agentcore", "gateway"]);
  const path = ["agentcore", "gateway", "create"];
  if (
    gateway.name() === "gateway" &&
    gateway.commands.some((command) => command.name() === "create")
  ) {
    return <CliOnlyScreen {...props} path={path} />;
  }

  return <ProjectResourceCreateScreen {...props} resource="gateway" />;
}
