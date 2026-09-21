import { Text } from "ink";
import type { ScreenProps } from "../handlers/types";
import { CommandInfoScreen } from "./CliOnlyScreen";
import { darkTheme } from "./ui/_core.js";

export type ProjectOnlyResource = "runtime" | "memory";

const RESOURCES: Record<
  ProjectOnlyResource,
  { label: string; pluralLabel: string; description: string; addCommand: string }
> = {
  runtime: {
    label: "Runtime",
    pluralLabel: "Runtimes",
    description: "create an AgentCore Runtime in a project",
    addCommand: "agentcore project add runtime",
  },
  memory: {
    label: "Memory",
    pluralLabel: "Memories",
    description: "create an AgentCore Memory in a project",
    addCommand: "agentcore project add memory",
  },
};

export function projectCreateTuiCommand(resource: ProjectOnlyResource) {
  return {
    name: "create",
    description: RESOURCES[resource].description,
  };
}

interface ProjectResourceCreateScreenProps extends ScreenProps {
  resource: ProjectOnlyResource;
}

// Runtime and Memory do not have imperative create commands. This screen keeps
// their TUI menus discoverable while directing creation through the project
// workflow that owns and deploys those resources.
export function ProjectResourceCreateScreen({ resource }: ProjectResourceCreateScreenProps) {
  const config = RESOURCES[resource];

  return (
    <CommandInfoScreen path={["agentcore", resource, "create"]} description={config.description}>
      <Text bold color={darkTheme.colors.primary}>
        {`Create an AgentCore ${config.label}`}
      </Text>
      <Text> </Text>
      <Text color={darkTheme.colors.muted}>
        {`AgentCore ${config.pluralLabel} are created and managed as part of an AgentCore project.`}
      </Text>
      <Text> </Text>
      <Text>Run these commands from the command line:</Text>
      <Text> </Text>
      <Text color={darkTheme.colors.primary}>{"  agentcore project create"}</Text>
      <Text color={darkTheme.colors.primary}>{"  cd <project-directory>"}</Text>
      <Text color={darkTheme.colors.primary}>{`  ${config.addCommand}`}</Text>
      <Text color={darkTheme.colors.primary}>{"  agentcore project deploy"}</Text>
    </CommandInfoScreen>
  );
}
