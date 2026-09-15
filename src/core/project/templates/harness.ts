import { existsSync } from "node:fs";
import { ZodError, z } from "zod";
import { HarnessSpecSchema } from "../../../projectSchemas/harness";
import { HarnessAuthoringSchema } from "../../../projectSchemas/harness-authoring";
import { FsTreeNode } from "./fsTree";
import { InputValidationError, ResourceNotFoundError } from "../../../errors/errors";
import type { TemplateResolver } from "./types";
import { HarnessYamlRenderer } from "./harnessYaml";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant";

/** Given a harness spec, resolve the {@link TemplateResolver} that renders its config directory **/
export function getHarnessTemplateResolver(): TemplateResolver<z.input<typeof HarnessSpecSchema>> {
  return {
    async resolve(spec) {
      validateHarnessTemplateSource(spec);

      const parsed = parseHarnessSpec({
        ...spec,
        memory: spec.memory === undefined ? { mode: "managed" } : spec.memory,
        dockerfile: spec.dockerfile ? "Dockerfile" : undefined,
      });
      const systemPrompt = parsed.systemPrompt;
      const promptReference = systemPrompt?.startsWith("file://")
        ? systemPrompt
        : "file://./system-prompt.md";

      const tree = FsTreeNode.createDirectory(parsed.name, [
        FsTreeNode.createFile("harness.yaml", async () =>
          new HarnessYamlRenderer().render({ ...parsed, systemPrompt: promptReference }),
        ),
        FsTreeNode.createFile("system-prompt.md", async () =>
          systemPrompt?.startsWith("file://")
            ? DEFAULT_SYSTEM_PROMPT
            : (systemPrompt ?? DEFAULT_SYSTEM_PROMPT),
        ),
        ...(spec.dockerfile ? [FsTreeNode.fromTextFile("Dockerfile", spec.dockerfile)] : []),
      ]);

      return {
        tree,
        spec: {
          harnesses: [{ name: parsed.name, path: `app/${parsed.name}` }],
        },
      };
    },
  };
}

export function validateHarnessTemplateSource(spec: z.input<typeof HarnessSpecSchema>): void {
  if (spec.dockerfile && !existsSync(spec.dockerfile)) {
    throw new ResourceNotFoundError(`no dockerfile exists at ${spec.dockerfile}`);
  }
}

function parseHarnessSpec(spec: z.input<typeof HarnessSpecSchema>) {
  try {
    return HarnessAuthoringSchema.parse(spec);
  } catch (err) {
    if (err instanceof ZodError) throw new InputValidationError(z.prettifyError(err));
    throw err;
  }
}
