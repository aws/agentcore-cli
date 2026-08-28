import { existsSync } from "node:fs";
import { ZodError, z } from "zod";
import { HarnessSpecSchema } from "../../../projectSchemas/harness";
import { FsTreeNode } from "./fsTree";
import { InputValidationError } from "../../../errors/errors";
import type { TemplateResolver } from "./types";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Given a harness spec, resolve the {@link TemplateResolver} that renders its config directory **/
export function getHarnessTemplateResolver(): TemplateResolver<z.input<typeof HarnessSpecSchema>> {
  return {
    async resolve(spec) {
      if (spec.dockerfile && !existsSync(spec.dockerfile)) {
        throw new InputValidationError(`dockerfile not found: '${spec.dockerfile}'`);
      }

      // strip system prompt from harness.json to keep file as source of truth. otherwise harness.json system prompt overrides.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { systemPrompt, ...rest } = spec;
      const parsed = parseHarnessSpec({
        ...rest,
        dockerfile: spec.dockerfile ? "Dockerfile" : undefined,
      });

      const tree = FsTreeNode.createDirectory(parsed.name, [
        FsTreeNode.createFile("harness.json", async () => json(parsed)),
        FsTreeNode.createFile(
          "system-prompt.md",
          async () => systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
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

function parseHarnessSpec(spec: z.input<typeof HarnessSpecSchema>) {
  try {
    return HarnessSpecSchema.parse(spec);
  } catch (err) {
    if (err instanceof ZodError) throw new InputValidationError(z.prettifyError(err));
    throw err;
  }
}
