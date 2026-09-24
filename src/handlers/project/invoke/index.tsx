import z from "zod";
import { InputValidationError, ProjectStateError } from "../../../errors";
import type { AppIO } from "../../../io";
import { withProject } from "../../../middleware";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import {
  createHandler,
  flag,
  PathKey,
  ProjectKey,
  type FlagsOf,
  type Handler,
} from "../../../router";
import { attributeName, parseFlags } from "../../../router/flags";
import { renderTuiAt } from "../../../tui";
import { createInvokeGatewayHandler, invokeGatewayFlags } from "../../gateway/invoke";
import { createInvokeHarnessHandler, invokeHarnessFlags } from "../../harness/invoke";
import { AwsCredentialProviderKey, JsonKey, RegionKey } from "../../keys";
import type { Core } from "../../types";
import { assertMutuallyExclusiveFlags, resolveResource } from "../../utils";
import { projectResourceNames, RESOURCE_LABELS } from "../selection";
import type { Project, ProjectInvokableResource } from "../types";
import { createInvokeRuntimeHandler, invokeRuntimeFlags } from "../../runtime/invoke";
import { invokeProjectRuntimeLocally } from "./runtime";

const RESOURCE = "Resource options:";
const RESOURCE_TYPES = ["runtime", "harness", "gateway"] as const;

const resourceFlags = [
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
] as const;

const INVOKE_FLAGS = {
  runtime: invokeRuntimeFlags,
  harness: invokeHarnessFlags,
  gateway: invokeGatewayFlags,
} as const;

type RequestFlag = Exclude<(typeof INVOKE_FLAGS)[ProjectInvokableResource][number], { name: "id" }>;

/**
 One flag per name, in the help group of the resource types that accept it.
**/
function requestFlags(): RequestFlag[] {
  const merged = new Map<string, { flag: RequestFlag; owners: ProjectInvokableResource[] }>();
  for (const resourceType of RESOURCE_TYPES) {
    for (const requestFlag of INVOKE_FLAGS[resourceType]) {
      if (requestFlag.name === "id") continue;
      const entry = merged.get(requestFlag.name) ?? { flag: requestFlag, owners: [] };
      entry.owners.push(resourceType);
      merged.set(requestFlag.name, entry);
    }
  }
  return [...merged.values()].map(({ flag, owners }) => ({
    ...flag,
    group: owners.length === 1 ? `${RESOURCE_LABELS[owners[0]!]} options:` : "Request options:",
  }));
}

const invokeFlags: readonly ((typeof resourceFlags)[number] | RequestFlag)[] = [
  ...resourceFlags,
  ...requestFlags(),
];

export type InvokeFlags = FlagsOf<typeof invokeFlags>;

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
  if (!headless) return undefined;
  if (declared.length === 1) return declared[0];
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

      const resolved = await resolveResource(
        core,
        ctx,
        resourceType,
        identifier,
        flags.target ?? DEFAULT_TARGET_NAME,
      );
      const values: Record<string, unknown> = { ...flags, id: resolved.id };
      const request = parseFlags(
        invoker.flags(),
        Object.fromEntries(invoker.flags().map(({ name }) => [attributeName(name), values[name]])),
      );
      let invokeCtx = ctx
        .withValue(RegionKey, resolved.region)
        .withValue(PathKey, `/agentcore/${resourceType}/invoke`);
      if (resolved.credentials) {
        invokeCtx = invokeCtx.withValue(AwsCredentialProviderKey, resolved.credentials);
      }
      await invoker.handle(invokeCtx, request, {});
    },
  });
}
