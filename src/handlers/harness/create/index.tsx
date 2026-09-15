import z from "zod";
import type {
  AuthorizerConfiguration,
  HarnessEnvironmentArtifact,
  HarnessEnvironmentProviderRequest,
  HarnessMemoryConfiguration,
  HarnessModelConfiguration,
  HarnessSkill,
  HarnessTool,
  HarnessTruncationConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../router";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx, parseJsonFlag } from "../../utils.tsx";
import { JsonRendererKey } from "../../../tui";
import { InputValidationError } from "../../../errors";
import { parameterHelp } from "../parameterHelp.tsx";

const CONFIGURATION = "Configuration:";
const AGENT = "Agent:";
const COMPUTE = "Compute environment:";
const ACCESS = "Access:";
const LIMITS = "Limits:";

export const createCreateHarnessHandler = (core: Core) =>
  createHandler({
    name: "create",
    description: "create a harness",
    flags: [
      flag("name", "the name of the harness", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag(
        "execution-role-arn",
        "IAM role the harness assumes; a default role is created when omitted",
        z.string().optional(),
        { group: CONFIGURATION },
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional(), {
        help: parameterHelp.tags,
        group: CONFIGURATION,
      }),
      flag("system-prompt", "the agent's system prompt", z.string().optional(), {
        group: AGENT,
      }),
      flag("model", "model configuration (JSON HarnessModelConfiguration)", z.string().optional(), {
        help: parameterHelp.model,
        group: AGENT,
      }),
      flag("tools", "tools available to the agent (JSON HarnessTool[])", z.string().optional(), {
        help: parameterHelp.tools,
        group: AGENT,
      }),
      flag("skills", "skills available to the agent (JSON HarnessSkill[])", z.string().optional(), {
        help: parameterHelp.skills,
        group: AGENT,
      }),
      flag(
        "allowed-tools",
        "tool allowlist patterns (e.g. * or @serverName/toolName)",
        z.array(z.string()).optional(),
        { help: parameterHelp.allowedTools, group: AGENT },
      ),
      flag(
        "memory",
        "memory configuration (JSON HarnessMemoryConfiguration)",
        z.string().optional(),
        { help: parameterHelp.memory, group: AGENT },
      ),
      flag(
        "truncation",
        "context truncation configuration (JSON HarnessTruncationConfiguration)",
        z.string().optional(),
        { help: parameterHelp.truncation, group: AGENT },
      ),
      flag(
        "environment",
        "compute environment configuration (JSON HarnessEnvironmentProviderRequest)",
        z.string().optional(),
        { help: parameterHelp.environment, group: COMPUTE },
      ),
      flag(
        "environment-artifact",
        "environment artifact, e.g. a container image (JSON HarnessEnvironmentArtifact)",
        z.string().optional(),
        { help: parameterHelp.environmentArtifact, group: COMPUTE },
      ),
      flag(
        "environment-variables",
        "environment variables (JSON object of key/value strings)",
        z.string().optional(),
        { help: parameterHelp.environmentVariables, group: COMPUTE },
      ),
      flag(
        "authorizer-configuration",
        "inbound authorizer configuration (JSON AuthorizerConfiguration)",
        z.string().optional(),
        { help: parameterHelp.authorizerConfiguration, group: ACCESS },
      ),
      flag("max-iterations", "max agent loop iterations per invocation", z.number().optional(), {
        group: LIMITS,
      }),
      flag("max-tokens", "max total output tokens per invocation", z.number().optional(), {
        group: LIMITS,
      }),
      flag("timeout-seconds", "max duration in seconds per invocation", z.number().optional(), {
        group: LIMITS,
      }),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare
      // `harness create` falls through to the TUI middleware instead.
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const response = await core.harness.createHarness(
        {
          harnessName: flags["name"],
          executionRoleArn: flags["execution-role-arn"],
          systemPrompt: flags["system-prompt"] ? [{ text: flags["system-prompt"] }] : undefined,
          model: parseJsonFlag<HarnessModelConfiguration>("model", flags["model"]),
          tools: parseJsonFlag<HarnessTool[]>("tools", flags["tools"]),
          skills: parseJsonFlag<HarnessSkill[]>("skills", flags["skills"]),
          allowedTools: flags["allowed-tools"],
          memory: parseJsonFlag<HarnessMemoryConfiguration>("memory", flags["memory"]),
          truncation: parseJsonFlag<HarnessTruncationConfiguration>(
            "truncation",
            flags["truncation"],
          ),
          environment: parseJsonFlag<HarnessEnvironmentProviderRequest>(
            "environment",
            flags["environment"],
          ),
          environmentArtifact: parseJsonFlag<HarnessEnvironmentArtifact>(
            "environment-artifact",
            flags["environment-artifact"],
          ),
          environmentVariables: parseJsonFlag<Record<string, string>>(
            "environment-variables",
            flags["environment-variables"],
          ),
          authorizerConfiguration: parseJsonFlag<AuthorizerConfiguration>(
            "authorizer-configuration",
            flags["authorizer-configuration"],
          ),
          maxIterations: flags["max-iterations"],
          maxTokens: flags["max-tokens"],
          timeoutSeconds: flags["timeout-seconds"],
          tags: parseJsonFlag<Record<string, string>>("tags", flags["tags"]),
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessCreateScreen } from "./screen.tsx";
