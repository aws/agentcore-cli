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

// updated wraps a PATCH-semantics field: `--<flag> <json>` replaces the value,
// `--clear-<flag> true` sends an empty wrapper (unsetting it), and omitting
// both leaves the field untouched.
function updated<T>(value: T | undefined, clear: boolean): { optionalValue?: T } | undefined {
  if (clear) return {};
  return value !== undefined ? { optionalValue: value } : undefined;
}

const AGENT = "Agent:";
const COMPUTE = "Compute environment:";
const ACCESS = "Access:";
const LIMITS = "Limits:";

export const createUpdateHarnessHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "update a harness (creates a new version)",
    flags: [
      flag("id", "the ID of the harness to update", z.string().max(48).optional(), {
        group: "Target:",
      }),
      flag("execution-role-arn", "IAM role the harness assumes", z.string().optional(), {
        group: "Configuration:",
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
        "clear-memory",
        "clear the memory configuration (pass true)",
        z.enum(["true", "false"]).optional(),
        { group: AGENT },
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
        "clear-environment-artifact",
        "clear the environment artifact (pass true)",
        z.enum(["true", "false"]).optional(),
        { group: COMPUTE },
      ),
      flag(
        "environment-variables",
        "environment variables (JSON object; replaces all existing)",
        z.string().optional(),
        { help: parameterHelp.environmentVariables, group: COMPUTE },
      ),
      flag(
        "authorizer-configuration",
        "inbound authorizer configuration (JSON AuthorizerConfiguration)",
        z.string().optional(),
        { help: parameterHelp.authorizerConfiguration, group: ACCESS },
      ),
      flag(
        "clear-authorizer-configuration",
        "clear the authorizer configuration (pass true)",
        z.enum(["true", "false"]).optional(),
        { group: ACCESS },
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
      // `harness update` falls through to the TUI middleware instead.
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      const response = await core.harness.updateHarness(
        {
          harnessId: flags["id"],
          executionRoleArn: flags["execution-role-arn"],
          systemPrompt: flags["system-prompt"] ? [{ text: flags["system-prompt"] }] : undefined,
          model: parseJsonFlag<HarnessModelConfiguration>("model", flags["model"]),
          tools: parseJsonFlag<HarnessTool[]>("tools", flags["tools"]),
          skills: parseJsonFlag<HarnessSkill[]>("skills", flags["skills"]),
          allowedTools: flags["allowed-tools"],
          memory: updated(
            parseJsonFlag<HarnessMemoryConfiguration>("memory", flags["memory"]),
            flags["clear-memory"] === "true",
          ),
          truncation: parseJsonFlag<HarnessTruncationConfiguration>(
            "truncation",
            flags["truncation"],
          ),
          environment: parseJsonFlag<HarnessEnvironmentProviderRequest>(
            "environment",
            flags["environment"],
          ),
          environmentArtifact: updated(
            parseJsonFlag<HarnessEnvironmentArtifact>(
              "environment-artifact",
              flags["environment-artifact"],
            ),
            flags["clear-environment-artifact"] === "true",
          ),
          environmentVariables: parseJsonFlag<Record<string, string>>(
            "environment-variables",
            flags["environment-variables"],
          ),
          authorizerConfiguration: updated(
            parseJsonFlag<AuthorizerConfiguration>(
              "authorizer-configuration",
              flags["authorizer-configuration"],
            ),
            flags["clear-authorizer-configuration"] === "true",
          ),
          maxIterations: flags["max-iterations"],
          maxTokens: flags["max-tokens"],
          timeoutSeconds: flags["timeout-seconds"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessUpdateScreen } from "./screen.tsx";
