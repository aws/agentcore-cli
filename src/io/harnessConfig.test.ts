import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { HarnessConfigReader } from "./harnessConfig";
import { HarnessConfigReader as CdkHarnessConfigReader } from "../assets/cdk/io/harnessConfig";
import { HarnessSpecSchema } from "../projectSchemas/harness";

const roots: string[] = [];
const originalCwd = process.cwd();
const model = { provider: "bedrock", modelId: "example" };

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(config: unknown) {
  const root = await mkdtemp(join(tmpdir(), "harness-yaml-reader-"));
  roots.push(root);
  const directory = join(root, "nested harness");
  await mkdir(directory);
  const path = join(directory, "harness.yaml");
  await writeFile(
    path,
    typeof config === "string"
      ? config
      : stringify({ name: "assistant", model, ...(config as object) }),
  );
  return { root, directory, path };
}

for (const [label, Reader] of [
  ["CLI", HarnessConfigReader],
  ["generated CDK", CdkHarnessConfigReader],
] as const) {
  describe(`${label} harness YAML reader`, () => {
    test.skipIf(process.platform === "win32").each(["system", "summary", "fallback"] as const)(
      "rejects a FIFO %s prompt in a bounded subprocess",
      async (field) => {
        const { directory, path } = await fixture(
          field === "system"
            ? { systemPrompt: "file://./pipe" }
            : field === "summary"
              ? {
                  truncation: {
                    strategy: "summarization",
                    config: { summarization: { summarizationSystemPrompt: "file://./pipe" } },
                  },
                }
              : {},
        );
        const fifo = join(directory, field === "fallback" ? "system-prompt.md" : "pipe");
        const setup = spawnSync("mkfifo", [fifo], { timeout: 2000, encoding: "utf8" });
        expect(setup.error).toBeUndefined();
        expect(setup.status).toBe(0);
        const readerPath = fileURLToPath(
          new URL(
            label === "CLI" ? "./harnessConfig.ts" : "../assets/cdk/io/harnessConfig.ts",
            import.meta.url,
          ),
        );
        const result = spawnSync(
          process.execPath,
          [
            "--eval",
            `
          import { HarnessConfigReader } from ${JSON.stringify(readerPath)};
          try {
            await new HarnessConfigReader().read(${JSON.stringify(path)});
            process.exitCode = 2;
          } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
          }
        `,
          ],
          { timeout: 2000, killSignal: "SIGKILL", encoding: "utf8" },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("not a regular prompt file");
        expect(result.stderr).toContain(fifo);
      },
    );

    test.each(["system", "summary"] as const)(
      "resolves only the %s prompt field from a YAML-relative path",
      async (field) => {
        const reference = "file://../chosen #100%.md";
        const config =
          field === "system"
            ? { systemPrompt: reference }
            : {
                truncation: {
                  strategy: "summarization",
                  config: { summarization: { summarizationSystemPrompt: reference } },
                },
              };
        const { root, path } = await fixture({
          ...config,
          skills: [{ path: "file://./runtime-only" }],
          environmentVariables: { PROMPT: "file://./not-an-include" },
          model: {
            provider: "lite_llm",
            modelId: "test",
            additionalParams: { systemPrompt: "file://./not-an-include" },
          },
        });
        const text = "  Literal contents: # 100%\r\nfile://./not-a-recursive-include\n";
        await writeFile(join(root, "chosen #100%.md"), text);
        process.chdir(root);
        const before = await readFile(path, "utf8");
        const data = HarnessSpecSchema.parse(await new Reader().read(path));
        expect(
          field === "system"
            ? data.systemPrompt
            : data.truncation?.config &&
                "summarization" in data.truncation.config &&
                data.truncation.config.summarization.summarizationSystemPrompt,
        ).toBe(text);
        expect(data.skills).toEqual([{ path: "file://./runtime-only" }]);
        expect(data.environmentVariables?.PROMPT).toBe("file://./not-an-include");
        expect(data.model.additionalParams?.systemPrompt).toBe("file://./not-an-include");
        expect(await readFile(path, "utf8")).toBe(before);
      },
    );

    test.each(["system", "summary", "fallback"] as const)(
      "preserves the UTF-8 BOM and CRLF in the %s prompt",
      async (field) => {
        const { directory, path } = await fixture(
          field === "system"
            ? { systemPrompt: "file://./prompt.md" }
            : field === "summary"
              ? {
                  truncation: {
                    strategy: "summarization",
                    config: { summarization: { summarizationSystemPrompt: "file://./prompt.md" } },
                  },
                }
              : {},
        );
        await writeFile(
          join(directory, field === "fallback" ? "system-prompt.md" : "prompt.md"),
          "\uFEFFHi\r\n",
        );
        const data = HarnessSpecSchema.parse(await new Reader().read(path));
        expect(
          field === "summary"
            ? data.truncation?.config &&
                "summarization" in data.truncation.config &&
                data.truncation.config.summarization.summarizationSystemPrompt
            : data.systemPrompt,
        ).toBe("\uFEFFHi\r\n");
      },
    );

    test("preserves inline prompts, including whitespace and YAML-special characters", async () => {
      const literal = '  "hello": #yes\n[one, two] * & %\n';
      const { directory, path } = await fixture({
        systemPrompt: literal,
        truncation: {
          strategy: "summarization",
          config: { summarization: { summarizationSystemPrompt: literal } },
        },
      });
      await mkdir(join(directory, "system-prompt.md"));
      const data = HarnessSpecSchema.parse(await new Reader().read(path));
      expect(data.systemPrompt).toBe(literal);
      expect(data.truncation?.config).toEqual({
        summarization: { summarizationSystemPrompt: literal },
      });
    });

    test.each(["./chosen.md", "../chosen.md", "absolute"] as const)(
      "supports the %s filesystem reference",
      async (source) => {
        const { directory, root, path } = await fixture({});
        const promptPath = join(source === "../chosen.md" ? root : directory, "chosen.md");
        await writeFile(promptPath, "Selected prompt.");
        await writeFile(join(directory, "system-prompt.md"), "Fallback loses.");
        await writeFile(
          path,
          stringify({
            name: "assistant",
            model,
            systemPrompt: `file://${source === "absolute" ? promptPath : source}`,
          }),
        );
        expect(HarnessSpecSchema.parse(await new Reader().read(path)).systemPrompt).toBe(
          "Selected prompt.",
        );
      },
    );

    test("uses the conventional prompt only when explicit text is absent, without defaulting memory", async () => {
      const { path, directory } = await fixture({});
      expect(HarnessSpecSchema.parse(await new Reader().read(path)).systemPrompt).toBeUndefined();
      await writeFile(join(directory, "system-prompt.md"), "  Conventional prompt.\n");
      const data = HarnessSpecSchema.parse(await new Reader().read(path));
      expect(data.systemPrompt).toBe("  Conventional prompt.\n");
      expect(data.memory).toBeUndefined();
    });

    test.each([
      ["malformed YAML", "name: [", /flow sequence|YAML/i],
      ["duplicate keys", "name: one\nname: two", /unique/],
      ["nested duplicate keys", "model:\n  provider: bedrock\n  provider: lite_llm\n", /unique/],
      ["multiple documents", "name: one\n---\nname: two", /multiple documents/i],
    ] as const)("reports %s with the source path", async (_label, yaml, message) => {
      const { path } = await fixture(yaml);
      await expect(new Reader().read(path)).rejects.toThrow(message);
      await expect(new Reader().read(path)).rejects.toThrow(path);
    });

    test.each([
      "",
      "null",
      "[]",
      "name: assistant\nmodel: false",
      "name: assistant\nmodel: {provider: bedrock, modelId: example}\nsystemPrompt: ''",
    ])("leaves invalid schema data to HarnessSpecSchema: %s", async (yaml) => {
      const { path } = await fixture(yaml);
      expect(HarnessSpecSchema.safeParse(await new Reader().read(path)).success).toBe(false);
    });

    test.each([
      "missing",
      "empty",
      "whitespace",
      "BOM-only",
      "directory",
      "oversized",
      "invalid UTF-8",
    ] as const)("rejects %s referenced files in both fields", async (condition) => {
      const { directory, path } = await fixture({});
      const promptPath = join(directory, "prompt.md");
      if (condition === "directory") await mkdir(promptPath);
      else if (condition !== "missing")
        await writeFile(
          promptPath,
          condition === "oversized"
            ? "x".repeat(1024 * 1024 + 1)
            : condition === "invalid UTF-8"
              ? Buffer.from([0xff])
              : condition === "whitespace"
                ? " \r\n\t"
                : condition === "BOM-only"
                  ? "\uFEFF"
                  : "",
        );
      for (const config of [
        { systemPrompt: "file://./prompt.md" },
        {
          truncation: {
            strategy: "summarization",
            config: { summarization: { summarizationSystemPrompt: "file://./prompt.md" } },
          },
        },
      ]) {
        await writeFile(path, stringify({ name: "assistant", model, ...config }));
        await expect(new Reader().read(path)).rejects.toThrow();
        await expect(new Reader().read(path)).rejects.toThrow(path);
      }
    });

    test("accepts exactly 1 MiB and rejects an empty conventional file", async () => {
      const { directory, path } = await fixture({});
      const promptPath = join(directory, "system-prompt.md");
      const text = "x".repeat(1024 * 1024);
      await writeFile(promptPath, text);
      expect(HarnessSpecSchema.parse(await new Reader().read(path)).systemPrompt).toBe(text);
      await writeFile(promptPath, "");
      await expect(new Reader().read(path)).rejects.toThrow(/empty/);
    });

    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "reports unreadable referenced files",
      async () => {
        const { directory, path } = await fixture({ systemPrompt: "file://./locked.md" });
        const promptPath = join(directory, "locked.md");
        await writeFile(promptPath, "Private prompt.");
        await chmod(promptPath, 0);
        try {
          await expect(new Reader().read(path)).rejects.toThrow(
            /cannot read prompt file.*locked.md/,
          );
        } finally {
          await chmod(promptPath, 0o600);
        }
      },
    );

    test("does not read misplaced prompt keys or overwrite shared YAML aliases", async () => {
      const { path, directory } = await fixture(
        "name: assistant\nmodel: {provider: bedrock, modelId: test}\nsummarizationSystemPrompt: file://./missing\ntruncation:\n  strategy: summarization\n  config:\n    summarization: &summary\n      summarizationSystemPrompt: file://./prompt.md\nother: *summary\n",
      );
      await writeFile(join(directory, "prompt.md"), "Summary text.");
      const data = (await new Reader().read(path)) as Record<string, unknown>;
      expect(data.summarizationSystemPrompt).toBe("file://./missing");
      expect(data.other).toEqual({ summarizationSystemPrompt: "file://./prompt.md" });
    });

    test.each([false, true])("reports missing YAML with nearby JSON=%s", async (nearbyJson) => {
      const { directory, path } = await fixture({});
      await rm(path);
      const json = join(directory, "harness.json");
      if (nearbyJson) await writeFile(json, "not valid JSON");
      const error = await new Reader().read(path).catch((error: Error) => error);
      expect(error).toMatchObject({ cause: expect.objectContaining({ code: "ENOENT", path }) });
      expect((error as Error).message).toContain("harness.yaml");
      expect((error as Error).message).not.toContain("harness.json");
      if (nearbyJson) expect(await readFile(json, "utf8")).toBe("not valid JSON");
    });

    test("does not fall back after an explicit reference fails", async () => {
      const { directory, path } = await fixture({ systemPrompt: "file://" });
      await writeFile(join(directory, "system-prompt.md"), "Fallback cannot hide this error.");
      await expect(new Reader().read(path)).rejects.toThrow(/requires a path/);
      await writeFile(
        path,
        stringify({ name: "assistant", model, systemPrompt: "file://./missing.md" }),
      );
      await expect(new Reader().read(path)).rejects.toThrow(/missing.md/);
    });
  });
}
