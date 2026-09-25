import z from "zod";
import { InputValidationError } from "../../../errors";
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
import { projectResourceNames } from "../selection";
import { RESOURCE_LABELS, type ProjectInvokableResource } from "../types";
import { createInvokeRuntimeHandler, invokeRuntimeFlags } from "../../runtime/invoke";
import { invokeProjectRuntimeLocally } from "./runtime";

const RESOURCE = "Resource options:";
const RESOURCE_TYPES = ["runtime", "harness", "gateway"] as const;

const selectionFlags = [
  flag(
    "runtime",
    "the Runtime to invoke: its name in this project, its ID, or its ARN",
    z.string().min(1).optional(),
    { group: RESOURCE },
  ),
  flag(
    "harness",
    "the harness to invoke: its name in this project, its ID, or its ARN",
    z.string().min(1).optional(),
    { group: RESOURCE },
  ),
  flag(
    "gateway",
    "the Gateway to invoke: its name in this project, its ID, or its ARN",
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

const HANDLER_FLAGS = {
  runtime: invokeRuntimeFlags,
  harness: invokeHarnessFlags,
  gateway: invokeGatewayFlags,
} as const;

type HandlerFlag = Exclude<
  (typeof HANDLER_FLAGS)[ProjectInvokableResource][number],
  { name: "id" }
>;

/**
 The flags of the runtime, harness, and gateway invoke commands, one per name, grouped by the types that accept them.
**/
function handlerFlags(): HandlerFlag[] {
  const merged = new Map<string, { flag: HandlerFlag; owners: ProjectInvokableResource[] }>();
  for (const resourceType of RESOURCE_TYPES) {
    for (const handlerFlag of HANDLER_FLAGS[resourceType]) {
      if (handlerFlag.name === "id") continue;
      const entry = merged.get(handlerFlag.name) ?? { flag: handlerFlag, owners: [] };
      entry.owners.push(resourceType);
      merged.set(handlerFlag.name, entry);
    }
  }
  return [...merged.values()].map(({ flag, owners }) => ({
    ...flag,
    group: owners.length === 1 ? `${RESOURCE_LABELS[owners[0]!]} options:` : "Request options:",
  }));
}

const invokeFlags: readonly ((typeof selectionFlags)[number] | HandlerFlag)[] = [
  ...selectionFlags,
  ...handlerFlags(),
];

export type InvokeFlags = FlagsOf<typeof invokeFlags>;

type ResourceSelection = { resourceType: ProjectInvokableResource; identifier: string };

const isSet = (value: unknown) => value !== undefined && value !== false;

function flaggedResource(flags: InvokeFlags, headless: boolean): ResourceSelection | undefined {
  assertMutuallyExclusiveFlags(flags, RESOURCE_TYPES, { exactlyOne: headless });
  const resourceType = RESOURCE_TYPES.find((type) => flags[type] !== undefined);
  return resourceType && { resourceType, identifier: flags[resourceType]! };
}

export function createProjectInvokeHandler(core: Core, io: AppIO) {
  const handlers: Record<ProjectInvokableResource, Handler> = {
    runtime: createInvokeRuntimeHandler(core, io),
    harness: createInvokeHarnessHandler(core, io),
    gateway: createInvokeGatewayHandler(core, io),
  };
  return createHandler({
    name: "invoke",
    description: "invoke a Runtime, harness, or Gateway",
    flags: invokeFlags,
    middlewares: [withProject({ projectManager: core.projectManager, optional: true })],
    handle: async (ctx, flags) => {
      const project = ctx.value(ProjectKey);
      const headless = ctx.require(JsonKey) || Object.values(flags).some(isSet);
      const selection = flaggedResource(flags, headless);
      if (!selection) {
        await renderTuiAt("/agentcore/invoke", ctx, core, io);
        return;
      }

      const { resourceType, identifier } = selection;
      const handler = handlers[resourceType];
      const acceptedFlags = [
        ...RESOURCE_TYPES,
        "target",
        ...(resourceType === "runtime" ? ["local", "port"] : []),
        ...handler.flags().map(({ name }) => name),
      ];
      const unsupported = Object.entries(flags).find(
        ([name, value]) => isSet(value) && !acceptedFlags.includes(name),
      );
      if (unsupported) {
        throw new InputValidationError(
          `--${unsupported[0]} does not apply to a ${RESOURCE_LABELS[resourceType]}`,
        );
      }
      const isProjectName =
        project && projectResourceNames(project, resourceType).includes(identifier);
      for (const name of ["target", "local"] as const) {
        if (isSet(flags[name]) && !isProjectName) {
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

      const resource = await resolveResource(
        core,
        ctx,
        resourceType,
        identifier,
        flags.target ?? DEFAULT_TARGET_NAME,
      );
      const rawHandlerFlags: Record<string, unknown> = { ...flags, id: resource.id };
      const parsedHandlerFlags = parseFlags(
        handler.flags(),
        Object.fromEntries(
          handler.flags().map(({ name }) => [attributeName(name), rawHandlerFlags[name]]),
        ),
      );
      let handlerCtx = ctx
        .withValue(RegionKey, resource.region)
        .withValue(PathKey, `/agentcore/${resourceType}/invoke`);
      if (resource.credentials) {
        handlerCtx = handlerCtx.withValue(AwsCredentialProviderKey, resource.credentials);
      }
      await handler.handle(handlerCtx, parsedHandlerFlags, {});
    },
  });
}
