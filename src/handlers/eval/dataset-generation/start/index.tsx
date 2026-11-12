import type { TraceGenerationSource } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { SourceResolver, type AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonObjectFlag } from "../../../utils";
import { generationConfigHelp } from "../generationConfigHelp";
import { SCENARIO_TYPE_ALIASES, scenarioType } from "../scenarioTypes";

export const createStartDatasetGenerationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "start",
    description: "start an asynchronous generation into a dataset's DRAFT",
    flags: [
      flag("dataset-id", "the ID of the dataset to write examples into", z.string().min(1)),
      flag("name", "the name of the generation", z.string().min(1)),
      flag("description", "a description of the generation", z.string().optional()),
      // No CLI default: an absent flag sends no scenarioType, so the service's
      // default applies and stays the service's to change.
      flag(
        "scenario-type",
        `the kind of example every scenario becomes (${SCENARIO_TYPE_ALIASES.join(" | ")}); service defaults to dynamic when omitted`,
        z.enum(SCENARIO_TYPE_ALIASES).optional(),
      ),
      flag(
        "generation-config",
        "where traces are read from and which become examples (JSON inline, file://<path>, or - for stdin)",
        z.string().min(1),
        { sensitive: true, help: generationConfigHelp },
      ),
    ],
    handle: async (ctx, flags) => {
      const source = new SourceResolver({ stdin: io.stdin });
      const traceGeneration = parseJsonObjectFlag<TraceGenerationSource>(
        "generation-config",
        await source.resolveText("generation-config", flags["generation-config"]),
      );
      const alias = flags["scenario-type"];

      const response = await core.eval.startDatasetGeneration(
        {
          datasetId: flags["dataset-id"],
          name: flags["name"],
          description: flags["description"],
          scenarioType: alias === undefined ? undefined : scenarioType(alias),
          source: { traceGeneration },
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
