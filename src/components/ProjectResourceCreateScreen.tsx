import { Text } from "ink";
import type { ScreenProps } from "../handlers/types";
import { CommandInfoScreen } from "./CliOnlyScreen";
import { darkTheme } from "./ui/_core.js";

export type ProjectCreateResource = "runtime" | "memory" | "gateway";

const RESOURCES: Record<
  ProjectCreateResource,
  { label: string; pluralLabel: string; description: string; addCommand: string }
> = {
  runtime: {
    label: "Runtime",
    pluralLabel: "Runtimes",
    description: "create an AgentCore Runtime in a project",
    addCommand: "agentcore add runtime",
  },
  memory: {
    label: "Memory",
    pluralLabel: "Memories",
    description: "create an AgentCore Memory in a project",
    addCommand: "agentcore add memory",
  },
  gateway: {
    label: "Gateway",
    pluralLabel: "Gateways",
    description: "create an AgentCore Gateway in a project",
    addCommand: "agentcore add gateway --name MyGateway",
  },
};

export function projectCreateTuiCommand(resource: ProjectCreateResource) {
  return {
    name: "create",
    description: RESOURCES[resource].description,
  };
}

interface ProjectResourceCreateScreenProps extends ScreenProps {
  resource: ProjectCreateResource;
}

// This is informational only: Runtimes, Memories, and Gateways are created
// through AgentCore projects, so there is no standalone create command.
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
      <Text color={darkTheme.colors.primary}>{"  agentcore create"}</Text>
      <Text color={darkTheme.colors.primary}>{"  cd <project-directory>"}</Text>
      <Text color={darkTheme.colors.primary}>{`  ${config.addCommand}`}</Text>
      <Text color={darkTheme.colors.primary}>{"  agentcore deploy"}</Text>
    </CommandInfoScreen>
  );
}
