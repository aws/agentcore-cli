import z from "zod";
import { regionFromArn, serviceIdFromArn } from "../../../core/arn";
import { InputValidationError, ProjectStateError } from "../../../errors";
import type { AppIO } from "../../../io";
import { withProject } from "../../../middleware";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import {
  createHandler,
  flag,
  PathKey,
  ProjectKey,
  ProjectTargetKey,
  type FlagsOf,
  type Handler,
} from "../../../router";
import { attributeName, parseFlags } from "../../../router/flags";
import { renderTuiAt } from "../../../tui";
import { createInvokeGatewayHandler } from "../../gateway/invoke";
import { createInvokeHarnessHandler } from "../../harness/invoke";
import { JsonKey, RegionKey } from "../../keys";
import type { Core } from "../../types";
import { assertMutuallyExclusiveFlags, toResourceArn } from "../../utils";
import { projectResourceNames, RESOURCE_LABELS } from "../selection";
import type { Project, ProjectInvokableResource } from "../types";
import { createInvokeRuntimeHandler } from "../../runtime/invoke";
import { invokeProjectRuntimeLocally } from "./runtime";

const RESOURCE = "Resource options:";
const REQUEST = "Request options:";
const RUNTIME = "Runtime options:";
const GATEWAY = "Gateway options:";
const MCP = "MCP options (Runtime, Gateway):";

const invokeFlags = [
  flag(
    "runtime",
    "the Runtime to invoke: a project name, ID, or ARN",
    z.string().min(1).optional(),
    { group: RESOURCE },
  ),
  flag(
    "harness",
    "the harness to invoke: a project name, ID, or ARN",
    z.string().min(1).optional(),
    { group: RESOURCE },
  ),
  flag(
    "gateway",
    "the Gateway to invoke: a project name, ID, or ARN",
    z.string().min(1).optional(),
    { group: RESOURCE },
  ),
  flag(
    "target",
    `project deployment target (default: "${DEFAULT_TARGET_NAME}")`,
    z.string().min(1).optional(),
    { group: RESOURCE },
  ),
  flag("local", "invoke the local development server (project Runtime only)", z.boolean(), {
    group: RESOURCE,
  }),
  flag(
    "port",
    "local development server port (defaults: HTTP/AG-UI 8080, MCP 8000, A2A 9000)",
    z.coerce.number().int().min(1).max(65535).optional(),
    { group: RESOURCE },
  ),
  flag("payload", "the inline payload to send", z.string().optional(), {
    sensitive: true,
    group: REQUEST,
  }),
  flag("prompt", "the message to send to a harness", z.string().optional(), { group: REQUEST }),
  flag(
    "session-id",
    "the session ID to continue (33-100 characters for a harness)",
    z.string().optional(),
    { group: REQUEST },
  ),
  flag("qualifier", "the endpoint qualifier (default DEFAULT)", z.string().optional(), {
    group: REQUEST,
  }),
  flag("content-type", "the payload content type", z.string().optional(), { group: REQUEST }),
  flag("accept", "the accepted response content type", z.string().optional(), { group: REQUEST }),
  flag("header", "an ordered application header", z.array(z.string()).optional(), {
    sensitive: true,
    group: REQUEST,
  }),
  flag("bearer-token", "the CUSTOM_JWT bearer token", z.string().optional(), {
    sensitive: true,
    group: REQUEST,
  }),
  flag(
    "output-file",
    "the response output file",
    z.string().min(1, "requires a nonempty path").optional(),
    { group: REQUEST },
  ),
  flag("user-id", 'the Runtime user ID (default "default")', z.string().optional(), {
    group: RUNTIME,
  }),
  flag("mcp-method", "the MCP method", z.string().optional(), { group: RUNTIME }),
  flag("mcp-name", "the MCP tool, resource, or prompt name", z.string().optional(), {
    group: RUNTIME,
  }),
  flag("trace-id", "the X-Ray trace ID", z.string().optional(), { group: RUNTIME }),
  flag("trace-parent", "the W3C trace parent", z.string().optional(), { group: RUNTIME }),
  flag("trace-state", "the W3C trace state", z.string().optional(), { group: RUNTIME }),
  flag("baggage", "the W3C baggage", z.string().optional(), { group: RUNTIME }),
  flag(
    "path",
    "the path relative to the Gateway origin",
    z.string().min(1, "requires a nonempty path").optional(),
    { sensitive: true, group: GATEWAY },
  ),
  flag("method", "the HTTP request method", z.enum(["GET", "POST", "DELETE"]).optional(), {
    group: GATEWAY,
  }),
  flag("mcp-session-id", "the MCP session ID", z.string().optional(), { group: MCP }),
  flag("mcp-protocol-version", "the MCP protocol version", z.string().optional(), {
    group: MCP,
  }),
] as const;

export type InvokeFlags = FlagsOf<typeof invokeFlags>;

const RESOURCE_TYPES = ["runtime", "harness", "gateway"] as const;

const isSet = (value: unknown) => value !== undefined && value !== false;

function selectResource(
  project: Project | undefined,
  flags: InvokeFlags,
  headless: boolean,
): [ProjectInvokableResource, string] | undefined {
  assertMutuallyExclusiveFlags(flags, RESOURCE_TYPES);
  const given = RESOURCE_TYPES.find((resourceType) => flags[resourceType] !== undefined);
  if (given) return [given, flags[given]!];

  if (!project) {
    if (!headless) return undefined;
    throw new ProjectStateError(
      `No AgentCore project found at ${process.cwd()} or any parent directory. ` +
        "Run from inside a project, or pass --runtime, --harness, or --gateway with an ID or ARN.",
    );
  }

  const declared = RESOURCE_TYPES.flatMap((resourceType) =>
    projectResourceNames(project, resourceType).map(
      (name) => [resourceType, name] as [ProjectInvokableResource, string],
    ),
  );
  if (declared.length === 1) return declared[0];
  if (!headless) return undefined;
  if (declared.length === 0) {
    throw new InputValidationError(
      "This project has no Runtimes, harnesses, or Gateways to invoke.",
    );
  }
  throw new InputValidationError(
    `Choose a resource to invoke: ${declared.map(([type, name]) => `--${type} ${name}`).join(", ")}.`,
  );
}

export function createProjectInvokeHandler(core: Core, io: AppIO) {
  const invokers: Record<ProjectInvokableResource, Handler> = {
    runtime: createInvokeRuntimeHandler(core, io),
    harness: createInvokeHarnessHandler(core, io),
    gateway: createInvokeGatewayHandler(core, io),
  };
  return createHandler({
    name: "invoke",
    description: "invoke a Runtime, harness, or Gateway",
    flags: invokeFlags,
    middlewares: [withProject({ projectManager: core.projectManager, optional: true })],
    examples: [
      { description: "Choose a project resource to invoke", command: "agentcore invoke" },
      {
        description: "Send a payload to a project Runtime",
        command: `agentcore invoke --runtime checkout --payload '{"prompt":"Hello"}'`,
      },
      {
        description: "Send a prompt to a harness by ID",
        command: `agentcore invoke --harness support-AbCdEf1234 --prompt "Hello"`,
      },
      {
        description: "List the tools on a Gateway by ARN",
        command:
          "agentcore invoke --gateway arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/tools-AbCdEf1234 " +
          `--path /mcp --payload '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      },
      {
        description: "Invoke a Runtime on the local development server",
        command: `agentcore invoke --runtime checkout --local --payload '{"prompt":"Hello"}'`,
      },
    ],
    handle: async (ctx, flags) => {
      const project = ctx.value(ProjectKey);
      const headless = ctx.require(JsonKey) || Object.values(flags).some(isSet);
      const selected = selectResource(project, flags, headless);
      if (!selected) {
        await renderTuiAt("/agentcore/invoke", ctx, core, io);
        return;
      }

      const [resourceType, identifier] = selected;
      const invoker = invokers[resourceType];
      const allowed = [
        ...RESOURCE_TYPES,
        "target",
        ...(resourceType === "runtime" ? ["local", "port"] : []),
        ...invoker.flags().map(({ name }) => name),
      ];
      const misplaced = Object.entries(flags).find(
        ([name, value]) => isSet(value) && !allowed.includes(name),
      );
      if (misplaced) {
        throw new InputValidationError(
          `--${misplaced[0]} does not apply to a ${RESOURCE_LABELS[resourceType]}`,
        );
      }
      const projectName =
        project && projectResourceNames(project, resourceType).includes(identifier);
      for (const name of ["target", "local"] as const) {
        if (isSet(flags[name]) && !projectName) {
          throw new InputValidationError(`--${name} only applies to project resources`);
        }
      }
      if (!flags.local && flags.port !== undefined) {
        throw new InputValidationError("--port requires --local");
      }
      if (flags.local) {
        const runtime = project!.spec.runtimes.find(({ name }) => name === identifier)!;
        await invokeProjectRuntimeLocally(io, ctx, runtime, flags);
        return;
      }

      const arn = await toResourceArn(
        core,
        ctx.withValue(ProjectTargetKey, flags.target ?? DEFAULT_TARGET_NAME),
        resourceType,
        identifier,
      );
      const values: Record<string, unknown> = { ...flags, id: serviceIdFromArn(arn) };
      const request = parseFlags(
        invoker.flags(),
        Object.fromEntries(invoker.flags().map(({ name }) => [attributeName(name), values[name]])),
      );
      await invoker.handle(
        ctx
          .withValue(RegionKey, regionFromArn(arn)!)
          .withValue(PathKey, `/agentcore/${resourceType}/invoke`),
        request,
        {},
      );
    },
  });
}
