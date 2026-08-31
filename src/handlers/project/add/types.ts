import type { AppIO } from "../../../io";
import type { DescribeBedrockAgent } from "../../../core/project/bedrockAgent";
import type { ProjectManager } from "../types";

export type AddProjectResourceConfig = {
  projectManager: ProjectManager;
  io: AppIO;
  /** Describes a Bedrock Agent for --type import; injectable for tests. */
  describeBedrockAgent?: DescribeBedrockAgent;
};
