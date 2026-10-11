/**
 * Frozen copy of the v0 (0.31.1) project schemas, used only to read unmigrated
 * v0 projects. Do not edit: the contract is "anything v0 0.31.1 accepted is
 * accepted here". See README.md for provenance.
 */
export {
  AgentCoreProjectSpecSchema as V0AgentCoreProjectSpecSchema,
  type AgentCoreProjectSpec as V0ProjectSpec,
} from "./schemas/agentcore-project";
export {
  AwsDeploymentTargetsSchema as V0AwsDeploymentTargetsSchema,
  type AwsDeploymentTarget as V0AwsDeploymentTarget,
} from "./schemas/aws-targets";
export {
  HarnessSpecSchema as V0HarnessSpecSchema,
  type HarnessSpec as V0HarnessSpec,
} from "./schemas/primitives/harness";
export {
  DeployedStateSchema as V0DeployedStateSchema,
  type DeployedState as V0DeployedState,
} from "./schemas/deployed-state";
