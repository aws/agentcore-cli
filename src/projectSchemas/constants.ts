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
export const PlatformVersionSchema = z.enum(["V1", "V2"]);
export type PlatformVersion = z.infer<typeof PlatformVersionSchema>;
export const VPC_ID_PATTERN = /^vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
export const SUBNET_ID_PATTERN = /^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
export const SECURITY_GROUP_ID_PATTERN = /^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
export const MAX_CONTAINER_BUILD_SECURITY_GROUPS = 5;
/**
 * A private ECR image URI (`<12-digit account>.dkr.ecr.<region>.amazonaws.com[.cn]/<repository>`)
 * or a public one (`public.ecr.aws/<alias>/<repository>`), with an optional tag and digest.
 * Groups: 1 account, 2 region, 3 `.cn`, 4 private repository, 5 public alias,
 * 6 public repository, 7 tag, 8 digest.
 */
export const CONTAINER_URI_PATTERN =
  /^(?:([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?\/((?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)|public\.ecr\.aws\/([a-z0-9]+(?:[._-][a-z0-9]+)*)\/((?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*))(?::([^:@]{1,300}))?(?:@(.+))?$/;
export const MAX_CONTAINER_URI_LENGTH = 1024;
// The service's image tag and digest grammar, and its repository name lengths.
const CONTAINER_IMAGE_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const CONTAINER_IMAGE_DIGEST_PATTERN = /^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/;
const MIN_REPOSITORY_NAME_LENGTH = 2;
const MAX_PRIVATE_REPOSITORY_NAME_LENGTH = 256;
const MAX_PUBLIC_REPOSITORY_NAME_LENGTH = 205;
export const ContainerUriSchema = z
  .string()
  .min(1)
  .max(MAX_CONTAINER_URI_LENGTH)
  .superRefine((uri, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (/\s/.test(uri)) return fail("containerUri must not contain whitespace");
    const match = CONTAINER_URI_PATTERN.exec(uri);
    if (!match) {
      if (/^public\.ecr\.aws\/[^/:@]*(?:[:@]|$)/.test(uri)) {
        return fail(
          "containerUri for public.ecr.aws must name a registry alias and a repository: " +
            "public.ecr.aws/<alias>/<repository>[:tag][@digest]",
        );
      }
      return fail("containerUri must be an ECR image URI (12-digit private ECR or public.ecr.aws)");
    }
    const [, , , , privateRepository, , publicRepository, tag, digest] = match;
    // The public registry alias is not part of the repository name.
    const repository = privateRepository ?? publicRepository ?? "";
    const maxRepositoryLength =
      publicRepository !== undefined
        ? MAX_PUBLIC_REPOSITORY_NAME_LENGTH
        : MAX_PRIVATE_REPOSITORY_NAME_LENGTH;
    if (repository.length < MIN_REPOSITORY_NAME_LENGTH || repository.length > maxRepositoryLength) {
      fail(
        `containerUri repository name must be ${MIN_REPOSITORY_NAME_LENGTH}-${maxRepositoryLength} characters`,
      );
    }
    if (tag !== undefined && !CONTAINER_IMAGE_TAG_PATTERN.test(tag)) {
      fail(
        "containerUri tag must start with a letter, digit or '_' and have at most 128 letters, " +
          "digits, '.', '_' or '-'",
      );
    }
    if (digest !== undefined && !CONTAINER_IMAGE_DIGEST_PATTERN.test(digest)) {
      fail("containerUri digest must be sha256:<64 hex digits> or sha512:<128 hex digits>");
    }
  });
export function isContainerBuild(spec: {
  build?: string;
  containerUri?: string;
  dockerfile?: string;
}): boolean {
  return (
    spec.build === "Container" ||
    spec.build === "ContainerLocal" ||
    !!spec.containerUri ||
    !!spec.dockerfile
  );
}
export const ProtocolModeSchema = z.enum(["HTTP", "MCP", "A2A", "AGUI"]);
export type ProtocolMode = z.infer<typeof ProtocolModeSchema>;
