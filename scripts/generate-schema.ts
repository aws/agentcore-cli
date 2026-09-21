import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import { z } from "zod";
import { ProjectSpecSchema } from "../src/projectSchemas/project";

const outputPath = resolve(import.meta.dir, "../schemas/agentcore.schema.v2.json");
const schema = z.toJSONSchema(ProjectSpecSchema, { target: "draft-07", io: "input" });
await Bun.write(
  outputPath,
  await format(JSON.stringify(schema), {
    ...(await resolveConfig(outputPath)),
    filepath: outputPath,
  }),
);
