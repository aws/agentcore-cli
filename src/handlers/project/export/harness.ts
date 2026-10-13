import { dirname, relative } from "node:path";
import z from "zod";
import {
  InputValidationError,
  MalformedServiceResponseError,
  ResourceNotFoundError,
} from "../../../errors";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey } from "../../keys";
import { AgentNameSchema } from "../../../projectSchemas/runtime";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { defaultExportProjectName } from "../../../core/project/fsUtils";
import { assertMutuallyExclusiveFlags, coreOptsFromCtx } from "../../utils";
import type { ExportHarnessInput } from "../types";
import type { ExportProjectResourceConfig } from "./types";
import { harnessIdFromArn, mapServiceHarnessToSpec, regionFromHarnessArn } from "./serviceHarness";

export const createExportHarnessHandler = (config: ExportProjectResourceConfig) =>
  createHandler({
    name: "harness",
    description:
      "convert a managed harness into a code-defined harness with the Strands Harness SDK, creating a project if needed",
    flags: [
      flag(
        "project-name",
        "name of the project to create when exporting outside a project",
        ProjectNameSchema.optional(),
      ),
      flag("name", "the name of an in-project harness to export", z.string().optional()),
      flag(
        "arn",
        "the ARN of a deployed harness to fetch from the service and export",
        z.string().optional(),
      ),
      flag(
        "target-agent-name",
        "the name of the generated Runtime agent (default <harnessName>Agent)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      assertMutuallyExclusiveFlags(flags, ["name", "arn"], { exactlyOne: true });

      const project = ctx.value(ProjectKey);
      const jsonOutput = ctx.require(JsonKey);
      if (project && flags["project-name"]) {
        throw new InputValidationError(
          "--project-name is only available outside an existing project",
        );
      }

      const result = await runWithProgress(
        (async function* () {
          let input: ExportHarnessInput;
          if (flags.arn) {
            const harnessId = harnessIdFromArn(flags.arn);
            // The ARN's region takes precedence over the CLI's resolved region.
            const coreOpts = coreOptsFromCtx(ctx);
            const region = regionFromHarnessArn(flags.arn);
            yield { type: "step" as const, message: "Fetching harness from the service" };
            const response = await config.core.harness.getHarness(harnessId, {
              ...coreOpts,
              region,
            });
            if (!response.harness) {
              throw new ResourceNotFoundError(`no harness exists for '${flags.arn}'`);
            }
            const mapped = mapServiceHarnessToSpec(response.harness);
            const { spec } = mapped;
            if (!response.harness.executionRoleArn) {
              throw new MalformedServiceResponseError(
                "GetHarness returned no executionRoleArn; source IAM capture is required for ARN export.",
              );
            }
            if (response.harness.arn && response.harness.arn !== flags.arn) {
              throw new MalformedServiceResponseError(
                "GetHarness returned a different source ARN.",
              );
            }
            yield { type: "step" as const, message: "Reading source execution-role policies" };
            const executionRoleSource = await config.core.executionRoleSource.read(
              response.harness.executionRoleArn,
              { ...coreOpts, region },
            );
            const projectName = project
              ? undefined
              : (flags["project-name"] ?? defaultExportProjectName(spec.name));
            input = {
              projectName,
              prefetched: {
                ...mapped,
                sourceArn: flags.arn,
                executionRoleSource,
              },
              targetAgentName: resolveTargetAgentName(
                flags["target-agent-name"],
                spec.name,
                projectName,
              ),
            };
          } else {
            input = {
              harnessName: flags.name!,
              targetAgentName: resolveTargetAgentName(flags["target-agent-name"], flags.name!),
            };
          }
          return yield* config.projectManager.exportHarness(project, input);
        })(),
        {
          io: config.io,
          interactive: jsonOutput ? false : undefined,
        },
      );

      if (jsonOutput) {
        ctx.require(JsonRendererKey).renderJson({
          harnessName: result.harnessName,
          agentName: result.agentName,
          agentPath: result.agentPath,
          notesPath: result.notesPath,
          notes: result.notes,
        });
        return;
      }

      const agentPath = relative(process.cwd(), result.agentPath);
      config.io.stderr.write(
        `Exported harness '${result.harnessName}' to runtime agent '${result.agentName}' (${agentPath})\n`,
      );
      const reviewNotes =
        result.notes.length > 0
          ? ` (${result.notes.length} manual follow-up${result.notes.length === 1 ? "" : "s"} in EXPORT_NOTES.md)`
          : "";
      const changeDirectory = project
        ? ""
        : `  cd ${relative(process.cwd(), dirname(dirname(result.agentPath)))}\n`;
      config.io.stderr.write(
        `Next steps:\n  Review the generated code in ${agentPath}${reviewNotes}\n${changeDirectory}  agentcore build\n  agentcore deploy\n`,
      );
    },
  });

/** Default the target agent name to `<harnessName>Agent` and validate it. */
function resolveTargetAgentName(
  flagValue: string | undefined,
  harnessName: string,
  projectName?: string,
): string {
  // New projects deploy under <project>_default_<agent>, whose physical name is capped at 48.
  const budget = projectName ? 48 - projectName.length - DEFAULT_TARGET_NAME.length - 2 : 48;
  const targetAgentName = flagValue ?? `${harnessName.slice(0, budget - "Agent".length)}Agent`;
  const parsed = AgentNameSchema.safeParse(targetAgentName);
  if (!parsed.success) {
    throw new InputValidationError(
      `invalid --target-agent-name "${targetAgentName}": ${parsed.error.issues[0]?.message ?? "invalid name"}`,
    );
  }
  if (targetAgentName.length > budget) {
    throw new InputValidationError(
      `--target-agent-name "${targetAgentName}" must fit within ${budget} characters for project "${projectName}"`,
    );
  }
  return parsed.data;
}
