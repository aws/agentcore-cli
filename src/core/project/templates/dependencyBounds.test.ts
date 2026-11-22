import { expect, test } from "bun:test";
import { MODEL_PROVIDERS } from "../../../projectSchemas/runtime";
import { FsAssetSource } from "../source";
import { HandlebarsTemplateRenderer } from "./renderer";

const source = new FsAssetSource();
const renderer = new HandlebarsTemplateRenderer();

const PYTHON_UPPER_BOUND = /~=|==|</;
const NPM_PINNED = /^~?\d+\.\d+\.\d+$/;

function pythonRequirementSpec(requirement: string): string {
  return requirement.replace(/^[A-Za-z0-9._-]+(\[[^\]]*\])?/, "").trim();
}

async function dependencyFiles(): Promise<string[]> {
  const dirs = await Promise.all(["cdk", "evaluators", "templates"].map((dir) => source.list(dir)));
  return dirs
    .flat()
    .filter((path) => /(^|\/)(pyproject\.toml|package\.json(\.template)?)$/.test(path));
}

function unboundedDependencies(path: string, rendered: string): string[] {
  if (path.endsWith("pyproject.toml")) {
    const pyproject = Bun.TOML.parse(rendered) as {
      project?: { dependencies?: string[] };
      "dependency-groups"?: Record<string, string[]>;
    };
    const requirements = [
      ...(pyproject.project?.dependencies ?? []),
      ...Object.values(pyproject["dependency-groups"] ?? {}).flat(),
    ];
    return requirements
      .filter((requirement) => !PYTHON_UPPER_BOUND.test(pythonRequirementSpec(requirement)))
      .map((requirement) => `${path}: ${requirement}`);
  }

  const manifest = JSON.parse(rendered) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, spec]) => !NPM_PINNED.test(spec))
    .map(([name, spec]) => `${path}: ${name}@${spec}`);
}

// Generated projects resolve dependencies at install time, so an unbounded range picks up breaking releases.
test("every vended dependency has an upper bound", async () => {
  const files = await dependencyFiles();
  expect(files.length).toBeGreaterThan(0);

  const offenders = new Set<string>();
  for (const path of files) {
    const template = await source.read(path);
    for (const modelProvider of MODEL_PROVIDERS) {
      const rendered = renderer.render(template, {
        name: "test_agent",
        modelProvider,
        strandsExtras: "anthropic",
        bedrockMantle: true,
      });
      for (const offender of unboundedDependencies(path, rendered)) offenders.add(offender);
    }
  }

  expect([...offenders]).toEqual([]);
});
