import z from "zod";
import { InputValidationError } from "../../../errors";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { JsonKey } from "../../keys";
import { AgentNameSchema, BuildTypeSchema } from "../../../projectSchemas/runtime";
import { formatExportNotes } from "../../../core/project/templates/export";
import { coreOptsFromCtx } from "../../utils";
import type { ExportHarnessInput } from "../types";
import type { ExportProjectResourceConfig } from "./types";
import { harnessIdFromArn, mapServiceHarnessToSpec, regionFromHarnessArn } from "./serviceHarness";

export const createExportHarnessHandler = (config: ExportProjectResourceConfig) =>
  createHandler({
    name: "harness",
    description: "convert a harness into an editable Strands runtime agent",
    flags: [
      flag("name", "the name of an in-project harness to export", z.string().optional()),
      flag(
        "arn",
        "the ARN of a deployed harness to fetch from the service and export",
        z.string().optional(),
      ),
      flag(
        "target-agent-name",
        "the name of the generated runtime agent (default: <harnessName>Agent)",
        z.string().optional(),
      ),
      flag(
        "build",
        "build type for the exported agent: CodeZip or Container",
        BuildTypeSchema.optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!!flags.name === !!flags.arn) {
        throw new InputValidationError(
          "specify exactly one of --name (in-project harness) or --arn (deployed harness)",
        );
      }

      // withProject has already resolved and validated the enclosing project —
      // before any service fetch, so a broken project fails fast.
      const project = ctx.require(ProjectKey);
      const jsonOutput = ctx.require(JsonKey);

      let input: ExportHarnessInput;
      if (flags.arn) {
        config.io.stderr.write(`Fetching harness from the service\n`);
        const harnessId = harnessIdFromArn(flags.arn);
        // The ARN names the region the harness lives in; fall back to the CLI's
        // resolved region only when the ARN carries none.
        const coreOpts = coreOptsFromCtx(ctx);
        const region = regionFromHarnessArn(flags.arn) ?? coreOpts.region;
        const response = await config.core.harness.getHarness(harnessId, { ...coreOpts, region });
        if (!response.harness) {
          throw new InputValidationError(`the service returned no harness for "${flags.arn}"`);
        }
        const { spec, systemPrompt } = mapServiceHarnessToSpec(response.harness);
        input = {
          prefetched: { spec, systemPrompt },
          targetAgentName: resolveTargetAgentName(flags["target-agent-name"], spec.name),
          build: flags.build,
        };
      } else {
        input = {
          harnessName: flags.name!,
          targetAgentName: resolveTargetAgentName(flags["target-agent-name"], flags.name!),
          build: flags.build,
        };
      }

      // Progress goes to stderr, keeping stdout for machine output. Driven by
      // hand because the result is the generator's return value.
      const exportRun = config.projectManager.exportHarness(project, input);
      let next = await exportRun.next();
      while (!next.done) {
        if (next.value.type === "step") config.io.stderr.write(`${next.value.message}\n`);
        next = await exportRun.next();
      }
      const result = next.value;

      config.io.stderr.write(
        `Exported harness '${result.harnessName}' to runtime agent '${result.agentName}' (${result.agentPath})\n`,
      );
      for (const line of formatExportNotes(result.notes, result.notesPath)) {
        config.io.stderr.write(`${line.text}\n`);
      }
      config.io.stderr.write(
        "Next steps: review the generated code, then `agentcore project build` and `agentcore project deploy`\n",
      );

      if (jsonOutput) {
        ctx.require(JsonRendererKey).renderJson({
          harnessName: result.harnessName,
          agentName: result.agentName,
          agentPath: result.agentPath,
          notesPath: result.notesPath,
          notes: result.notes,
        });
      }
    },
  });

/** Default the target agent name to `<harnessName>Agent` and validate it. */
function resolveTargetAgentName(flagValue: string | undefined, harnessName: string): string {
  const targetAgentName = flagValue ?? `${harnessName}Agent`;
  const parsed = AgentNameSchema.safeParse(targetAgentName);
  if (!parsed.success) {
    throw new InputValidationError(
      `invalid --target-agent-name "${targetAgentName}": ${parsed.error.issues[0]?.message ?? "invalid name"}`,
    );
  }
  return parsed.data;
}
