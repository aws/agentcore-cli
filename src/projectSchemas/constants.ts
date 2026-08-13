import z from "zod";
const RESERVED_PROJECT_NAMES: readonly string[] = [
  "anthropic",
  "autogen",
  "autogenagentchat",
  "autogenext",
  "bedrock",
  "bedrockagentcore",
  "crewai",
  "crewaitools",
  "googleadk",
  "googlegenerativeai",
  "langchain",
  "langchainanthropic",
  "langchainaws",
  "langchaingooglegenai",
  "langchainmcpadapters",
  "langchainopenai",
  "langgraph",
  "mcp",
  "openai",
  "openaiagents",
  "strands",
  "strandsagents",
  "strandsagentstools",
  "agui",
  "aguistrands",
  "aguilanggraph",
  "aguiadk",
  "aguiprotocol",
  "vercelai",
  "aisdk",
  "httpx",
  "pytest",
  "pytestasyncio",
  "pythondotenv",
  "tiktoken",
  "hatchling",
  "setuptools",
  "wheel",
  "awsopentelemetrydistro",
  "boto3",
  "botocore",
  "test",
  "tests",
  "src",
  "lib",
  "dist",
  "build",
  "env",
  "venv",
  "site",
  "pip",
  "uv",
];
export function isReservedProjectName(name: string): boolean {
  return RESERVED_PROJECT_NAMES.includes(name.toLowerCase());
}
export const PythonRuntimeSchema = z.enum([
  "PYTHON_3_10",
  "PYTHON_3_11",
  "PYTHON_3_12",
  "PYTHON_3_13",
  "PYTHON_3_14",
]);
export type PythonRuntime = z.infer<typeof PythonRuntimeSchema>;
export const NodeRuntimeSchema = z.enum(["NODE_18", "NODE_20", "NODE_22"]);
export type NodeRuntime = z.infer<typeof NodeRuntimeSchema>;
export const RuntimeVersionSchema = z.union([PythonRuntimeSchema, NodeRuntimeSchema]);
export type RuntimeVersion = z.infer<typeof RuntimeVersionSchema>;
export const NetworkModeSchema = z.enum(["PUBLIC", "VPC"]);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;
export const VPC_ID_PATTERN = /^vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
export const SUBNET_ID_PATTERN = /^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
export const SECURITY_GROUP_ID_PATTERN = /^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
export const MAX_CONTAINER_BUILD_SECURITY_GROUPS = 5;
export function isContainerBuild(spec: {
  build?: string;
  containerUri?: string;
  dockerfile?: string;
}): boolean {
  return spec.build === "Container" || !!spec.containerUri || !!spec.dockerfile;
}
export const ProtocolModeSchema = z.enum(["HTTP", "MCP", "A2A", "AGUI"]);
export type ProtocolMode = z.infer<typeof ProtocolModeSchema>;
